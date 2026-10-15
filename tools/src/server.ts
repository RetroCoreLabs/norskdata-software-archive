/**
 * Express backend for the Norsk Data Software Archive web UI.
 * Serves REST API endpoints and a vanilla HTML/JS frontend.
 */

import express from 'express';
import { pageAlign } from './lib/ndfsalign/index.js';
import { tryRecoverDamaged, type DamagedAssessment } from './api/damaged.js';
import multer from 'multer';
import { readFile, readdir, stat, writeFile, rename, copyFile, rm } from 'fs/promises';
import { join, resolve, extname, basename, sep } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { loadCatalog, loadProducts, saveProducts, saveProductYaml, saveFloppyYaml, generateCatalogJson, persistCatalog, findByVolumeName, findByMd5 } from './api/catalog.js';
import { importImage } from './api/import.js';
import { importFolder, findImageFolders } from './api/import-folder.js';
import { writeIndex } from './api/index-builder.js';
import { buildStaticSite } from './api/static-site-builder.js';
import { parseVolumeName, matchDistribution } from './api/name-parser.js';
import type { Catalog, CatalogEntry, Product } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Root of the repository (two levels up from tools/dist/)
const ROOT_DIR = resolve(__dirname, '..', '..');

/** Convert new Product[] format to legacy { Id, Name } format for server use */
function toLegacyProducts(products: Product[]): Array<{ Id: string; Name: string }> {
  return products.map(p => ({ Id: p.id, Name: p.name }));
}

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// Middleware
app.use(express.json({ limit: '50mb' }));

// Auto-rebuild the search index + static site after ANY successful mutation to
// catalog/product/photo data. A single debounced rebuild at the server covers
// every assignment / edit / import path, so no UI handler ever has to remember
// to trigger one (that was unreliable -- it depended on the client running the
// latest JS and on covering each path). GET/HEAD and the rebuild endpoints
// themselves are excluded.
const SITE_AFFECTING_ROUTE = /^\/api\/(match|products|floppy|floppies|tags|import|images|categories)\b/;
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (!SITE_AFFECTING_ROUTE.test(req.path)) return next();
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) scheduleSiteRebuild();
  });
  next();
});

// Multer for file uploads - store in temp dir
const upload = multer({ dest: '/tmp/ndarchive-uploads/' });

// In-memory catalog and products cache - loaded from YAML on startup
let catalog: Catalog | null = null;
let productsCache: Array<{ Id: string; Name: string }> | null = null;

/** Newest mtime seen across the YAML sources when the cache was filled. */
let catalogStamp = 0;

/**
 * Newest mtime across everything the catalog is built from: the per-floppy
 * YAML, the product YAML, the categories file and the collections group files.
 * A directory's own mtime changes when a file is added or removed, so scanning
 * the image folders (not every file inside them) catches new and deleted
 * floppies as well as edits.
 */
async function catalogSourceMtime(): Promise<number> {
  let newest = 0;
  const bump = async (p: string) => {
    try { newest = Math.max(newest, (await stat(p)).mtimeMs); } catch { /* gone */ }
  };
  const scanDir = async (dir: string, eachEntry: (full: string) => Promise<void>) => {
    try {
      await bump(dir);
      for (const name of await readdir(dir)) await eachEntry(join(dir, name));
    } catch { /* directory may not exist */ }
  };

  await scanDir(join(ROOT_DIR, 'images'), async full => {
    await bump(full);                                   // folder mtime = a file was added/removed
    try {
      for (const f of await readdir(full)) if (f.endsWith('.yaml')) await bump(join(full, f));
    } catch { /* not a directory */ }
  });
  await scanDir(join(ROOT_DIR, 'products'), bump);
  await scanDir(join(ROOT_DIR, 'collections'), async full => {
    await bump(full);
    await bump(join(full, 'group.yaml'));
  });
  await bump(join(ROOT_DIR, 'categories/product-categories.yaml'));
  return newest;
}

/**
 * The catalog is cached in memory, and the server's own write paths clear it.
 * But the YAML is the source of truth and gets edited from outside too - by
 * hand, by the import-* CLI, by a script, or by switching git branch - and
 * none of that goes through this process. Without the mtime check the Matcher
 * happily lists floppies that were assigned on disk minutes ago.
 */
async function getCatalog(): Promise<Catalog> {
  const stamp = await catalogSourceMtime();
  if (!catalog || stamp > catalogStamp) {
    catalog = await loadCatalog(ROOT_DIR);
    catalogStamp = stamp;
  }
  return catalog;
}

/**
 * Which Matcher queue an entry belongs to. The dashboard piles and the queue
 * endpoint both use this - they used to carry separate copies of the rule and
 * drifted apart, so the dashboard reported 349 "needs review" and 0 "bad reads"
 * while the queue itself reported 179 and 171.
 */
/**
 * The name a disk is identified by. NDFS floppies carry a volume name; MS-DOS
 * disks carry a FAT volume label, and on the ND-OWS / NORTEXT PC media those
 * labels are ND part numbers (30002EN1A00, 30022XX2N06), so they match exactly
 * the same way.
 */
function identifyingName(e: CatalogEntry): string {
  return e.volumeName ?? e.volumeLabel ?? '';
}

type QueueKind = 'linked' | 'reviewed' | 'auto' | 'new' | 'manual' | 'broken';

/**
 * File names listed by other reads of the same physical floppy.
 *
 * Reads of one disk are named ND-disk-00302, ND-disk-00302b, ND-disk-00302c and
 * so on, so the trailing letter is what separates them. A read that lost part of
 * its own text can still be checked against what its siblings listed.
 */
function siblingFileNames(entries: CatalogEntry[], entry: CatalogEntry): string[] {
  const baseOf = (e: CatalogEntry) => (e.storage?.git?.imagePath?.split('/').pop() ?? '')
    .replace(/\.img\.gz$/, '')
    .replace(/([0-9]{3,6})[a-z]$/, '$1')
    .replace(/-track\d+.*$/, '');
  const mine = baseOf(entry);
  if (!mine) return [];
  const names = new Set<string>();
  for (const other of entries) {
    if (other.id === entry.id || baseOf(other) !== mine) continue;
    for (const f of other.ndfs?.files ?? []) names.add(f.name);
  }
  return [...names];
}

function classifyForQueue(
  e: CatalogEntry,
  hasProduct: (productId: string) => boolean,
): QueueKind {
  if (e.productId) return 'linked';
  if (e.tags?.includes('reviewed-unassigned')) return 'reviewed';

  // A parseable name decides first, whatever filesystem the image holds. An
  // MS-DOS disk labelled 30022XX2N06 is as identifiable as an NDFS floppy - it
  // belongs in the matching queues, not among the unreadable ones.
  const parsed = parseVolumeName(identifyingName(e));
  if (parsed) return hasProduct(parsed.productId) ? 'auto' : 'new';

  if (e.tags?.includes('hidden-in-legacy') ?? false) return 'broken';
  // Recorded as the ND floppy it is, but nothing can be read off it, so there is
  // no name to match on: it belongs with the unreadable ones, not in manual.
  if (e.condition?.status === 'damaged') return 'broken';

  // Nothing to match on. Where it goes depends on whether the image holds
  // anything at all. Once detection has identified a filesystem - DOS, a backup
  // volume, a tar - the disk has contents and belongs in the review queue, not
  // among the unreadable ones, even though its name did not parse.
  if (e.filesystem) return e.filesystem === 'none' ? 'broken' : 'manual';

  // Not detected yet: fall back to what the import recorded.
  const noFilesystem = !e.volumeName && !(e.ndfs?.files?.length) && !(e.ndfs?.users?.length);
  return noFilesystem ? 'broken' : 'manual';
}

async function reloadCatalog(): Promise<Catalog> {
  catalog = await loadCatalog(ROOT_DIR);
  catalogStamp = await catalogSourceMtime();
  return catalog;
}

async function reloadAndRegenerate(): Promise<void> {
  catalog = await loadCatalog(ROOT_DIR);
  productsCache = null;
  await generateCatalogJson(ROOT_DIR);
}

// ============================================================
// Folder browser endpoint
// ============================================================

app.get('/api/browse', async (req, res) => {
  try {
    const requestedPath = String(req.query.path ?? '/');
    const absPath = resolve(requestedPath);

    // Safety: must exist and be a directory
    const st = await import('fs/promises').then(m => m.stat(absPath));
    if (!st.isDirectory()) {
      res.status(400).json({ error: 'Not a directory' });
      return;
    }

    const entries = await import('fs/promises').then(m => m.readdir(absPath, { withFileTypes: true }));

    const folders: string[] = [];
    let imgCount = 0;

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip hidden
      if (entry.isDirectory()) {
        folders.push(entry.name);
      } else if (entry.isFile() && /\.img$/i.test(entry.name)) {
        imgCount++;
      }
    }

    folders.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    // Compute parent
    const parent = absPath === '/' ? null : resolve(absPath, '..');

    res.json({
      path: absPath,
      parent,
      folders,
      imgCount,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Native folder picker (zenity/kdialog)
// ============================================================

app.get('/api/pick-folder', async (req, res) => {
  try {
    const startPath = String(req.query.start ?? '');
    const { execSync } = await import('child_process');

    // Try zenity first, then kdialog
    let cmd: string;
    try {
      execSync('which zenity', { stdio: 'pipe' });
      cmd = 'zenity --file-selection --directory' + (startPath ? ' --filename=' + JSON.stringify(startPath + '/') : '') + ' 2>/dev/null';
    } catch {
      try {
        execSync('which kdialog', { stdio: 'pipe' });
        cmd = 'kdialog --getexistingdirectory ' + (startPath ? JSON.stringify(startPath) : JSON.stringify('/'));
      } catch {
        res.status(501).json({ error: 'No dialog tool available (install zenity or kdialog)' });
        return;
      }
    }

    const result = execSync(cmd, { encoding: 'utf8', timeout: 120000 }).trim();
    if (result) {
      res.json({ path: result });
    } else {
      res.json({ path: null, cancelled: true });
    }
  } catch {
    // User cancelled the dialog (exit code 1) or timeout
    res.json({ path: null, cancelled: true });
  }
});

// Catalog endpoints
// ============================================================

app.get('/api/catalog', async (_req, res) => {
  try {
    const cat = await getCatalog();
    const summary = cat.entries.map(e => ({
      id: e.id,
      volumeName: e.volumeName,
      productId: e.productId,
      version: e.version,
      bootFormat: e.bootFormat,
      storageClass: e.storageClass,
      imageSizeBytes: e.imageSizeBytes,
      totalPages: e.totalPages,
      fileCount: e.ndfs?.files?.length ?? 0,
      importedAt: e.importedAt,
    }));
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/catalog/:id', async (req, res) => {
  try {
    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === req.params.id);
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    // Resolve product name with sibling fallback
    let productName: string | null = null;
    if (entry.productId) {
      const products = toLegacyProducts(await loadProducts(ROOT_DIR));
      const pMap = new Map(products.map(p => [p.Id, p.Name]));
      const n = pMap.get(entry.productId);
      if (n && n !== entry.productId) {
        productName = n;
      } else {
        const m2 = entry.productId.match(/^ND-(\d+)$/);
        if (m2) {
          const d = m2[1];
          const cands: string[] = [];
          if (d.length === 5 && d.startsWith('1')) cands.push(`ND-2${d}`);
          if (d.length === 6 && d.startsWith('21')) cands.push(`ND-${d.substring(1)}`);
          if (d.length === 6 && d.startsWith('2')) cands.push(`ND-${d.substring(1)}`);
          for (const c of cands) { const cn = pMap.get(c); if (cn && cn !== c) { productName = cn; break; } }
        }
      }
    }

    res.json({ ...entry, productName });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/products', async (_req, res) => {
  try {
    const cat = await getCatalog();
    const products = toLegacyProducts(await loadProducts(ROOT_DIR));
    const countMap = new Map<string, number>();
    for (const e of cat.entries) {
      const pid = e.productId ?? '(unmatched)';
      countMap.set(pid, (countMap.get(pid) ?? 0) + 1);
    }

    const productMap = new Map<string, string>();
    for (const p of products) {
      productMap.set(p.Id, p.Name);
    }

    // Sibling name resolution for unnamed products
    function resolveName(pid: string): string {
      const name = productMap.get(pid);
      if (name && name !== pid) return name;
      // Check sibling
      const m2 = pid.match(/^ND-(\d+)$/);
      if (m2) {
        const d = m2[1];
        const candidates: string[] = [];
        if (d.length === 5 && d.startsWith('1')) candidates.push(`ND-2${d}`);
        if (d.length === 6 && d.startsWith('21')) candidates.push(`ND-${d.substring(1)}`);
        if (d.length === 6 && d.startsWith('2')) candidates.push(`ND-${d.substring(1)}`);
        for (const c of candidates) {
          const cn = productMap.get(c);
          if (cn && cn !== c) return cn;
        }
      }
      return name ?? pid;
    }

    // Build lookups from raw product data
    const rawProducts = await loadProducts(ROOT_DIR);
    const categoryMap = new Map<string, string[]>();
    const platformMap = new Map<string, string[]>();
    const descriptionMap = new Map<string, string>();
    for (const rp of rawProducts) {
      if (rp.categories && rp.categories.length > 0) categoryMap.set(rp.id, rp.categories);
      if (rp.platform && rp.platform.length > 0) platformMap.set(rp.id, rp.platform);
      if (rp.description) descriptionMap.set(rp.id, rp.description);
    }

    // Start with all known products (even those with 0 images)
    const seen = new Set<string>();
    const result: Array<{ productId: string; name: string; description: string | null; imageCount: number; categories: string[]; platform: string[] }> = [];

    // Products from catalog (have images)
    for (const [id, count] of countMap) {
      seen.add(id);
      result.push({ productId: id, name: resolveName(id), description: descriptionMap.get(id) ?? null, imageCount: count, categories: categoryMap.get(id) ?? [], platform: platformMap.get(id) ?? [] });
    }

    // Products from YAML (may have 0 images)
    for (const p of products) {
      if (!seen.has(p.Id)) {
        result.push({ productId: p.Id, name: resolveName(p.Id), description: descriptionMap.get(p.Id) ?? null, imageCount: 0, categories: categoryMap.get(p.Id) ?? [], platform: platformMap.get(p.Id) ?? [] });
      }
    }

    result.sort((a, b) => b.imageCount - a.imageCount || a.productId.localeCompare(b.productId));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Product detail
app.get('/api/product-detail', async (req: express.Request, res: express.Response) => {
  try {
    const productId = String(req.query.id ?? '');
    if (!productId) { res.status(400).json({ error: 'Missing id parameter' }); return; }

    const cat = await getCatalog();
    const productsList = toLegacyProducts(await loadProducts(ROOT_DIR));
    const productMap = new Map(productsList.map(p => [p.Id, p.Name]));
    const product = productsList.find((p: { Id: string; Name: string }) => p.Id === productId);
    let productName = product ? product.Name : productId;

    // Sibling resolution: if name equals ID (unnamed) or missing, check old/new number counterpart
    let siblingId: string | null = null;
    let siblingName: string | null = null;
    const m = productId.match(/^ND-(\d+)$/);
    if (m) {
      const digits = m[1];
      const candidates: string[] = [];
      if (digits.length === 5 && digits.startsWith('1')) candidates.push(`ND-2${digits}`);
      if (digits.length === 6 && digits.startsWith('21')) candidates.push(`ND-${digits.substring(1)}`);
      if (digits.length === 6 && digits.startsWith('2')) candidates.push(`ND-${digits.substring(1)}`);
      for (const cand of candidates) {
        const candName = productMap.get(cand);
        if (candName && candName !== cand) {
          siblingId = cand;
          siblingName = candName;
          // If our product is unnamed, use the sibling name
          if (productName === productId || !product) {
            productName = candName;
          }
          break;
        }
      }
    }

    const floppies = cat.entries.filter((e: CatalogEntry) => e.productId === productId);
    if (floppies.length === 0 && !product) { res.status(404).json({ error: 'Product not found' }); return; }

    // Group by version, then by language
    interface DiskInfo { id: string; volumeName: string | null; volumeLabel: string | null; imagePath: string | null; diskNumber: number | null; bootFormat: string | null; totalPages: number | null; fileCount: number; storageClass: string | null; diskPhotos: string[]; setPhotos: string[]; hasLabelTranscription: boolean }
    // setPhotos keyed by filename: the same set photo is physically copied into
    // every disk's MD5 folder, so dedup by basename to show it once per version.
    const versionMap = new Map<string, { langMap: Map<string, DiskInfo[]>; setPhotos: Map<string, string>; labelTranscription: string | null }>();

    for (const e of floppies) {
      const ver = e.version ?? '(unknown)';
      const parsed = parseVolumeName(identifyingName(e));
      const lang = parsed?.language ?? 'XX';

      if (!versionMap.has(ver)) versionMap.set(ver, { langMap: new Map(), setPhotos: new Map(), labelTranscription: null });
      const verData = versionMap.get(ver)!;
      if (!verData.langMap.has(lang)) verData.langMap.set(lang, []);

      // Collect set photos at version level, deduped by filename (the same
      // photo is copied into each disk folder, so paths differ but names match)
      const sp = e.storage?.git?.setPhotos ?? [];
      for (const p of sp) { const bn = basename(p); if (!verData.setPhotos.has(bn)) verData.setPhotos.set(bn, p); }
      if (e.storage?.git?.labelTranscription && !verData.labelTranscription) {
        verData.labelTranscription = e.storage.git.labelTranscription;
      }

      verData.langMap.get(lang)!.push({
        id: e.id,
        volumeName: e.volumeName,
        // a DOS floppy is named by its FAT label, and one with neither name is
        // only known by the file the imaging produced
        volumeLabel: e.volumeLabel ?? null,
        imagePath: e.storage?.git?.imagePath ?? null,
        diskNumber: e.diskNumber,
        bootFormat: e.bootFormat,
        totalPages: e.totalPages,
        fileCount: e.ndfs?.files?.length ?? 0,
        storageClass: e.storageClass,
        diskPhotos: e.storage?.git?.diskPhotos ?? [],
        setPhotos: sp,
        hasLabelTranscription: !!e.storage?.git?.labelTranscription,
      });
    }

    const versions = Array.from(versionMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([version, verData]) => ({
        version,
        setPhotos: Array.from(verData.setPhotos.values()),
        labelTranscription: verData.labelTranscription,
        languages: Object.fromEntries(
          Array.from(verData.langMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))
        ),
      }));

    // Get categories for this product
    const rawProducts = await loadProducts(ROOT_DIR);
    const rawProduct = rawProducts.find(p => p.id === productId);
    const categories = rawProduct?.categories ?? [];

    const description = rawProduct?.description ?? null;
    const platform = rawProduct?.platform ?? [];
    res.json({ productId, productName, description, platform, siblingId, siblingName, totalImages: floppies.length, categories, versions });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q ?? '').toLowerCase().trim();
    const limit = parseInt(String(req.query.limit ?? '20'), 10);
    if (!q || q.length < 2) {
      res.json([]);
      return;
    }

    const cat = await getCatalog();
    const results: Array<{ entry: CatalogEntry; score: number }> = [];

    for (const e of cat.entries) {
      let score = 0;
      if (e.id.toLowerCase().includes(q)) score += 3;
      if (e.volumeName?.toLowerCase().includes(q)) score += 3;
      if (e.productId?.toLowerCase().includes(q)) score += 2;
      if (e.version?.toLowerCase().includes(q)) score += 1;
      if (e.bootFormat?.toLowerCase().includes(q)) score += 1;
      if (e.md5.toLowerCase().includes(q)) score += 2;
      if (e.tags) {
        for (const t of e.tags) {
          if (t.toLowerCase().includes(q)) score += 1;
        }
      }
      if (e.ndfs?.files) {
        for (const f of e.ndfs.files) {
          if (f.name.toLowerCase().includes(q)) { score += 1; break; }
        }
      }
      if (score > 0) results.push({ entry: e, score });
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit).map(r => r.entry);
    res.json(top);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    const cat = await getCatalog();
    const productsList = toLegacyProducts(await loadProducts(ROOT_DIR));
    const productMap = new Map<string, string>();
    for (const p of productsList) {
      productMap.set(p.Id, p.Name);
    }

    const productIds = new Set<string>();
    const byContributor: Record<string, number> = {};
    const byFileType: Record<string, number> = {};
    const byLang: Record<string, number> = {};
    const inferredProductCounts: Record<string, number> = {};
    let broken = 0;
    let assigned = 0;
    let unassigned = 0;

    // Match queue counters
    let queueAuto = 0;
    let queueNew = 0;
    let queueManual = 0;
    let queueBroken = 0;

    for (const e of cat.entries) {
      // Product tracking
      if (e.productId) {
        productIds.add(e.productId);
        assigned++;
        inferredProductCounts[e.productId] = (inferredProductCounts[e.productId] ?? 0) + 1;
      } else {
        unassigned++;
      }

      // Broken (hidden-in-legacy)
      if (e.tags?.includes('hidden-in-legacy')) {
        broken++;
      }

      // Contributor from provenance
      const contributor = e.provenance?.contributor ?? 'unknown';
      byContributor[contributor] = (byContributor[contributor] ?? 0) + 1;

      // File types from ndfs or directoryContentRaw
      if (e.ndfs?.files) {
        for (const f of e.ndfs.files) {
          if (f.type) {
            byFileType[f.type] = (byFileType[f.type] ?? 0) + 1;
          }
        }
      } else if (e.directoryContentRaw) {
        const typeMatches = e.directoryContentRaw.matchAll(/:(\w+)\s+Type:/g);
        for (const tm of typeMatches) {
          const ft = tm[1];
          byFileType[ft] = (byFileType[ft] ?? 0) + 1;
        }
      }

      // Language from volume name parsing
      const parsed = parseVolumeName(identifyingName(e));
      const lang = parsed?.language ?? 'unknown';
      byLang[lang] = (byLang[lang] ?? 0) + 1;

      // Match queue classification - same rule the queue endpoint uses
      switch (classifyForQueue(e, id => productMap.has(id))) {
        case 'auto':   queueAuto++;   break;
        case 'new':    queueNew++;    break;
        case 'manual': queueManual++; break;
        case 'broken': queueBroken++; break;
        default: break;   // linked / reviewed are not queued
      }
    }

    // Build byInferredProduct
    const byInferredProduct = Object.entries(inferredProductCounts)
      .map(([productId, count]) => ({
        productId,
        name: productMap.get(productId) ?? productId,
        count,
      }))
      .sort((a, b) => b.count - a.count);

    res.json({
      totalFloppies: cat.entries.length,
      totalProducts: productsList.length,
      broken,
      unassigned,
      assigned,
      byContributor,
      byInferredProduct,
      byFileType,
      byLang,
      matchQueue: {
        auto: queueAuto,
        new: queueNew,
        manual: queueManual,
        broken: queueBroken,
      },
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Floppies endpoint (paginated, filtered)
// ============================================================

app.get('/api/floppies', async (req, res) => {
  try {
    const cat = await getCatalog();
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 500);
    const offset = parseInt(String(req.query.offset ?? '0'), 10);
    const filterProductId = req.query.productId ? String(req.query.productId) : null;
    const filterStatus = req.query.status ? String(req.query.status) : null;
    const filterTag = req.query.tag ? String(req.query.tag) : null;
    const filterContributor = req.query.contributor ? String(req.query.contributor) : null;
    const filterQ = req.query.q ? String(req.query.q).trim().toLowerCase() : null;
    // Images with no ND filesystem - empty disks, failed reads, MS-DOS floppies,
    // tar archives - are hidden from the catalog by default. They have no volume
    // name and no file list, so they only pad the listing; ?filesystem=all shows
    // them, ?filesystem=dos|tar|none shows one kind.
    const filterFs = req.query.filesystem ? String(req.query.filesystem) : 'ndfs';

    let results = cat.entries;

    if (filterFs !== 'all') {
      results = filterFs === 'ndfs'
        // treat "not yet detected" as ND so nothing vanishes before a detect run
        ? results.filter(e => !e.filesystem || e.filesystem === 'ndfs')
        : results.filter(e => e.filesystem === filterFs);
    }
    if (filterProductId) {
      results = results.filter(e => e.productId === filterProductId);
    }
    if (filterStatus) {
      if (filterStatus === 'assigned') {
        results = results.filter(e => e.productId !== null);
      } else if (filterStatus === 'unassigned') {
        results = results.filter(e => e.productId === null);
      } else if (filterStatus === 'broken') {
        results = results.filter(e => e.tags?.includes('hidden-in-legacy'));
      }
    }
    if (filterTag) {
      results = results.filter(e => e.tags?.includes(filterTag));
    }
    if (filterContributor) {
      results = results.filter(e => e.provenance?.contributor === filterContributor);
    }
    if (filterQ) {
      // Resolve product names for searching
      const productsList2 = toLegacyProducts(await loadProducts(ROOT_DIR));
      const pMap2 = new Map(productsList2.map(p => [p.Id, p.Name.toLowerCase()]));

      results = results.filter(e => {
        if (e.id.toLowerCase().includes(filterQ)) return true;
        if (e.volumeName?.toLowerCase().includes(filterQ)) return true;
        if (e.volumeLabel?.toLowerCase().includes(filterQ)) return true;
        // the name the imaging gave it, e.g. ND-disk-00283
        if (e.storage?.git?.imagePath?.toLowerCase().includes(filterQ)) return true;
        if (e.provenance?.originalPath?.toLowerCase().includes(filterQ)) return true;
        if (e.productId?.toLowerCase().includes(filterQ)) return true;
        if (e.md5.toLowerCase().includes(filterQ)) return true;
        if (e.version?.toLowerCase().includes(filterQ)) return true;
        if (e.bootFormat?.toLowerCase().includes(filterQ)) return true;
        if (e.provenance?.contributor?.toLowerCase().includes(filterQ)) return true;
        if (e.tags?.some(t => t.toLowerCase().includes(filterQ))) return true;
        // Search product name
        if (e.productId && pMap2.get(e.productId)?.includes(filterQ)) return true;
        // Search file names, whatever filesystem holds them
        if (e.ndfs?.files?.some(f => f.name.toLowerCase().includes(filterQ))) return true;
        if (e.backupFiles?.some(f => f.name.toLowerCase().includes(filterQ))) return true;
        if (e.dosFiles?.some(f => f.path.toLowerCase().includes(filterQ))) return true;
        // Search directory content raw (legacy)
        if (e.directoryContentRaw?.toLowerCase().includes(filterQ)) return true;
        return false;
      });
    }

    const total = results.length;
    const page = results.slice(offset, offset + limit);

    // Resolve product names (with sibling fallback)
    const productsList = toLegacyProducts(await loadProducts(ROOT_DIR));
    const pMap = new Map(productsList.map(p => [p.Id, p.Name]));
    function resolveProdName(pid: string | null): string | null {
      if (!pid) return null;
      const n = pMap.get(pid);
      if (n && n !== pid) return n;
      const m2 = pid.match(/^ND-(\d+)$/);
      if (m2) {
        const d = m2[1];
        const cands: string[] = [];
        if (d.length === 5 && d.startsWith('1')) cands.push(`ND-2${d}`);
        if (d.length === 6 && d.startsWith('21')) cands.push(`ND-${d.substring(1)}`);
        if (d.length === 6 && d.startsWith('2')) cands.push(`ND-${d.substring(1)}`);
        for (const c of cands) { const cn = pMap.get(c); if (cn && cn !== c) return cn; }
      }
      return n ?? null;
    }

    res.json({
      total,
      limit,
      offset,
      entries: page.map(e => ({
        id: e.id,
        md5: e.md5,
        volumeName: e.volumeName,
        // A DOS floppy has no NDFS volume name; its FAT label is what names it.
        volumeLabel: e.volumeLabel ?? null,
        filesystem: e.filesystem ?? null,
        backupSet: e.backupSet ?? null,
        dosFiles: e.dosFiles ?? null,
        condition: e.condition ?? null,
        productId: e.productId,
        productName: resolveProdName(e.productId),
        version: e.version,
        diskNumber: e.diskNumber,
        bootFormat: e.bootFormat,
        totalPages: e.totalPages,
        fileCount: e.ndfs?.files?.length ?? 0,
        storageClass: e.storageClass,
        tags: e.tags,
        contributor: e.provenance?.contributor ?? 'unknown',
        importedAt: e.importedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Matcher API endpoints
// ============================================================

app.get('/api/match/queue', async (req, res) => {
  try {
    const cat = await getCatalog();
    const productsList = toLegacyProducts(await loadProducts(ROOT_DIR));
    const productMap = new Map<string, string>();
    for (const p of productsList) {
      productMap.set(p.Id, p.Name);
    }

    const mode = String(req.query.mode ?? 'auto');
    const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 500);
    const offset = parseInt(String(req.query.offset ?? '0'), 10);

    // Build sibling lookup: for any unknown ND-XXXXX, find if the old/new counterpart is known
    // ND-1xxxx (old) <-> ND-21xxxx (new) are the same product with different numbering
    function findSibling(unknownPid: string): { productId: string; name: string } | null {
      const m = unknownPid.match(/^ND-(\d+)$/);
      if (!m) return null;
      const digits = m[1];
      // Unknown is ND-1xxxx -> look for known ND-21xxxx
      if (digits.length === 5 && digits.startsWith('1')) {
        const sibling = `ND-2${digits}`;
        if (productMap.has(sibling)) return { productId: sibling, name: productMap.get(sibling)! };
      }
      // Unknown is ND-21xxxx -> look for known ND-1xxxx
      if (digits.length === 6 && digits.startsWith('21')) {
        const sibling = `ND-${digits.substring(1)}`;
        if (productMap.has(sibling)) return { productId: sibling, name: productMap.get(sibling)! };
      }
      // Unknown is ND-2xxxxx (6-digit starting with 2 but not 21) -> look for ND-xxxxx (5-digit)
      if (digits.length === 6 && digits.startsWith('2')) {
        const sibling = `ND-${digits.substring(1)}`;
        if (productMap.has(sibling)) return { productId: sibling, name: productMap.get(sibling)! };
      }
      return null;
    }

    const results: Array<{
      floppy: { id: string; volumeName: string | null; md5: string; status: string; ndfsFiles: string[]; sourceFolder: string | null; originalFilename: string | null };
      parsed: ReturnType<typeof parseVolumeName>;
      suggested: {
        productId: string | null;
        productName: string | null;
        confidence: number;
        isNew: boolean;
        siblingOf: string | null;
        alternates: string[];
      } | null;
    }> = [];

    for (const e of cat.entries) {
      // Skip entries already linked to a product (they're done)
      if (e.productId && mode !== 'broken') continue;
      // Skip entries tagged as reviewed/skipped
      if (e.tags?.includes('reviewed-unassigned') && mode !== 'broken') continue;

      const parsed = parseVolumeName(identifyingName(e));
      const entryMode = classifyForQueue(e, id => productMap.has(id));
      if (entryMode !== mode) continue;

      // Extract NDFS file names for display (from parsed ndfs or directoryContentRaw)
      let ndfsFiles: string[] = [];
      if (e.ndfs?.files) {
        ndfsFiles = e.ndfs.files.map(f => f.name).slice(0, 10);
      } else if (e.directoryContentRaw) {
        const matches = e.directoryContentRaw.match(/\)([A-Z0-9_-]+:[A-Z0-9]+)/g);
        if (matches) ndfsFiles = matches.map(m => m.substring(1)).slice(0, 10);
      }

      let suggested: typeof results[0]['suggested'] = null;
      if (parsed) {
        const isNew = !productMap.has(parsed.productId);
        let siblingOf: string | null = null;
        let suggestedName = productMap.get(parsed.productId) ?? null;

        // For new products, check if there's a sibling (old/new number for same product)
        if (isNew) {
          const sib = findSibling(parsed.productId);
          if (sib) {
            siblingOf = sib.productId;
            suggestedName = sib.name;
          }
        }

        suggested = {
          productId: parsed.productId,
          productName: suggestedName,
          confidence: parsed.confidence,
          isNew,
          siblingOf,
          alternates: [],
        };
      } else if (mode === 'manual' && e.directoryContentRaw) {
        const fileNames = e.directoryContentRaw.match(/\)\s*([^:]+:[A-Z]+)/g);
        if (fileNames) {
          for (const [pid, pname] of productMap) {
            const pnLower = pname.toLowerCase();
            for (const fn of fileNames) {
              if (fn.toLowerCase().includes(pnLower.split(' ')[0]?.toLowerCase() ?? '')) {
                suggested = {
                  productId: pid,
                  productName: pname,
                  confidence: 0.3,
                  isNew: false,
                  siblingOf: null,
                  alternates: [],
                };
                break;
              }
            }
            if (suggested) break;
          }
        }
      }

      const status = e.productId ? 'assigned' : (entryMode === 'broken' ? 'broken' : 'unassigned');

      results.push({
        floppy: {
          id: e.id,
          volumeName: e.volumeName,
          md5: e.md5,
          status,
          ndfsFiles,
          sourceFolder: e.provenance?.originalPath ? e.provenance.originalPath.replace(/\/[^/]+$/, '').replace(/.*\//, '') : null,
          originalFilename: e.provenance?.originalPath ? e.provenance.originalPath.replace(/.*\//, '') : null,
        },
        parsed,
        suggested,
      });
    }

    // Sort before paging. Without this the queue came back in catalog order and
    // was then sliced into pages, so the UI - which groups by source folder -
    // showed one folder split across several pages, and the folders themselves
    // in no order. Sort by folder (numerically, so 100 comes before 200 and not
    // after 1000), then by file name within the folder.
    results.sort((a, b) => {
      const fa = a.floppy.sourceFolder ?? '', fb = b.floppy.sourceFolder ?? '';
      if (fa !== fb) return fa.localeCompare(fb, undefined, { numeric: true, sensitivity: 'base' });
      const na = String(a.floppy.originalFilename ?? a.floppy.volumeName ?? a.floppy.id);
      const nb = String(b.floppy.originalFilename ?? b.floppy.volumeName ?? b.floppy.id);
      return na.localeCompare(nb, undefined, { numeric: true, sensitivity: 'base' });
    });

    const total = results.length;
    const page = results.slice(offset, offset + limit);

    res.json({ total, limit, offset, entries: page });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

type MatchTarget = { productId?: string; newProduct?: { id: string; name: string } };
type MatchOverrides = { version?: string; language?: string; diskNumber?: number };
type MatchGroup = { floppyIds: string[]; target: MatchTarget; overrides?: MatchOverrides };

app.post('/api/match/confirm', async (req, res) => {
  try {
    const body = req.body as {
      floppyIds?: string[];
      target?: MatchTarget;
      overrides?: MatchOverrides;
      /** Batch form: several product groups confirmed in ONE request. */
      groups?: MatchGroup[];
    };

    // Confirming a "Select all" of 16 floppies used to be one request per
    // product, each doing a full persistCatalog (1.6 s on 296 entries) and each
    // re-arming the site rebuild. Accepting all groups at once means one
    // persist and one rebuild for the whole selection.
    const groups: MatchGroup[] = body.groups?.length
      ? body.groups
      : (body.floppyIds?.length && body.target
          ? [{ floppyIds: body.floppyIds, target: body.target, overrides: body.overrides }]
          : []);

    if (!groups.length) {
      res.status(400).json({ error: 'floppyIds and target (or groups) are required' });
      return;
    }

    const cat = await getCatalog();

    // If creating a new product, add it first
    let productId: string;
    let updated = 0;
    let createdProducts = 0;
    const productIds: string[] = [];

    for (const g of groups) {
      let productId: string;
      if (g.target.newProduct) {
        await saveProductYaml(ROOT_DIR, g.target.newProduct.id, { name: g.target.newProduct.name });
        productsCache = null;
        productId = g.target.newProduct.id;
        createdProducts++;
      } else if (g.target.productId) {
        productId = g.target.productId;
      } else {
        res.status(400).json({ error: 'each target must have productId or newProduct' });
        return;
      }
      productIds.push(productId);

      for (const fid of g.floppyIds) {
        const entry = cat.entries.find(e => e.id === fid);
        if (!entry) continue;
        entry.productId = productId;
        if (g.overrides?.version !== undefined) entry.version = g.overrides.version;
        if (g.overrides?.diskNumber !== undefined) entry.diskNumber = g.overrides.diskNumber;
        if (entry.storage?.git?.yamlPath) {
          await saveFloppyYaml(ROOT_DIR, entry);
        }
        updated++;
      }
    }

    // Regenerate products.json once, after every new product has been written.
    if (createdProducts > 0) {
      const products = await loadProducts(ROOT_DIR);
      await saveProducts(ROOT_DIR, products.map(p => ({ Id: p.id, Name: p.name })));
      productsCache = null;
    }

    // Now that these floppies have a product, consolidate their set photos
    // into the product group folder + regenerate JSON from YAML. Once for the
    // whole batch, not once per product.
    await persistCatalog(ROOT_DIR);
    catalog = null; // invalidate cache; next read reloads from regenerated catalog

    res.json({ success: true, updated, productId: productIds[0], productIds });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/match/skip', async (req, res) => {
  try {
    const { floppyIds } = req.body as { floppyIds: string[] };
    if (!floppyIds?.length) {
      res.status(400).json({ error: 'floppyIds is required' });
      return;
    }

    const cat = await getCatalog();
    let updated = 0;

    for (const fid of floppyIds) {
      const entry = cat.entries.find(e => e.id === fid);
      if (!entry) continue;
      if (!entry.tags) entry.tags = [];
      if (!entry.tags.includes('reviewed-unassigned')) {
        entry.tags.push('reviewed-unassigned');
      }
      // Persist to YAML (source of truth) -- otherwise the tag is regenerated
      // away the next time the catalog is rebuilt from YAML.
      if (entry.storage?.git?.yamlPath) await saveFloppyYaml(ROOT_DIR, entry);
      updated++;
    }

    await persistCatalog(ROOT_DIR);
    catalog = null;

    res.json({ success: true, updated });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Product creation endpoint
// ============================================================

app.post('/api/products', async (req, res) => {
  try {
    const { id, name } = req.body as { id: string; name: string };
    if (!id || !name) {
      res.status(400).json({ error: 'id and name are required' });
      return;
    }

    const products = await loadProducts(ROOT_DIR);
    const exists = products.find(p => p.id === id);
    if (exists) {
      res.status(409).json({ error: 'Product already exists', product: { Id: exists.id, Name: exists.name } });
      return;
    }

    // Write product YAML (source of truth)
    await saveProductYaml(ROOT_DIR, id, { name });
    // Regenerate JSON
    const updated = await loadProducts(ROOT_DIR);
    await saveProducts(ROOT_DIR, updated.map(p => ({ Id: p.id, Name: p.name })));
    productsCache = null;

    res.json({ success: true, product: { Id: id, Name: name } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Rename/update a product
app.patch('/api/products', async (req, res) => {
  try {
    const { id, name, description, categories, platform } = req.body as { id: string; name?: string; description?: string; categories?: string[]; platform?: string[] };
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }
    const existingProducts = await loadProducts(ROOT_DIR);
    const existing = existingProducts.find(p => p.id === id);
    const finalName = name || existing?.name || id;
    await saveProductYaml(ROOT_DIR, id, { name: finalName, description, categories, platform });
    // Also update the JSON for backward compat
    const products = await loadProducts(ROOT_DIR);
    const asLegacy = products.map(p => ({ Id: p.id, Name: p.name }));
    await saveProducts(ROOT_DIR, asLegacy);
    productsCache = null;
    res.json({ success: true, product: { Id: id, Name: finalName, categories: categories ?? existing?.categories ?? [] } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Delete a product
app.delete('/api/products', async (req, res) => {
  try {
    const { id } = req.body as { id: string };
    if (!id) { res.status(400).json({ error: 'id is required' }); return; }
    const { unlink } = await import('fs/promises');
    const filePath = join(ROOT_DIR, 'products', `${id}.yaml`);
    try { await unlink(filePath); } catch { /* may not exist */ }
    const products = await loadProducts(ROOT_DIR);
    const asLegacy = products.filter(p => p.id !== id).map(p => ({ Id: p.id, Name: p.name }));
    await saveProducts(ROOT_DIR, asLegacy);
    productsCache = null;
    res.json({ success: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Change a product's ID and cascade the new ID into every linked floppy YAML.
// Call with { confirm: false } first to preview the affected floppies, then
// { confirm: true } to apply. This is the only path that rewrites product.id in
// floppy YAMLs -- a bare YAML rename would orphan the floppies.
app.post('/api/products/rename-id', async (req, res) => {
  try {
    const body = req.body as { oldId?: string; newId?: string; confirm?: boolean };
    const oldId = String(body.oldId ?? '').trim();
    let newId = String(body.newId ?? '').trim();
    if (!oldId || !newId) { res.status(400).json({ error: 'oldId and newId are required' }); return; }
    if (oldId === '(unmatched)') { res.status(400).json({ error: '"(unmatched)" is not a real product and cannot be renamed' }); return; }
    if (/^\d/.test(newId)) newId = 'ND-' + newId; // match the convention used elsewhere
    if (newId === oldId) { res.status(400).json({ error: 'New ID must differ from the current ID' }); return; }

    const cat = await getCatalog();
    const products = await loadProducts(ROOT_DIR);
    const oldProduct = products.find(p => p.id === oldId);

    // Floppies that will be re-linked
    const affected = cat.entries
      .filter(e => e.productId === oldId)
      .map(e => ({ id: e.id, volumeName: e.volumeName, version: e.version, diskNumber: e.diskNumber }))
      .sort((a, b) => (a.volumeName ?? a.id).localeCompare(b.volumeName ?? b.id));

    // Other products that reference oldId as their sibling
    const siblingProducts = products.filter(p => p.siblingId === oldId).map(p => p.id);

    // Nothing to rename: no product record and no linked floppies
    const notARealProduct = !oldProduct && affected.length === 0;
    // A rename onto an existing product would be a merge -- not supported here
    const newProductExists = products.some(p => p.id === newId);
    const newIdInUse = cat.entries.some(e => e.productId === newId);
    const conflict = notARealProduct || newProductExists || newIdInUse;
    const conflictReason = notARealProduct
      ? `${oldId} is not a real product (no record and no linked floppies) -- nothing to rename`
      : newProductExists
        ? `A product with ID ${newId} already exists`
        : newIdInUse ? `Floppies are already linked to ${newId}` : null;

    if (!body.confirm) {
      res.json({ preview: true, oldId, newId, productName: oldProduct?.name ?? null, affected, siblingProducts, conflict, conflictReason });
      return;
    }

    if (conflict) { res.status(409).json({ error: conflictReason ?? 'Conflict' }); return; }

    const { unlink } = await import('fs/promises');

    // 1. Recreate the product YAML under the new ID, preserving all fields, then delete the old one
    if (oldProduct) {
      await saveProductYaml(ROOT_DIR, newId, {
        name: oldProduct.name,
        description: oldProduct.description ?? null,
        siblingId: oldProduct.siblingId ?? null,
        categories: oldProduct.categories ?? [],
        platform: oldProduct.platform ?? [],
      });
      await unlink(join(ROOT_DIR, 'products', `${oldId}.yaml`)).catch(() => { /* may not exist */ });
    }

    // 2. Repoint any sibling references
    for (const p of siblingProducts) {
      await saveProductYaml(ROOT_DIR, p, { siblingId: newId });
    }

    // 3. Re-link every affected floppy and rewrite its YAML
    let updated = 0;
    for (const e of cat.entries) {
      if (e.productId !== oldId) continue;
      e.productId = newId;
      if (e.storage?.git?.yamlPath) await saveFloppyYaml(ROOT_DIR, e);
      updated++;
    }

    // 4. YAML is already written (source of truth); regenerate JSON from it.
    await persistCatalog(ROOT_DIR);
    catalog = null;
    productsCache = null;

    res.json({ success: true, oldId, newId, updated, siblingProducts });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Categories API
// ============================================================

const CATEGORIES_FILE = join(ROOT_DIR, 'categories', 'product-categories.yaml');

interface CategoryDef {
  id: string;
  name: string;
  description: string;
}

async function loadCategories(): Promise<CategoryDef[]> {
  try {
    const raw = await readFile(CATEGORIES_FILE, 'utf-8');
    const parsed = yamlParse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveCategories(categories: CategoryDef[]): Promise<void> {
  const yamlStr = yamlStringify(categories, { lineWidth: 0 });
  await writeFile(CATEGORIES_FILE, '# Product categories for the Norsk Data Software Archive\n# Products reference these by ID in their categories field\n\n' + yamlStr, 'utf-8');
}

app.get('/api/categories', async (_req, res) => {
  try {
    const categories = await loadCategories();
    const products = await loadProducts(ROOT_DIR);

    // Count products per category
    const counts = new Map<string, number>();
    for (const p of products) {
      if (p.categories) {
        for (const catId of p.categories) {
          counts.set(catId, (counts.get(catId) ?? 0) + 1);
        }
      }
    }

    const result = categories.map(c => ({
      ...c,
      productCount: counts.get(c.id) ?? 0,
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/categories', async (req, res) => {
  try {
    const { id, name, description } = req.body as { id: string; name: string; description: string };
    if (!id || !name) {
      res.status(400).json({ error: 'id and name are required' });
      return;
    }

    const categories = await loadCategories();
    if (categories.find(c => c.id === id)) {
      res.status(409).json({ error: 'Category already exists' });
      return;
    }

    categories.push({ id, name, description: description || '' });
    await saveCategories(categories);
    res.json({ success: true, category: { id, name, description: description || '' } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.patch('/api/categories', async (req, res) => {
  try {
    const { id, name, description } = req.body as { id: string; name?: string; description?: string };
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }

    const categories = await loadCategories();
    const cat = categories.find(c => c.id === id);
    if (!cat) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    if (name !== undefined) cat.name = name;
    if (description !== undefined) cat.description = description;
    await saveCategories(categories);
    res.json({ success: true, category: cat });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete('/api/categories', async (req, res) => {
  try {
    const { id } = req.body as { id: string };
    if (!id) {
      res.status(400).json({ error: 'id is required' });
      return;
    }

    const categories = await loadCategories();
    const idx = categories.findIndex(c => c.id === id);
    if (idx === -1) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    categories.splice(idx, 1);
    await saveCategories(categories);

    // Remove this category from all product YAML files
    const products = await loadProducts(ROOT_DIR);
    for (const p of products) {
      if (p.categories && p.categories.includes(id)) {
        const newCats = p.categories.filter(c => c !== id);
        await saveProductYaml(ROOT_DIR, p.id, { name: p.name, categories: newCats });
      }
    }

    productsCache = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Tags API
// ============================================================

app.get('/api/tags', async (_req, res) => {
  try {
    const cat = await getCatalog();
    const tagCounts: Record<string, number> = {};

    for (const e of cat.entries) {
      if (e.tags) {
        for (const t of e.tags) {
          tagCounts[t] = (tagCounts[t] ?? 0) + 1;
        }
      }
    }

    const result = Object.entries(tagCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/tags/assign', async (req, res) => {
  try {
    const { floppyIds, tags } = req.body as { floppyIds: string[]; tags: string[] };
    if (!floppyIds?.length || !tags?.length) {
      res.status(400).json({ error: 'floppyIds and tags are required' });
      return;
    }

    const cat = await getCatalog();
    let updated = 0;

    for (const fid of floppyIds) {
      const entry = cat.entries.find(e => e.id === fid);
      if (!entry) continue;
      if (!entry.tags) entry.tags = [];
      for (const tag of tags) {
        if (!entry.tags.includes(tag)) {
          entry.tags.push(tag);
        }
      }
      // Persist to YAML (source of truth) so the tags survive catalog rebuilds.
      if (entry.storage?.git?.yamlPath) await saveFloppyYaml(ROOT_DIR, entry);
      updated++;
    }

    await persistCatalog(ROOT_DIR);
    catalog = null;

    res.json({ success: true, updated });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Import endpoints
// ============================================================

app.post('/api/import/file', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const contributor = String(req.body.contributor ?? 'web-upload');
    const source = String(req.body.source ?? 'web-upload');
    const cat = await getCatalog();

    const result = await importImage(cat, req.file.path, ROOT_DIR, {
      contributor,
      source,
    });

    if (!result.isDuplicate) {
      cat.entries.push(result.entry);
      // YAML written by the import; regenerate JSON + consolidate set photos.
      await persistCatalog(ROOT_DIR);
      catalog = null;
    }

    res.json({
      entry: result.entry,
      isDuplicate: result.isDuplicate,
      isVariant: result.isVariant,
      status: result.isDuplicate ? 'duplicate' : 'imported',
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/import/folder', async (req, res) => {
  try {
    const { path: folderPath } = req.body;
    if (!folderPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const absPath = resolve(folderPath);

    // Check folder exists
    try {
      const s = await stat(absPath);
      if (!s.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Path does not exist or is not accessible' });
      return;
    }

    // Find .img files and preview them
    const files = await readdir(absPath);
    const imgFiles = files.filter(f => extname(f).toLowerCase() === '.img').sort();

    if (imgFiles.length === 0) {
      res.json({ path: absPath, images: [], count: 0 });
      return;
    }

    // Preview each file (parse NDFS, check duplicates)
    const cat = await getCatalog();
    const previews = [];

    for (const imgFile of imgFiles) {
      const filePath = join(absPath, imgFile);
      try {
        const result = await importImage(cat, filePath, undefined, {});

        // Determine status and existing entry info for duplicates
        let status: 'new' | 'duplicate' | 'variant' = 'new';
        let existingEntry: { id: string; volumeName: string | null; importedAt: string | null } | null = null;

        if (result.isDuplicate) {
          status = 'duplicate';
          existingEntry = {
            id: result.entry.id,
            volumeName: result.entry.volumeName,
            importedAt: result.entry.importedAt,
          };
        } else if (result.isVariant) {
          status = 'variant';
        }

        previews.push({
          file: imgFile,
          volumeName: result.entry.volumeName,
          productId: result.entry.productId,
          version: result.entry.version,
          bootFormat: result.entry.bootFormat,
          sizeMB: result.entry.imageSizeBytes
            ? (result.entry.imageSizeBytes / (1024 * 1024)).toFixed(2)
            : null,
          isDuplicate: result.isDuplicate,
          isVariant: result.isVariant,
          status,
          existingEntry,
          storageClass: result.entry.storageClass,
        });
      } catch (err) {
        previews.push({
          file: imgFile,
          error: String(err),
          status: 'error' as const,
        });
      }
    }

    // Scan for photos, docs, unmapped files
    const { DEFAULT_SCAN_EXTENSIONS, scanFolderArtifacts } = await import('./api/import.js');
    const scanExt = req.body.extensions ? {
      image: req.body.extensions.image ?? DEFAULT_SCAN_EXTENSIONS.image,
      photo: req.body.extensions.photo ?? DEFAULT_SCAN_EXTENSIONS.photo,
      document: req.body.extensions.document ?? DEFAULT_SCAN_EXTENSIONS.document,
    } : DEFAULT_SCAN_EXTENSIONS;

    const volNames = previews.map(p => ('volumeName' in p ? p.volumeName : null) as string | null);
    const artifacts = await scanFolderArtifacts(absPath, imgFiles, volNames, scanExt);

    const photoFiles = [...artifacts.setPhotos];
    for (const [, diskPhotos] of artifacts.diskPhotos) {
      photoFiles.push(...diskPhotos);
    }
    const docFiles = [...artifacts.imagingLogs];
    if (artifacts.transcription) docFiles.push(artifacts.transcription);

    res.json({
      path: absPath,
      images: previews,
      count: imgFiles.length,
      photos: photoFiles,
      documents: docFiles,
      unmapped: artifacts.unmapped,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/import/folder/confirm', async (req, res) => {
  try {
    const { path: folderPath, contributor, source, skipDuplicates } = req.body;
    if (!folderPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const absPath = resolve(folderPath);
    const cat = await getCatalog();

    // skipDuplicates defaults to true unless explicitly set to false
    const shouldSkipDuplicates = skipDuplicates !== false;

    const result = await importFolder(cat, absPath, {
      contributor: contributor ?? 'web-import',
      source: source ?? 'web-import',
      rootDir: ROOT_DIR,
      skipDuplicates: shouldSkipDuplicates,
    });

    // Consolidate set photos + regenerate catalog JSON. The search index and
    // static site are rebuilt by the post-mutation middleware (debounced).
    await persistCatalog(ROOT_DIR);
    catalog = null;

    res.json({
      imported: result.imported.map(e => ({
        id: e.id,
        volumeName: e.volumeName,
        productId: e.productId,
        storageClass: e.storageClass,
      })),
      duplicates: result.duplicates,
      variants: result.variants,
      errors: result.errors,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/import/folder-recursive', async (req, res) => {
  try {
    const { path: basePath, extensions } = req.body as {
      path: string;
      extensions?: { image?: string[]; photo?: string[]; document?: string[] };
    };
    if (!basePath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const { DEFAULT_SCAN_EXTENSIONS, scanFolderArtifacts } = await import('./api/import.js');
    const scanExt = {
      image: extensions?.image ?? DEFAULT_SCAN_EXTENSIONS.image,
      photo: extensions?.photo ?? DEFAULT_SCAN_EXTENSIONS.photo,
      document: extensions?.document ?? DEFAULT_SCAN_EXTENSIONS.document,
    };
    const imageExtSet = new Set(scanExt.image.map(e => e.toLowerCase()));

    const absPath = resolve(basePath);
    const folders = await findImageFolders(absPath, scanExt.image);
    const cat = await getCatalog();

    const { createHash } = await import('crypto');
    const { readFile: readF } = await import('fs/promises');

    let totalNew = 0;
    let totalDuplicate = 0;
    let totalUnmapped = 0;
    const result = [];

    for (const folder of folders) {
      const allFiles = (await readdir(folder)).sort();
      const imgFiles = allFiles.filter(f => imageExtSet.has(extname(f).toLowerCase()));
      let folderNew = 0;
      let folderDup = 0;

      for (const file of imgFiles) {
        const buf = await readF(join(folder, file));
        const md5 = createHash('md5').update(buf).digest('hex');
        const exists = cat.entries.some(e => e.md5 === md5);
        if (exists) folderDup++;
        else folderNew++;
      }

      // Scan artifacts to find unmapped files
      const artifacts = await scanFolderArtifacts(folder, imgFiles, imgFiles.map(() => null), scanExt);
      const unmapped = artifacts.unmapped;
      totalUnmapped += unmapped.length;

      totalNew += folderNew;
      totalDuplicate += folderDup;
      result.push({
        path: folder,
        imageCount: folderNew + folderDup,
        newCount: folderNew,
        duplicateCount: folderDup,
        photos: artifacts.setPhotos.length + Array.from(artifacts.diskPhotos.values()).reduce((s, a) => s + a.length, 0),
        documents: artifacts.imagingLogs.length + (artifacts.transcription ? 1 : 0),
        unmapped,
      });
    }

    res.json({
      basePath: absPath,
      folders: result,
      totalFolders: result.length,
      totalImages: totalNew + totalDuplicate,
      totalNew,
      totalDuplicate,
      totalUnmapped,
      extensions: scanExt,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/import/folder-recursive/confirm', async (req, res) => {
  try {
    const { path: basePath, contributor, source } = req.body;
    if (!basePath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }

    const absPath = resolve(basePath);
    const folders = await findImageFolders(absPath);
    const cat = await getCatalog();

    const allResults = {
      imported: [] as Array<{ id: string; volumeName: string | null; productId: string | null }>,
      duplicates: [] as string[],
      variants: [] as string[],
      errors: [] as Array<{ file: string; error: string }>,
      foldersProcessed: 0,
    };

    for (const folder of folders) {
      const result = await importFolder(cat, folder, {
        contributor: contributor ?? 'web-import',
        source: source ?? 'web-import',
        rootDir: ROOT_DIR,
      });

      allResults.imported.push(
        ...result.imported.map(e => ({
          id: e.id,
          volumeName: e.volumeName,
          productId: e.productId,
        }))
      );
      allResults.duplicates.push(...result.duplicates);
      allResults.variants.push(...result.variants);
      allResults.errors.push(...result.errors);
      allResults.foldersProcessed++;
    }

    // Consolidate set photos + regenerate catalog JSON. The search index and
    // static site are rebuilt by the post-mutation middleware (debounced).
    await persistCatalog(ROOT_DIR);
    catalog = null;

    res.json(allResults);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Action endpoints
// ============================================================

app.post('/api/rebuild-catalog', async (_req, res) => {
  try {
    await reloadAndRegenerate();
    const cat = await getCatalog();
    res.json({ success: true, entries: cat.entries.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/**
 * Regenerate the search index (catalog/index.json) and the static site
 * (site/, what :8000 serves) from the current YAML/catalog. Run after any
 * import or product assignment so the browseable site stays in sync without a
 * manual "rebuild" step.
 */
async function rebuildIndexAndSite(): Promise<void> {
  const cat = await reloadCatalog();
  await writeIndex(ROOT_DIR, cat);
  await buildStaticSite(ROOT_DIR);
}

// Debounced background rebuild of the search index + static site. Any endpoint
// that mutates catalog/product data calls this; rapid successive mutations
// (e.g. confirming several product groups, or a burst of edits) coalesce into a
// single rebuild shortly after the last change. This keeps the :8000 static
// preview in sync regardless of which client path made the change -- the
// rebuild lives at the server, not sprinkled across UI handlers.
let siteRebuildTimer: ReturnType<typeof setTimeout> | null = null;
let siteRebuildRunning = false;
let siteRebuildQueuedAgain = false;
function scheduleSiteRebuild(): void {
  if (siteRebuildTimer) clearTimeout(siteRebuildTimer);
  siteRebuildTimer = setTimeout(async () => {
    siteRebuildTimer = null;
    if (siteRebuildRunning) { siteRebuildQueuedAgain = true; return; }
    siteRebuildRunning = true;
    try {
      do {
        siteRebuildQueuedAgain = false;
        await rebuildIndexAndSite();
      } while (siteRebuildQueuedAgain);
    } catch (err) {
      console.error('Background site rebuild failed:', err);
    } finally {
      siteRebuildRunning = false;
    }
    // 5 s, not 1.2 s: a confirm request takes ~1.6 s on a 300-entry catalog, so
    // a shorter window expires between requests in a burst and starts a full
    // rebuild for each one.
  }, 5000);
}

app.post('/api/rebuild-index', async (_req, res) => {
  try {
    const cat = await reloadCatalog();
    await writeIndex(ROOT_DIR, cat);
    res.json({ success: true, entries: cat.entries.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/rebuild-site', async (_req, res) => {
  try {
    await buildStaticSite(ROOT_DIR);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Rebuild both the search index and the static site in one call. Used by the
// Matcher after a confirm batch so the :8000 preview reflects new assignments
// without rebuilding once per product group.
app.post('/api/rebuild-index-and-site', async (_req, res) => {
  try {
    await rebuildIndexAndSite();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function currentBranch(): string {
  return execSync('git branch --show-current', { cwd: ROOT_DIR }).toString().trim();
}

app.post('/api/git/commit', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    const branch = currentBranch();
    if (branch === 'main' || branch === 'master') {
      res.status(403).json({ error: `Don't commit on ${branch}. Create a branch first.` });
      return;
    }
    execSync('git add -A', { cwd: ROOT_DIR });
    execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: ROOT_DIR });
    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const DEFAULT_BRANCH = 'main';

app.post('/api/git/push', async (_req, res) => {
  try {
    const branch = execSync('git branch --show-current', { cwd: ROOT_DIR }).toString().trim();
    // Direct push to the default branch is not allowed -- changes must go through
    // a feature branch and a pull request.
    if (branch === DEFAULT_BRANCH || branch === 'master') {
      res.status(403).json({ error: `Direct push to ${branch} is not allowed. Use "Create branch & PR" to open a pull request.` });
      return;
    }
    const output = execSync(`git push -u origin ${branch} 2>&1`, { cwd: ROOT_DIR }).toString();
    res.json({ success: true, output });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Step 1: create a feature branch and switch to it. Any uncommitted changes on
// the default branch come along, so you commit them on the branch next.
app.post('/api/git/branch', async (req, res) => {
  try {
    const branch = String((req.body as { branch?: string }).branch ?? '').trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._/-]/g, '');
    if (!branch) { res.status(400).json({ error: 'A branch name is required' }); return; }
    if (branch === DEFAULT_BRANCH || branch === 'master') { res.status(400).json({ error: 'Pick a branch name other than the default branch' }); return; }
    const output = execSync(`git checkout -b ${branch} 2>&1`, { cwd: ROOT_DIR }).toString();
    res.json({ success: true, branch, output });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Step 2: commit any pending changes on the current feature branch, push it, and
// open a pull request. Refuses to run on the default branch.
app.post('/api/git/commit-pr', async (req, res) => {
  try {
    const body = req.body as { message?: string; title?: string; body?: string };
    const branch = currentBranch();
    if (branch === DEFAULT_BRANCH || branch === 'master') {
      res.status(403).json({ error: 'You are on the default branch. Create a branch first.' });
      return;
    }
    const message = String(body.message ?? body.title ?? 'Update').trim();
    const title = String(body.title ?? message).trim();
    const prBody = String(body.body ?? '').trim();
    const log: string[] = [];
    const run = (cmd: string) => { const out = execSync(cmd, { cwd: ROOT_DIR }).toString(); log.push(`$ ${cmd}\n${out}`.trim()); return out; };

    const dirty = execSync('git status --porcelain', { cwd: ROOT_DIR }).toString().trim();
    if (dirty) {
      run('git add -A');
      run(`git commit -m ${JSON.stringify(message)}`);
    }
    run(`git push -u origin ${branch} 2>&1`);

    let prUrl: string | null = null;
    try {
      prUrl = run(`gh pr create --base ${DEFAULT_BRANCH} --head ${branch} --title ${JSON.stringify(title)} --body ${JSON.stringify(prBody)} 2>&1`).trim();
    } catch (e) {
      log.push(`gh pr create failed (branch is pushed; open the PR manually): ${String(e)}`);
    }
    res.json({ success: true, branch, prUrl, log: log.join('\n\n') });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Switch back to an up-to-date default branch (after a PR merged). Requires a
// clean working tree; deletes the branch you were on if it's been merged.
app.post('/api/git/sync-main', async (_req, res) => {
  try {
    const dirty = execSync('git status --porcelain', { cwd: ROOT_DIR }).toString().trim();
    if (dirty) { res.status(400).json({ error: 'You have uncommitted changes. Commit them (and PR) or revert first.' }); return; }
    const from = currentBranch();
    const log: string[] = [];
    const run = (cmd: string) => { const out = execSync(cmd, { cwd: ROOT_DIR }).toString(); log.push(`$ ${cmd}\n${out}`.trim()); return out; };

    run('git fetch origin --prune 2>&1');
    run(`git checkout ${DEFAULT_BRANCH} 2>&1`);
    run(`git pull --ff-only origin ${DEFAULT_BRANCH} 2>&1`);

    // Delete the previous branch if it's fully merged (git branch -d is safe -
    // it refuses if not merged, e.g. a squash-merge, which we just report).
    let deletedBranch: string | null = null;
    if (from && from !== DEFAULT_BRANCH && from !== 'master') {
      try { run(`git branch -d ${from} 2>&1`); deletedBranch = from; }
      catch { log.push(`(kept local branch "${from}" - not a fast-forward merge; delete it manually if the PR was squash/rebase merged)`); }
    }
    res.json({ success: true, deletedBranch, log: log.join('\n\n') });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/git/status', async (_req, res) => {
  try {
    const statusOutput = execSync('git status --porcelain', { cwd: ROOT_DIR }).toString();
    // Split on newline but don't trim the whole string (leading spaces are significant in porcelain format)
    const lines = statusOutput.replace(/\n$/, '').split('\n').filter(l => l.length > 0);
    const isDirty = lines.length > 0;

    // "Unpushed" = commits on this branch not yet on ITS OWN remote branch
    // (@{u}). Counting against origin/main is wrong: a pushed feature branch
    // shows its commits as "unpushed" even though they're already on the remote
    // (and in a PR). Fall back to origin/main only when the branch has no
    // upstream yet (never pushed -- then everything ahead of main is unpushed).
    let unpushed = 0;
    try {
      const logOutput = execSync('git log @{u}..HEAD --oneline 2>/dev/null', { cwd: ROOT_DIR }).toString();
      unpushed = logOutput.trim() ? logOutput.trim().split('\n').length : 0;
    } catch {
      try {
        const logOutput = execSync('git log origin/main..HEAD --oneline 2>/dev/null', { cwd: ROOT_DIR }).toString();
        unpushed = logOutput.trim() ? logOutput.trim().split('\n').length : 0;
      } catch {
        // No remote tracking or no commits
      }
    }

    let branch = 'unknown';
    try {
      branch = execSync('git branch --show-current', { cwd: ROOT_DIR }).toString().trim();
    } catch { /* ignore */ }

    // Categorize changes from porcelain output
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const line of lines) {
      if (line.length < 3) continue;
      const xy = line.substring(0, 2);
      // Git porcelain: XY then space then path. When Y is space, the space and separator merge.
      const filePath = line.substring(2).trimStart();
      if (xy.includes('D')) {
        deleted.push(filePath);
      } else if (xy === '??' || xy === 'A ' || xy === 'AM') {
        added.push(filePath);
      } else {
        modified.push(filePath);
      }
    }

    // Build summary + enrich image files with catalog data
    const cat = await getCatalog();
    const imagesByPath = new Map<string, { volumeName: string | null; productId: string | null; version: string | null; contributor: string | null }>();
    for (const e of cat.entries) {
      if (e.storage?.git?.imagePath) {
        imagesByPath.set(e.storage.git.imagePath, {
          volumeName: e.volumeName,
          productId: e.productId,
          version: e.version,
          contributor: e.provenance?.contributor ?? null,
        });
      }
    }

    let newImages = 0;
    let modifiedEntries = 0;
    let newProducts = 0;
    let otherFiles = 0;

    interface EnrichedFile { path: string; status: string; type: string; volumeName?: string | null; productId?: string | null; version?: string | null; contributor?: string | null }
    const enrichedFiles: EnrichedFile[] = [];

    const allChanges = [
      ...added.map(f => ({ path: f, status: 'added' })),
      ...modified.map(f => ({ path: f, status: 'modified' })),
      ...deleted.map(f => ({ path: f, status: 'deleted' })),
    ];

    for (const f of allChanges) {
      let type = 'other';
      const enriched: EnrichedFile = { path: f.path, status: f.status, type };

      if (f.path.startsWith('images/') && (f.path.endsWith('.img.gz') || f.path.endsWith('.JPG') || f.path.endsWith('.jpg') || f.path.endsWith('.txt') || f.path.endsWith('.log'))) {
        type = f.path.endsWith('.img.gz') ? 'image' : 'artifact';
        newImages++;
        // Find matching catalog entry
        const match = imagesByPath.get(f.path);
        if (match) {
          enriched.volumeName = match.volumeName;
          enriched.productId = match.productId;
          enriched.version = match.version;
          enriched.contributor = match.contributor;
        } else {
          // Try to find by directory match (set photos, labels)
          for (const [imgPath, info] of imagesByPath) {
            const imgDir = imgPath.substring(0, imgPath.lastIndexOf('/'));
            if (f.path.startsWith(imgDir)) {
              enriched.productId = info.productId;
              enriched.version = info.version;
              enriched.contributor = info.contributor;
              break;
            }
          }
        }
      } else if (f.path.includes('catalog/') && f.path.endsWith('.json')) {
        type = 'catalog';
        modifiedEntries++;
      } else if (f.path.includes('products') && f.path.endsWith('.json')) {
        type = 'products';
        newProducts++;
      } else {
        otherFiles++;
      }
      enriched.type = type;
      enrichedFiles.push(enriched);
    }

    res.json({
      clean: !isDirty,
      branch,
      unpushed,
      changes: { added, modified, deleted },
      enrichedFiles,
      summary: { newImages, modifiedEntries, newProducts, otherFiles },
      isDirty,
      changedFiles: lines.length,
      unpushedCommits: unpushed,
      status: statusOutput,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Git diff endpoint
// ============================================================

app.get('/api/git/diff', async (req, res) => {
  try {
    const file = req.query.file ? String(req.query.file) : null;

    if (file) {
      // Diff for a specific file
      let diff = '';
      try {
        // Check if tracked or untracked
        const isTracked = execSync(`git ls-files ${JSON.stringify(file)}`, { cwd: ROOT_DIR }).toString().trim();
        if (isTracked) {
          diff = execSync(`git diff HEAD -- ${JSON.stringify(file)} 2>/dev/null`, { cwd: ROOT_DIR }).toString();
        } else {
          // Untracked: show full content as "new file"
          const content = await readFile(join(ROOT_DIR, file), 'utf-8');
          diff = `New file: ${file}\n${'─'.repeat(60)}\n${content}`;
        }
      } catch {
        diff = '(unable to diff)';
      }
      res.json({ file, diff });
    } else {
      // Overall diff stat
      let stat = '';
      try {
        stat = execSync('git diff --stat HEAD 2>/dev/null', { cwd: ROOT_DIR }).toString();
        const untracked = execSync('git ls-files --others --exclude-standard', { cwd: ROOT_DIR }).toString().trim();
        if (untracked) {
          const untrackedFiles = untracked.split('\n');
          stat += '\n' + untrackedFiles.length + ' untracked file(s):\n';
          for (const f of untrackedFiles.slice(0, 50)) {
            stat += '  ' + f + '\n';
          }
          if (untrackedFiles.length > 50) {
            stat += '  ... and ' + (untrackedFiles.length - 50) + ' more\n';
          }
        }
      } catch {
        stat = '(no changes to diff)';
      }
      res.json({ stat });
    }
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Git revert endpoint
// ============================================================

app.post('/api/git/revert', async (req, res) => {
  try {
    const { confirm } = req.body;
    if (!confirm) {
      res.status(400).json({ error: 'confirm: true is required' });
      return;
    }

    // Count files that will be reverted
    const statusOutput = execSync('git status --porcelain', { cwd: ROOT_DIR }).toString();
    const lines = statusOutput.trim() ? statusOutput.trim().split('\n') : [];
    const reverted = lines.length;

    execSync('git checkout -- .', { cwd: ROOT_DIR });
    execSync('git clean -fd images/', { cwd: ROOT_DIR });

    // Reload catalog since files changed on disk
    await reloadCatalog();

    res.json({ success: true, reverted });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Catalog entry PATCH (metadata editor)
// ============================================================

app.patch('/api/catalog-entry', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    if (!entryId) {
      res.status(400).json({ error: 'Missing id query parameter' });
      return;
    }

    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    const updates = req.body;

    // Update tags
    if (updates.tags !== undefined) {
      entry.tags = Array.isArray(updates.tags) ? updates.tags : null;
    }

    // Update docs
    if (updates.docs !== undefined) {
      entry.docs = updates.docs;
    }

    // Update provenance
    if (updates.provenance !== undefined) {
      if (entry.provenance) {
        if (updates.provenance.contributor !== undefined) entry.provenance.contributor = updates.provenance.contributor;
        if (updates.provenance.method !== undefined) entry.provenance.method = updates.provenance.method;
        if (updates.provenance.dateImaged !== undefined) entry.provenance.dateImaged = updates.provenance.dateImaged;
        if (updates.provenance.notes !== undefined) entry.provenance.notes = updates.provenance.notes;
      } else {
        entry.provenance = updates.provenance;
      }
    }

    // Update mediaRole
    if (updates.mediaRole !== undefined) {
      entry.mediaRole = updates.mediaRole;
    }

    // Write YAML file if entry has a yamlPath
    if (entry.storage?.git?.yamlPath) {
      await saveFloppyYaml(ROOT_DIR, entry);
    }

    await persistCatalog(ROOT_DIR);
    catalog = null;

    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Browse an MS-DOS floppy: volume info plus the full directory tree.
app.get('/api/dosfs/info', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    if (!entry) { res.status(404).json({ error: 'Entry not found' }); return; }
    const imagePath = entry.storage?.git?.imagePath;
    if (!imagePath) { res.status(404).json({ error: 'No image file for this entry' }); return; }
    const abs = resolve(ROOT_DIR, imagePath);
    if (!abs.startsWith(ROOT_DIR)) { res.status(403).json({ error: 'Access denied' }); return; }

    const { gunzipSync } = await import('zlib');
    const { DosVolume, NotFatError } = await import('./lib/dosfs/index.js');
    const raw = gunzipSync(await readFile(abs));
    let vol;
    try {
      vol = DosVolume.open(new Uint8Array(raw));
    } catch (err) {
      const why = err instanceof NotFatError ? err.message : String(err);
      res.status(422).json({ error: 'Not an MS-DOS filesystem: ' + why });
      return;
    }
    res.json({ id: entryId, info: vol.info, entries: vol.listAll() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// One file off an MS-DOS floppy. ?as=text returns it decoded, otherwise raw bytes.
app.get('/api/dosfs/read-file', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const filePath = String(req.query.path ?? '');
    if (!entryId || !filePath) { res.status(400).json({ error: 'Missing id or path' }); return; }
    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    const imagePath = entry?.storage?.git?.imagePath;
    if (!imagePath) { res.status(404).json({ error: 'Entry or image not found' }); return; }
    const abs = resolve(ROOT_DIR, imagePath);
    if (!abs.startsWith(ROOT_DIR)) { res.status(403).json({ error: 'Access denied' }); return; }

    const { gunzipSync } = await import('zlib');
    const { DosVolume } = await import('./lib/dosfs/index.js');
    const vol = DosVolume.open(new Uint8Array(gunzipSync(await readFile(abs))));
    let data = vol.readFile(filePath);
    if (!data) { res.status(404).json({ error: 'File not found on the disk' }); return; }
    // Same option the NDFS reader offers: ND text written with the parity bit
    // set is unreadable until bit 7 is cleared.
    if (String(req.query.parity ?? '') === 'strip') {
      const stripped = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) stripped[i] = data[i] & 0x7f;
      data = stripped;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'inline; filename="' + basename(filePath) + '"');
    res.send(Buffer.from(data));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Browse a Norsk Data backup volume. Handles both formats: a BACKUP-SYSTEM
// (VOL1) volume lists its files; a WINCH-TO-FLOPP volume has no file names at
// all, so it reports the header and the page map instead.
/**
 * The backup set one image belongs to: every volume of the set with its own
 * status, plus the state of the set as a whole. Grouped from the catalog, so
 * no image has to be opened - the facts were recorded at detect time.
 */
app.get('/api/backup-set', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const cat = await getCatalog();
    const { groupBackupSets, setKeyOf, describeSet, setVerdict } = await import('./lib/backupsets/index.js');
    const inputs = cat.entries.map(e => ({
      id: e.id,
      volumeName: e.volumeName,
      imageSizeBytes: e.imageSizeBytes,
      backupFiles: e.backupFiles,
      backupSet: e.backupSet,
    }));

    if (!entryId) {
      // no id: every set in the archive, for a listing
      const sets = [...groupBackupSets(inputs).values()]
        .map(s => ({ ...s, summary: describeSet(s), verdict: setVerdict(s) }));
      res.json({ sets });
      return;
    }

    const entry = cat.entries.find(e => e.id === entryId);
    if (!entry) { res.status(404).json({ error: 'Entry not found' }); return; }
    const key = setKeyOf({ id: entry.id, backupSet: entry.backupSet });
    if (!key) { res.json({ set: null }); return; }
    const set = groupBackupSets(inputs).get(key) ?? null;
    res.json({ set: set ? { ...set, summary: describeSet(set), verdict: setVerdict(set) } : null });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/ndbackup/info', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    const imagePath = entry?.storage?.git?.imagePath;
    if (!imagePath) { res.status(404).json({ error: 'Entry or image not found' }); return; }
    const abs = resolve(ROOT_DIR, imagePath);
    if (!abs.startsWith(ROOT_DIR)) { res.status(403).json({ error: 'Access denied' }); return; }

    const { gunzipSync } = await import('zlib');
    const nb = await import('./lib/ndbackup/index.js');
    const raw = new Uint8Array(gunzipSync(await readFile(abs)));

    if (nb.isBackupVolume(raw)) { res.json(nb.readBackupVolume(raw)); return; }
    if (nb.isWinchVolume(raw)) { res.json(nb.readWinchVolume(raw)); return; }
    res.status(422).json({ error: 'Not a Norsk Data backup volume' });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/**
 * One BACKUP-SYSTEM run, read from every volume of it that this archive holds.
 *
 * A run is written across several floppies and a file that does not fit is cut
 * at the end of one volume and continued at the start of the next, under the
 * same name. Read one image on its own and the listing is a slice of the run
 * with a cut file at one or both ends. This assembles the run instead: the
 * volumes in chain order, their files in order, and a file that spans a volume
 * boundary as ONE file whose parts are named. Nothing is cut unless the volume
 * that would continue it is genuinely not held here.
 */
interface RunPart { entryId: string; index: number; bytes: number; volume: number; }
interface RunFile {
  fullName: string; name: string; type: string;
  created: string | null; system: string; stale: boolean;
  bytes: number;
  parts: RunPart[];
  /** the run ends mid-file and no volume here continues it */
  truncated: boolean;
  /**
   * volumes that carry a HDR1 for this file but no data: BACKUP-SYSTEM writes
   * the label first, and when the volume then runs out it closes the volume and
   * writes the whole file again on the next one.
   */
  stubVolumes?: number[];
  /** the same file as found by the other reads of that floppy, when they disagree */
  otherReads?: { entryId: string; bytes: number }[];
}

async function buildBackupRun(entryId: string) {
  const cat = await getCatalog();
  const entry = cat.entries.find(e => e.id === entryId);
  if (!entry) return { error: 'Entry not found', status: 404 } as const;

  const { groupBackupSets, setKeyOf } = await import('./lib/backupsets/index.js');
  const inputs = cat.entries.map(e => ({
    id: e.id, volumeName: e.volumeName, imageSizeBytes: e.imageSizeBytes,
    backupFiles: e.backupFiles, backupSet: e.backupSet,
  }));
  const key = setKeyOf({ id: entry.id, backupSet: entry.backupSet });
  const set = key ? groupBackupSets(inputs).get(key) ?? null : null;

  // No set recorded (a lone volume the detector never grouped): the run is
  // that one image. Otherwise a volume slot brings EVERY read of that floppy,
  // best read first.
  const orderedSlots: string[][] = set && set.ordering === 'chained'
    ? set.slots.map(sl => sl.reads.map(r => r.id)).filter(ids => ids.length > 0)
    : [[entryId]];

  const { gunzipSync } = await import('zlib');
  const nb = await import('./lib/ndbackup/index.js');

  const volumes: { id: string; volume: number; volumeId: string; owner: string; fileCount: number; reads: string[] }[] = [];
  const files: RunFile[] = [];
  let sectorSize = 0, blockLength = 0, volumeId = '', owner = '';

  const readVolume = async (id: string) => {
    const e = cat.entries.find(x => x.id === id);
    const imagePath = e?.storage?.git?.imagePath;
    if (!imagePath) return null;
    const abs = resolve(ROOT_DIR, imagePath);
    if (!abs.startsWith(ROOT_DIR)) return null;
    const raw = new Uint8Array(gunzipSync(await readFile(abs)));
    if (!nb.isBackupVolume(raw)) return null;
    return nb.readBackupVolume(raw);
  };

  for (let vi = 0; vi < orderedSlots.length; vi++) {
    const readIds = orderedSlots[vi];

    // Every read of this floppy, because a marginal disk loses a different set
    // of labels each time it is read. Measured on this archive with stale
    // labels excluded: the three reads of BACK/AGNETA volume 1 name 52 files
    // between them and only 28 in all three; the two reads of PANG/BELI-UNIQUE
    // volume 1 name 14 and share exactly 1. A label is 80 bytes at a sector
    // boundary and each HDR1/EOF1 pair stands on its own, so a file found by
    // one read alone is still a file that can be listed and extracted.
    const reads: { id: string; vol: Awaited<ReturnType<typeof readVolume>> }[] = [];
    for (const id of readIds) {
      const vol = await readVolume(id);
      if (vol) reads.push({ id, vol });
    }
    if (!reads.length) continue;

    const lead = reads[0];
    if (!sectorSize) { sectorSize = lead.vol!.sectorSize; blockLength = lead.vol!.blockLength; volumeId = lead.vol!.volumeId; owner = lead.vol!.owner; }

    // One candidate per file name, taken from the read with the strongest
    // evidence: a label closed by its own EOF1 beats one that was left open,
    // content beats a region that is nothing but fill, and a longer readable
    // region beats a shorter one. Where two reads disagree on the length the
    // rejected candidates are kept on the file as `otherReads` rather than
    // being dropped in silence.
    interface Cand { entryId: string; index: number; f: any; }
    const score = (f: any) => (f.stale ? 0 : 8) + (f.blocks !== null ? 4 : 0) + (f.dataLength > 0 ? 2 : 0);
    const byName = new Map<string, Cand[]>();
    reads.forEach(r => {
      r.vol!.files.forEach((f, index) => {
        const list = byName.get(f.fullName) ?? [];
        list.push({ entryId: r.id, index, f });
        byName.set(f.fullName, list);
      });
    });

    const chosen: Cand[] = [];
    for (const [, cands] of byName) {
      const sorted = cands.slice().sort((a, b) =>
        score(b.f) - score(a.f) || b.f.dataLength - a.f.dataLength ||
        a.f.sequence - b.f.sequence);
      chosen.push(sorted[0]);
      (sorted[0] as any).rejected = sorted.slice(1);
    }
    // Volume order: the file number SINTRAN wrote in HDR1, then where the label
    // sits in the image for the reads where that number was lost.
    chosen.sort((a, b) => (a.f.sequence || 9999) - (b.f.sequence || 9999) || a.f.dataOffset - b.f.dataOffset);

    volumes.push({
      id: lead.id, volume: vi + 1, volumeId: lead.vol!.volumeId, owner: lead.vol!.owner,
      fileCount: chosen.length, reads: reads.map(r => r.id),
    });

    chosen.forEach((cand, ci) => {
      const f = cand.f;
      const idx = cand.index;
      const id = cand.entryId;
      const isFirstOfVolume = ci === 0;
      const prev = files.length ? files[files.length - 1] : null;
      // The first file of this volume carries on the cut file of the last one
      // when it has the same name: one file, two parts.
      const continues = !!prev && isFirstOfVolume && prev.parts[prev.parts.length - 1].volume === vi &&
                        prev.truncated && prev.fullName === f.fullName;
      if (continues && prev) {
        // The file is not split - it is written again, whole, on this volume.
        // Checked on all three cases in this archive by reading both regions:
        //   BMUS-GRAFIK-01:SYMB  img-49fe9da76a2b holds 79,448 bytes of 0x00
        //     and 0xE5 fill under the label; img-6ac9e908face holds the file,
        //     79,449 bytes of PLANC source from "$implicit off" to its end.
        //   PREP-65:C  img-e3ee5c881401 holds 2,321 bytes that are not C at
        //     all (an older backup's bytes); img-ccf89e5797f5 holds the source.
        //   SERVER:H  img-756191825b90 holds a ruler line and 6,080 zero bytes;
        //     img-c12ef5689d05 holds the header, ending at "#endif".
        // In each case the two regions share almost no bytes (5 of 6,572 on
        // SERVER:H), so the earlier region is not the first half of anything.
        // The stub is recorded, not silently dropped.
        prev.stubVolumes = (prev.stubVolumes ?? []).concat(prev.parts.map(pt => pt.volume));
        prev.parts = [{ entryId: id, index: idx, bytes: f.dataLength, volume: vi + 1 }];
        prev.bytes = f.dataLength;
        prev.truncated = f.continued;
        return;
      }
      const rejected = ((cand as any).rejected ?? []) as { entryId: string; index: number; f: any }[];
      files.push({
        fullName: f.fullName, name: f.name, type: f.type,
        created: f.created, system: f.system, stale: f.stale,
        bytes: f.dataLength,
        parts: [{ entryId: id, index: idx, bytes: f.dataLength, volume: vi + 1 }],
        truncated: f.continued,
        // the other reads of this floppy that also found the file, and what
        // length each of them made it - shown when they disagree
        otherReads: rejected.map(r => ({ entryId: r.entryId, bytes: r.f.dataLength })),
      });
    });
  }

  if (!volumes.length) return { error: 'No BACKUP-SYSTEM volume could be read', status: 422 } as const;

  return {
    kind: 'backup-run' as const,
    volumeId, owner, sectorSize, blockLength,
    openedOn: entryId,
    volumes, files,
    setKey: key,
    breaks: set?.breaks ?? [],
  };
}

app.get('/api/ndbackup/run', async (req, res) => {
  try {
    const run = await buildBackupRun(String(req.query.id ?? ''));
    if ('error' in run) { res.status(run.status ?? 500).json({ error: run.error }); return; }
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// One file of a run, joined across every volume it spans.
app.get('/api/ndbackup/read-run-file', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const index = parseInt(String(req.query.index ?? '-1'), 10);
    if (!entryId || index < 0) { res.status(400).json({ error: 'Missing id or index' }); return; }
    const run = await buildBackupRun(entryId);
    if ('error' in run) { res.status(run.status ?? 500).json({ error: run.error }); return; }
    const file = run.files[index];
    if (!file) { res.status(404).json({ error: 'No such file in this run' }); return; }

    const cat = await getCatalog();
    const { gunzipSync } = await import('zlib');
    const nb = await import('./lib/ndbackup/index.js');
    const chunks: Uint8Array[] = [];
    for (const part of file.parts) {
      const e = cat.entries.find(x => x.id === part.entryId);
      const imagePath = e?.storage?.git?.imagePath;
      if (!imagePath) continue;
      const abs = resolve(ROOT_DIR, imagePath);
      if (!abs.startsWith(ROOT_DIR)) continue;
      const raw = new Uint8Array(gunzipSync(await readFile(abs)));
      const vol = nb.readBackupVolume(raw);
      const vf = vol.files[part.index];
      if (!vf) continue;
      chunks.push(nb.readBackupFile(raw, vf));
    }
    let data = Buffer.concat(chunks.map(c => Buffer.from(c)));
    if (String(req.query.parity ?? '') === 'strip') {
      const stripped = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) stripped[i] = data[i] & 0x7f;
      data = stripped;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    const safeName = file.fullName.replace(/:/g, '.').replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Disposition', 'inline; filename="' + safeName + '"');
    res.send(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// One file off a BACKUP-SYSTEM volume, by its sequence position in the listing.
app.get('/api/ndbackup/read-file', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const index = parseInt(String(req.query.index ?? '-1'), 10);
    if (!entryId || index < 0) { res.status(400).json({ error: 'Missing id or index' }); return; }
    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    const imagePath = entry?.storage?.git?.imagePath;
    if (!imagePath) { res.status(404).json({ error: 'Entry or image not found' }); return; }
    const abs = resolve(ROOT_DIR, imagePath);
    if (!abs.startsWith(ROOT_DIR)) { res.status(403).json({ error: 'Access denied' }); return; }

    const { gunzipSync } = await import('zlib');
    const nb = await import('./lib/ndbackup/index.js');
    const raw = new Uint8Array(gunzipSync(await readFile(abs)));
    if (!nb.isBackupVolume(raw)) { res.status(422).json({ error: 'Not a BACKUP-SYSTEM volume' }); return; }
    const vol = nb.readBackupVolume(raw);
    const file = vol.files[index];
    if (!file) { res.status(404).json({ error: 'No such file on this volume' }); return; }

    let data = nb.readBackupFile(raw, file);
    if (String(req.query.parity ?? '') === 'strip') {
      const stripped = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) stripped[i] = data[i] & 0x7f;
      data = stripped;
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    // SINTRAN writes NAME:TYPE, but a colon is illegal in a Windows filename -
    // the browser silently truncates "LISTA:SYMB" to ".SYMB". Save as LISTA.SYMB.
    const safeName = file.fullName.replace(/:/g, '.').replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('Content-Disposition', 'inline; filename="' + safeName + '"');
    res.send(Buffer.from(data));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Detect which filesystem an image holds and record it. Runs on one entry
// (?id=) or over the whole catalog (?scope=missing|all). Re-runnable: an image
// the NDFS parser rejected may still be a DOS floppy or a tar, and this is how
// that gets established after the fact.
app.post('/api/detect-filesystem', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const scope = String(req.query.scope ?? '');
    const cat = await getCatalog();
    const { detectFilesystem, readDosLabel, readBackupSet, readBackupFiles, readDosFiles } = await import('./api/filesystem-detect.js');
    const { gunzipSync } = await import('zlib');

    let targets = cat.entries;
    if (entryId) {
      targets = cat.entries.filter(e => e.id === entryId);
      if (!targets.length) { res.status(404).json({ error: 'Entry not found' }); return; }
    } else if (scope === 'missing') {
      targets = cat.entries.filter(e => !e.filesystem);
    } else if (scope !== 'all') {
      res.status(400).json({ error: 'Pass ?id=<entryId> or ?scope=missing|all' }); return;
    }

    const counts: Record<string, number> = {};
    let scanned = 0, changed = 0, failed = 0;
    for (const e of targets) {
      const imagePath = e.storage?.git?.imagePath;
      if (!imagePath) continue;
      const abs = resolve(ROOT_DIR, imagePath);
      if (!abs.startsWith(ROOT_DIR)) continue;
      let kind: string;
      let label: string | null = null;
      let set: ReturnType<typeof readBackupSet> = null;
      let files: ReturnType<typeof readBackupFiles> = null;
      let dosFiles: ReturnType<typeof readDosFiles> = null;
      let recovered: DamagedAssessment | null = null;
      try {
        const raw = gunzipSync(await readFile(abs));
        const ndfsParsed = !!(e.volumeName || e.ndfs?.files?.length || e.ndfs?.users?.length);
        kind = detectFilesystem(raw, ndfsParsed);
        if (kind === 'dos') label = readDosLabel(raw);
        if (kind === 'winch' || kind === 'backup') set = readBackupSet(raw);
        if (kind === 'backup') files = readBackupFiles(raw);
        if (kind === 'dos') dosFiles = readDosFiles(raw);
        if (kind === 'none') recovered = await tryRecoverDamaged(raw, siblingFileNames(cat.entries, e));
      } catch { failed++; continue; }
      scanned++;
      counts[kind] = (counts[kind] ?? 0) + 1;
      const setChanged = JSON.stringify(set ?? null) !== JSON.stringify(e.backupSet ?? null) ||
                         JSON.stringify(files ?? null) !== JSON.stringify(e.backupFiles ?? null) ||
                         JSON.stringify(dosFiles ?? null) !== JSON.stringify(e.dosFiles ?? null);
      if (e.filesystem !== kind || (label && e.volumeLabel !== label) || setChanged) {
        e.filesystem = kind as any;
        if (label) e.volumeLabel = label;
        e.backupSet = set;
        e.backupFiles = files;
        e.dosFiles = dosFiles;
        if (recovered) {
          // ND material that the parser refuses: filed as the ND floppy it is,
          // with what could be read off it and how far that can be trusted.
          e.filesystem = 'ndfs';
          e.condition = recovered.condition;
          if (recovered.ndfs) e.ndfs = recovered.ndfs;
        } else if (kind !== 'none') {
          e.condition = null;
        }
        if (e.storage?.git?.yamlPath) await saveFloppyYaml(ROOT_DIR, e);
        changed++;
      }
    }
    if (changed > 0) { await persistCatalog(ROOT_DIR); catalog = null; }
    res.json({ scanned, changed, failed, counts });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Delete a floppy: remove its .img.gz / .yaml / disk photos from disk, then
// regenerate the catalog from YAML so it drops out. The change still has to be
// committed (a tracked floppy shows as a git deletion; an uncommitted import is
// simply gone). Safety: never delete outside images/; if more than one floppy
// shares the md5 folder, delete only this entry's own files, not the folder.
/**
 * The reads of every physical floppy, graded, worst disks first.
 *
 * ?filter=bad       disks where no read produced anything
 *        =semibad   disks rescued by one read, with failed attempts beside it
 *        =all       every disk that was read more than once
 */
app.get('/api/read-groups', async (req, res) => {
  try {
    const filter = String(req.query.filter ?? 'bad');
    const cat = await getCatalog();
    const { groupReads, describeGroup } = await import('./lib/readgroups/index.js');
    let groups = groupReads(cat.entries as any);
    if (filter === 'bad') groups = groups.filter(g => g.bad);
    else if (filter === 'semibad') groups = groups.filter(g => g.semiBad);
    else if (filter === 'multi') groups = groups.filter(g => g.reads.length > 1);
    res.json({
      total: groups.length,
      groups: groups.map(g => ({ ...g, summary: describeGroup(g) })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete('/api/catalog-entry', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    if (!entryId) { res.status(400).json({ error: 'Missing id query parameter' }); return; }

    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    if (!entry) { res.status(404).json({ error: 'Entry not found' }); return; }

    const git = entry.storage?.git;
    if (!git?.yamlPath) { res.status(400).json({ error: 'Entry has no file on disk to delete' }); return; }

    const imagesRoot = resolve(ROOT_DIR, 'images');
    const insideImages = (rel: string) => {
      const abs = resolve(ROOT_DIR, rel);
      return abs === imagesRoot || abs.startsWith(imagesRoot + sep) ? abs : null;
    };

    const folderRel = dirname(git.yamlPath);
    const folderAbs = insideImages(folderRel);
    if (!folderAbs || folderAbs === imagesRoot) {
      res.status(400).json({ error: `Refusing to delete outside an images/{md5} folder: ${folderRel}` });
      return;
    }

    // How many catalog entries live in this same folder?
    const siblings = cat.entries.filter(
      e => e.storage?.git?.yamlPath && dirname(e.storage.git.yamlPath) === folderRel
    );
    const wholeFolder = siblings.length <= 1;

    // Build the exact list of files that will be removed -- the .img.gz, .yaml,
    // photos, labels.txt, logs -- with sizes, so the UI can show it for approval.
    const plan: { path: string; bytes: number }[] = [];
    const addFile = async (rel: string) => {
      const abs = insideImages(rel);
      if (!abs) return;
      try { const s = await stat(abs); if (s.isFile()) plan.push({ path: rel, bytes: s.size }); } catch { /* gone */ }
    };
    if (wholeFolder) {
      // Sole occupant -> everything in the md5 folder.
      for (const name of await readdir(folderAbs)) await addFile(join(folderRel, name));
    } else {
      // Shared folder -> only this entry's own files (img, yaml, disk photos).
      for (const rel of [git.imagePath, git.yamlPath, ...(git.diskPhotos ?? [])].filter(Boolean) as string[]) await addFile(rel);
    }

    if (dryRun) {
      res.json({
        preview: true, id: entryId, volumeName: entry.volumeName, wholeFolder, folder: folderRel,
        files: plan, count: plan.length, totalBytes: plan.reduce((a, f) => a + f.bytes, 0),
      });
      return;
    }

    // Apply.
    if (wholeFolder) {
      await rm(folderAbs, { recursive: true, force: true });
    } else {
      for (const f of plan) { const abs = insideImages(f.path); if (abs) await rm(abs, { force: true }); }
    }
    await persistCatalog(ROOT_DIR);
    catalog = null;

    res.json({ success: true, deleted: entryId, removed: plan.map(f => f.path) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Catalog entry file upload
// ============================================================

// Attach photos/docs from a source folder to existing duplicate entries
app.post('/api/import/attach-artifacts', async (req, res) => {
  try {
    const { sourcePath, entryIds } = req.body as { sourcePath: string; entryIds: string[] };
    if (!sourcePath || !entryIds || entryIds.length === 0) {
      res.status(400).json({ error: 'sourcePath and entryIds are required' });
      return;
    }

    const { scanFolderArtifacts, copySetArtifacts, copyDiskPhotos } = await import('./api/import.js');
    const { saveFloppyYaml } = await import('./api/catalog.js');
    const cat = await getCatalog();

    // Find the entries
    const entries = entryIds.map(id => cat.entries.find(e => e.id === id)).filter(Boolean) as CatalogEntry[];
    if (entries.length === 0) {
      res.status(404).json({ error: 'No matching entries found' });
      return;
    }

    // Scan the source folder for artifacts
    const imgFiles = entries.map(e => {
      const p = e.storage?.git?.imagePath;
      return p ? basename(p).replace(/\.gz$/, '') : '';
    }).filter(Boolean);
    const volNames = entries.map(e => e.volumeName);
    const artifacts = await scanFolderArtifacts(sourcePath, imgFiles, volNames);

    let attached = 0;

    for (const entry of entries) {
      if (!entry.storage?.git) continue;
      const targetDir = dirname(entry.storage.git.imagePath);

      // Copy set photos/labels/logs
      if (artifacts.setPhotos.length > 0 || artifacts.transcription || artifacts.imagingLogs.length > 0) {
        const setResult = await copySetArtifacts(ROOT_DIR, sourcePath, targetDir, artifacts);
        // Merge into entry (don't replace, add new ones)
        const existingSet = new Set(entry.storage.git.setPhotos || []);
        for (const p of setResult.setPhotos) { if (!existingSet.has(p)) { entry.storage.git.setPhotos.push(p); } }
        if (setResult.labelTranscription && !entry.storage.git.labelTranscription) {
          entry.storage.git.labelTranscription = setResult.labelTranscription;
        }
        const existingLogs = new Set(entry.storage.git.imagingLogs || []);
        for (const l of setResult.imagingLogs) { if (!existingLogs.has(l)) { entry.storage.git.imagingLogs.push(l); } }
      }

      // Copy disk photos
      const imgBase = basename(entry.storage.git.imagePath).replace(/\.img\.gz$/, '.img');
      const myDiskPhotos = artifacts.diskPhotos.get(imgBase) ?? [];
      if (myDiskPhotos.length > 0) {
        const diskResult = await copyDiskPhotos(ROOT_DIR, sourcePath, targetDir, myDiskPhotos);
        const existingDisk = new Set(entry.storage.git.diskPhotos || []);
        for (const p of diskResult) { if (!existingDisk.has(p)) { entry.storage.git.diskPhotos.push(p); } }
      }

      await saveFloppyYaml(ROOT_DIR, entry);
      attached++;
    }

    await reloadAndRegenerate();
    res.json({ success: true, attached, entries: entries.map(e => e.id) });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post('/api/catalog-entry/upload', upload.single('file'), async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    if (!entryId) {
      res.status(400).json({ error: 'Missing id query parameter' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const fileType = String(req.body.type ?? 'documentation');
    const validTypes = ['disk-photo', 'set-photo', 'imaging-log', 'documentation'];
    if (!validTypes.includes(fileType)) {
      res.status(400).json({ error: 'Invalid type. Must be one of: ' + validTypes.join(', ') });
      return;
    }

    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    // Determine destination folder from the entry's git storage path
    let batchDir: string;
    if (entry.storage?.git?.imagePath) {
      // e.g. images/62caae43d67b7bfedb18bf17dc079e0d/10079M07-NO-01S.img.gz
      const imgDir = dirname(entry.storage.git.imagePath);
      batchDir = resolve(ROOT_DIR, imgDir);
    } else {
      res.status(400).json({ error: 'Entry has no git storage path, cannot determine upload folder' });
      return;
    }

    if (!existsSync(batchDir)) {
      mkdirSync(batchDir, { recursive: true });
    }

    // Determine filename
    const origName = req.file.originalname || 'upload';
    const ext = extname(origName).toLowerCase();
    const safeName = basename(origName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const destPath = join(batchDir, safeName);

    // Copy temp file to destination
    await copyFile(req.file.path, destPath);

    // Update catalog entry based on type
    const relPath = destPath.substring(ROOT_DIR.length + 1); // relative to ROOT_DIR

    if (!entry.storage) {
      entry.storage = { git: null, internetArchive: null };
    }
    if (!entry.storage.git) {
      entry.storage.git = { imagePath: '', yamlPath: '', diskPhotos: [], setPhotos: [], imagingLogs: [] };
    }

    let photoChanged = false;
    if (fileType === 'disk-photo') {
      entry.storage.git.diskPhotos.push(relPath);
      photoChanged = true;
    } else if (fileType === 'set-photo') {
      entry.storage.git.setPhotos.push(relPath);
      photoChanged = true;
    } else if (fileType === 'imaging-log') {
      entry.storage.git.imagingLogs.push(relPath);
      photoChanged = true;
    }
    // documentation type: just save the file, no catalog reference needed

    // Persist the new photo reference to YAML (source of truth) -- otherwise it
    // is regenerated away on the next catalog rebuild and the file is orphaned.
    if (photoChanged && entry.storage?.git?.yamlPath) await saveFloppyYaml(ROOT_DIR, entry);

    await persistCatalog(ROOT_DIR);
    catalog = null;

    res.json({ success: true, path: relPath, type: fileType });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// NDFS viewer endpoints
// ============================================================

/**
 * A readable copy of a damaged floppy: the original bytes with the master block
 * pointers written back as the recovery worked them out.
 *
 * Built on the fly and never stored. The archive keeps only what came off the
 * physical disk, so the repaired image exists for as long as this response
 * takes and no longer.
 */
app.get('/api/ndfs/repaired', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    const rec = entry?.condition?.recovery;
    const imagePath = entry?.storage?.git?.imagePath;
    if (!entry || !imagePath) { res.status(404).json({ error: 'Entry or image not found' }); return; }
    if (!rec) { res.status(400).json({ error: 'No recovered layout for this image' }); return; }
    const abs = resolve(ROOT_DIR, imagePath);
    if (!abs.startsWith(ROOT_DIR)) { res.status(403).json({ error: 'Access denied' }); return; }

    const { applyLayout } = await import('./lib/ndfsrecover/index.js');
    const { gunzipSync } = await import('zlib');
    const raw = pageAlign(new Uint8Array(gunzipSync(await readFile(abs))));
    const repaired = applyLayout(raw, {
      object: { blockId: rec.layout.object, type: 1 },
      user: { blockId: rec.layout.user, type: 1 },
      bit: { blockId: rec.layout.bit, type: 0 },
    });
    const base = imagePath.split('/').pop()!.replace(/\.img\.gz$/, '').replace(/\.img$/, '');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${base}-repaired.img"`);
    res.send(Buffer.from(repaired));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/ndfs/raw', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    if (!entryId) {
      res.status(400).json({ error: 'Missing id parameter' });
      return;
    }

    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    const imagePath = entry.storage?.git?.imagePath;
    if (!imagePath) {
      res.status(404).json({ error: 'No image file for this entry' });
      return;
    }

    const filePath = resolve(ROOT_DIR, imagePath);

    // Security: ensure path is within repo
    if (!filePath.startsWith(ROOT_DIR)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const compressed = await readFile(filePath);

    // gunzip
    const { gunzipSync } = await import('zlib');
    const raw = gunzipSync(compressed);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(raw);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/ndfs/info', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    if (!entryId) {
      res.status(400).json({ error: 'Missing id parameter' });
      return;
    }

    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    const imagePath = entry.storage?.git?.imagePath;
    if (!imagePath) {
      res.status(404).json({ error: 'No image file for this entry' });
      return;
    }

    const filePath = resolve(ROOT_DIR, imagePath);
    if (!filePath.startsWith(ROOT_DIR)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const compressed = await readFile(filePath);
    const { gunzipSync } = await import('zlib');
    const raw = gunzipSync(compressed);

    const { NdfsFileSystem } = await import('../../externals/norskdata-ndfs/ndfs-ts/dist/index.js');
    const fs = new NdfsFileSystem(pageAlign(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)), true);

    const mb = fs.getMasterBlock();
    const users = fs.getUsers().map((u: any) => ({
      index: u.userIndex,
      name: u.userName,
      pagesReserved: u.pagesReserved,
      pagesUsed: u.pagesUsed,
    }));

    const bootFormat = fs.detectBootFormat();

    res.json({
      volumeName: mb.directoryName,
      totalPages: mb.imageSize,
      unreservedPages: mb.unreservedPages,
      bootFormat,
      users,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/ndfs/files', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const userName = req.query.user ? String(req.query.user) : null;
    if (!entryId) {
      res.status(400).json({ error: 'Missing id parameter' });
      return;
    }

    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    const imagePath = entry.storage?.git?.imagePath;
    if (!imagePath) {
      res.status(404).json({ error: 'No image file for this entry' });
      return;
    }

    const filePath = resolve(ROOT_DIR, imagePath);
    if (!filePath.startsWith(ROOT_DIR)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const compressed = await readFile(filePath);
    const { gunzipSync } = await import('zlib');
    const raw = gunzipSync(compressed);

    const { NdfsFileSystem } = await import('../../externals/norskdata-ndfs/ndfs-ts/dist/index.js');
    const { ndTimeToDate } = await import('../../externals/norskdata-ndfs/ndfs-ts/dist/nd-time.js');
    const fs = new NdfsFileSystem(pageAlign(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)), true);

    const objects = fs.getObjectEntries();
    const files = objects
      .filter((obj: any) => !userName || obj.userName === userName)
      .map((obj: any) => {
        const dateCreated = ndTimeToDate(obj.dateCreated);
        const lastDateWritten = ndTimeToDate(obj.lastDateWritten);

        // BPUN checksum validation
        let bpunValid: boolean | null = null;
        if (obj.type === 'BPUN') {
          try {
            const fileData = fs.readFile(`${obj.userName}/${obj.objectName}:${obj.type}`);
            if (fileData && fileData.length >= 10) {
              // Find the '!' marker (0x21 or 0xA1 with parity) that starts binary data
              let bangOff = -1;
              for (let i = 0; i < fileData.length; i++) {
                if (fileData[i] === 0x21 || (fileData[i] & 0x7F) === 0x21) {
                  bangOff = i;
                  break;
                }
              }

              // After '!': address(2), count(2), data(count*2), checksum(2), action(2)
              let dataOff = bangOff >= 0 ? bangOff + 1 : 0;

              if (dataOff + 4 <= fileData.length) {
                const address = (fileData[dataOff] << 8) | fileData[dataOff + 1];
                const count = (fileData[dataOff + 2] << 8) | fileData[dataOff + 3];

                if (count > 0) {
                  const wordsStart = dataOff + 4;
                  const wordsEnd = wordsStart + count * 2;
                  if (wordsEnd + 2 <= fileData.length) {
                    let calcSum = 0;
                    for (let i = wordsStart; i < wordsEnd; i += 2) {
                      calcSum = (calcSum + ((fileData[i] << 8) | fileData[i + 1])) & 0xFFFF;
                    }
                    const storedChecksum = (fileData[wordsEnd] << 8) | fileData[wordsEnd + 1];
                    bpunValid = (calcSum === storedChecksum);
                  }
                }
              }
            }
          } catch { /* ignore parse errors */ }
        }

        return {
          name: obj.objectName,
          type: obj.type,
          fullName: obj.fullName,
          userName: obj.userName,
          userIndex: obj.userIndex,
          pages: obj.pagesInFile,
          bytes: obj.bytesInFile,
          fileType: obj.fileTypeAsText,
          dateCreated: dateCreated ? dateCreated.toISOString() : null,
          lastDateWritten: lastDateWritten ? lastDateWritten.toISOString() : null,
          bpunValid,
        };
      });

    files.sort((a: any, b: any) => a.fullName.localeCompare(b.fullName));

    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/ndfs/read-file', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const filePath2 = String(req.query.file ?? '');
    const parity = String(req.query.parity ?? 'none');
    if (!entryId || !filePath2) {
      res.status(400).json({ error: 'Missing id or file parameter' });
      return;
    }

    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    const imagePath = entry.storage?.git?.imagePath;
    if (!imagePath) {
      res.status(404).json({ error: 'No image file for this entry' });
      return;
    }

    const diskPath = resolve(ROOT_DIR, imagePath);
    if (!diskPath.startsWith(ROOT_DIR)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const compressed = await readFile(diskPath);
    const { gunzipSync } = await import('zlib');
    const raw = gunzipSync(compressed);

    const { NdfsFileSystem } = await import('../../externals/norskdata-ndfs/ndfs-ts/dist/index.js');
    const fs = new NdfsFileSystem(pageAlign(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)), true);

    const parityMode = parity === 'strip' ? 'strip' : 'none';
    const data = fs.readFile(filePath2, parityMode as any);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(data));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/ndfs/hex', async (req, res) => {
  try {
    const entryId = String(req.query.id ?? '');
    const filePath2 = String(req.query.file ?? '');
    const offset = parseInt(String(req.query.offset ?? '0'), 10);
    const length = Math.min(parseInt(String(req.query.length ?? '512'), 10), 8192);
    if (!entryId || !filePath2) {
      res.status(400).json({ error: 'Missing id or file parameter' });
      return;
    }

    const cat = await getCatalog();
    const entry = cat.entries.find(e => e.id === entryId);
    if (!entry) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }

    const imagePath = entry.storage?.git?.imagePath;
    if (!imagePath) {
      res.status(404).json({ error: 'No image file for this entry' });
      return;
    }

    const diskPath = resolve(ROOT_DIR, imagePath);
    if (!diskPath.startsWith(ROOT_DIR)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const compressed = await readFile(diskPath);
    const { gunzipSync } = await import('zlib');
    const raw = gunzipSync(compressed);

    const { NdfsFileSystem } = await import('../../externals/norskdata-ndfs/ndfs-ts/dist/index.js');
    const fs = new NdfsFileSystem(pageAlign(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)), true);

    const data = fs.readFile(filePath2);
    const totalSize = data.length;
    const slice = data.slice(offset, offset + length);

    // Build hex dump
    const lines: string[] = [];
    const bytesPerLine = 16;
    for (let i = 0; i < slice.length; i += bytesPerLine) {
      const lineBytes = Math.min(bytesPerLine, slice.length - i);
      let hex = '';
      let ascii = '';
      for (let j = 0; j < bytesPerLine; j++) {
        if (j < lineBytes) {
          hex += slice[i + j].toString(16).padStart(2, '0') + ' ';
          const b = slice[i + j] & 0x7f;
          ascii += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.';
        } else {
          hex += '   ';
          ascii += ' ';
        }
        if (j === 7) hex += ' ';
      }
      lines.push((offset + i).toString(16).padStart(8, '0') + '  ' + hex + ' |' + ascii + '|');
    }

    res.json({
      totalSize,
      offset,
      length: slice.length,
      hex: lines.join('\n'),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// File serving
// ============================================================

// Serve image files from images/ directory
// Photo cache-busting versions: repo-relative path -> file mtime. The UI loads
// this once and appends ?v=<version> to every photo URL, so an edited photo
// (new mtime) gets a fresh immutable URL without any revalidation.
app.get('/api/photo-versions', async (_req, res) => {
  try {
    const out: Record<string, number> = {};
    for (const root of ['images', 'collections']) {
      const base = resolve(ROOT_DIR, root);
      let dirs: string[];
      try { dirs = await readdir(base); } catch { continue; }
      for (const d of dirs) {
        const sub = join(base, d);
        try { if (!(await stat(sub)).isDirectory()) continue; } catch { continue; }
        let files: string[];
        try { files = await readdir(sub); } catch { continue; }
        for (const f of files) {
          if (!/\.(jpe?g|png)$/i.test(f)) continue;
          try { out[`${root}/${d}/${f}`] = Math.round((await stat(join(sub, f))).mtimeMs); } catch { /* skip */ }
        }
      }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get('/api/images/{*imgpath}', async (req, res) => {
  try {
    // Get the path after /api/images/
    const params = req.params as Record<string, string | string[]>;
    const paramPath = params['imgpath'] ?? '';
    const requestedPath = Array.isArray(paramPath) ? paramPath.join('/') : String(paramPath);
    const filePath = resolve(ROOT_DIR, 'images', requestedPath);

    // Security: ensure path is within images/
    if (!filePath.startsWith(resolve(ROOT_DIR, 'images'))) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const s = await stat(filePath);
    if (!s.isFile()) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Best practice: photo URLs are versioned (?v=<mtime>), so each version is a
    // distinct immutable resource -- cache it forever, no revalidation needed.
    // A changed photo gets a new ?v from /api/photo-versions and is fetched fresh.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    if (filePath.endsWith('.img.gz')) {
      res.setHeader('Content-Type', 'application/gzip');
    } else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) {
      res.setHeader('Content-Type', 'image/jpeg');
    } else if (filePath.endsWith('.png')) {
      res.setHeader('Content-Type', 'image/png');
    }

    const data = await readFile(filePath);
    res.send(data);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// Serve group-folder files (set photos / transcriptions shared per product+version)
app.get('/api/collections/{*cpath}', async (req, res) => {
  try {
    const params = req.params as Record<string, string | string[]>;
    const paramPath = params['cpath'] ?? '';
    const requestedPath = Array.isArray(paramPath) ? paramPath.join('/') : String(paramPath);
    const filePath = resolve(ROOT_DIR, 'collections', requestedPath);
    if (!filePath.startsWith(resolve(ROOT_DIR, 'collections'))) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    const s = await stat(filePath);
    if (!s.isFile()) { res.status(404).json({ error: 'Not found' }); return; }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (/\.jpe?g$/i.test(filePath)) res.setHeader('Content-Type', 'image/jpeg');
    else if (filePath.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
    res.send(await readFile(filePath));
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// Save a rotated label photo back to disk. The browser re-encodes the image to
// a canvas-rotated JPEG and posts the bytes; we validate the target is an
// existing image inside images/ and overwrite it. No server-side image library.
app.post('/api/images/save-rotation', upload.single('image'), async (req, res) => {
  try {
    const relPath = String((req.body as { path?: string }).path ?? '').trim();
    if (!relPath || !req.file) {
      res.status(400).json({ error: 'path and image are required' });
      return;
    }
    const imagesRoot = resolve(ROOT_DIR, 'images');
    const collsRoot = resolve(ROOT_DIR, 'collections');
    const target = resolve(ROOT_DIR, relPath);
    const inside = (root: string) => target === root || target.startsWith(root + sep);
    if (!inside(imagesRoot) && !inside(collsRoot)) {
      res.status(403).json({ error: 'Path must be inside images/ or collections/' });
      return;
    }
    if (!/\.(jpe?g|png)$/i.test(target)) {
      res.status(400).json({ error: 'Target is not an image file' });
      return;
    }
    const st = await stat(target).catch(() => null);
    if (!st || !st.isFile()) {
      res.status(404).json({ error: 'Image not found' });
      return;
    }
    const data = await readFile(req.file.path);
    await writeFile(target, data);
    const { unlink } = await import('fs/promises');
    await unlink(req.file.path).catch(() => { /* temp cleanup best-effort */ });
    const newVersion = Math.round((await stat(target)).mtimeMs); // for versioned-URL cache bust
    res.json({ success: true, path: relPath, bytes: data.length, version: newVersion });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Serve favicon
app.get('/favicon.ico', async (_req, res) => {
  const paths = [
    resolve(__dirname, '..', 'src', 'ui', 'favicon.ico'),
    resolve(__dirname, 'ui', 'favicon.ico'),
  ];
  for (const p of paths) {
    try {
      const data = await readFile(p);
      res.setHeader('Content-Type', 'image/x-icon');
      res.send(data);
      return;
    } catch { /* try next */ }
  }
  res.status(404).end();
});

// Serve the web UI
app.get('/', async (_req, res) => {
  try {
    // Try to serve from src/ui/ first (for development), then from dist/ui/
    const uiPaths = [
      resolve(__dirname, '..', 'src', 'ui', 'index.html'),
      resolve(__dirname, 'ui', 'index.html'),
    ];

    for (const uiPath of uiPaths) {
      try {
        const html = await readFile(uiPath, 'utf-8');
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
        return;
      } catch {
        // Try next path
      }
    }

    res.status(500).send('UI file not found');
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ============================================================
// Start server
// ============================================================

app.listen(PORT, () => {
  console.log(`Norsk Data Software Archive UI running at http://localhost:${PORT}`);
  console.log(`Repository root: ${ROOT_DIR}`);
});
