/**
 * Catalog read/write operations for the Norsk Data Software Archive.
 *
 * YAML files next to images are the source of truth.
 * JSON files in catalog/ are generated for API/UI consumption.
 */

import { readFile, writeFile, readdir, stat, mkdir, copyFile, unlink } from 'fs/promises';
import { join, relative, dirname, basename } from 'path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { glob } from 'glob';
import type { Catalog, CatalogEntry, Product, ProductDocs, Collection } from '../types.js';
import { matchProduct } from './product-matcher.js';

const FLOPPIES_FILE = 'catalog/floppies.json';
const PRODUCTS_FILE = 'catalog/products.json';
const LEGACY_FILE = 'catalog/legacy.json';
const PRODUCTS_DIR = 'products';
const COLLECTIONS_DIR = 'collections';

// ── Product YAML operations ──────────────────────────────────

/** Read the docs: block of a product YAML, dropping anything malformed. */
function readProductDocs(raw: unknown): ProductDocs | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : undefined;
  const productInfo = list(d.productInfo);
  const installationDescription = list(d.installationDescription);
  if (!productInfo?.length && !installationDescription?.length) return undefined;
  return {
    ...(productInfo?.length ? { productInfo } : {}),
    ...(installationDescription?.length ? { installationDescription } : {}),
  };
}

/**
 * Load products by scanning products/*.yaml files.
 */
export async function loadProducts(rootDir: string): Promise<Product[]> {
  const productsDir = join(rootDir, PRODUCTS_DIR);
  const products: Product[] = [];

  try {
    const files = await readdir(productsDir);
    for (const f of files) {
      if (!f.endsWith('.yaml')) continue;
      try {
        const raw = await readFile(join(productsDir, f), 'utf-8');
        const doc = yamlParse(raw);
        if (doc && doc.id && doc.name) {
          products.push({
            id: doc.id,
            name: doc.name,
            description: doc.description ?? null,
            siblingId: doc.siblingId ?? null,
            categories: Array.isArray(doc.categories) ? doc.categories : undefined,
            platform: Array.isArray(doc.platform) ? doc.platform : undefined,
            docs: readProductDocs(doc.docs),
          });
        }
      } catch {
        // Skip malformed YAML
      }
    }
  } catch {
    // products/ dir may not exist yet
  }

  products.sort((a, b) => a.id.localeCompare(b.id));
  return products;
}

/**
 * Save a single product YAML file.
 */
export async function saveProductYaml(
  rootDir: string,
  id: string,
  updates: { name?: string; description?: string | null; siblingId?: string | null; categories?: string[]; platform?: string[] }
): Promise<void> {
  const productsDir = join(rootDir, PRODUCTS_DIR);
  await mkdir(productsDir, { recursive: true });

  // Read existing to preserve fields not being updated
  const filePath = join(productsDir, `${id}.yaml`);
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(filePath, 'utf-8');
    existing = yamlParse(raw) ?? {};
  } catch { /* file may not exist */ }

  const doc: Record<string, unknown> = { id };
  doc.name = updates.name ?? existing.name ?? id;
  if (updates.description !== undefined) { if (updates.description) doc.description = updates.description; }
  else if (existing.description) doc.description = existing.description;
  if (updates.siblingId !== undefined) { if (updates.siblingId) doc.siblingId = updates.siblingId; }
  else if (existing.siblingId) doc.siblingId = existing.siblingId;
  if (updates.categories !== undefined) { if (updates.categories.length > 0) doc.categories = updates.categories; }
  else if (Array.isArray(existing.categories) && (existing.categories as string[]).length > 0) doc.categories = existing.categories;
  if (updates.platform !== undefined) { if (updates.platform.length > 0) doc.platform = updates.platform; }
  else if (Array.isArray(existing.platform) && (existing.platform as string[]).length > 0) doc.platform = existing.platform;
  // docs: is never edited through this path, but it must survive it - otherwise a
  // product edit in the web UI drops the ND document references written by hand.
  if (existing.docs) doc.docs = existing.docs;

  const yamlStr = yamlStringify(doc, { lineWidth: 0 });
  await writeFile(filePath, yamlStr, 'utf-8');
}

// ── Legacy loadProducts/saveProducts (for backward compat) ───

/**
 * Save products to JSON (for backward compatibility / generated output).
 */
export async function saveProducts(
  rootDir: string,
  products: Array<{ Id: string; Name: string }>
): Promise<void> {
  // Write both YAML (source of truth) and JSON (generated)
  for (const p of products) {
    await saveProductYaml(rootDir, p.Id, { name: p.Name });
  }
  const filePath = join(rootDir, PRODUCTS_FILE);
  const json = JSON.stringify(products, null, 2) + '\n';
  await writeFile(filePath, json, 'utf-8');
}

// ── Floppy YAML operations ───────────────────────────────────

/**
 * Convert a CatalogEntry to a YAML-friendly object for writing next to the image.
 */
function entryToYamlDoc(entry: CatalogEntry, rootDir: string): Record<string, unknown> {
  const yamlDir = entry.storage?.git?.yamlPath
    ? dirname(join(rootDir, entry.storage.git.yamlPath))
    : null;

  const doc: Record<string, unknown> = {
    id: entry.id,
    volumeName: entry.volumeName,
    md5: entry.md5,
  };

  // Product info
  if (entry.productId || entry.version || entry.systemNumber || entry.diskNumber || entry.diskTotal) {
    const product: Record<string, unknown> = {};
    if (entry.productId) product.id = entry.productId;
    if (entry.version) product.version = entry.version;
    // System number: only the early SINTRAN III OS distributions carry one
    // (the "N-<system no>-I..IV" floppy naming of ND-10174-10-EN).
    if (entry.systemNumber) product.systemNumber = entry.systemNumber;
    if (entry.diskNumber !== null) product.diskNumber = entry.diskNumber;
    if (entry.diskTotal !== null) product.diskTotal = entry.diskTotal;
    // Parse language from volume name if available
    if (entry.volumeName) {
      const pm = matchProduct(entry.volumeName);
      if (pm?.language) product.language = pm.language;
    }
    doc.product = product;
  }

  // Image info
  const image: Record<string, unknown> = {};
  if (entry.imageSizeBytes !== null) image.sizeBytes = entry.imageSizeBytes;
  if (entry.imageFormat) image.format = entry.imageFormat;
  if (entry.controller) image.controller = entry.controller;
  if (entry.totalPages !== null) image.totalPages = entry.totalPages;
  if (entry.pageSize !== null) image.pageSize = entry.pageSize;
  if (entry.bootFormat) image.bootFormat = entry.bootFormat;
  if (entry.bootProgram) image.bootProgram = entry.bootProgram;
  if (Object.keys(image).length > 0) doc.image = image;

  // Top-level fields that yamlDocToEntry reads from doc.* directly. Without
  // these writes they are read-but-never-written and silently lost on every
  // round-trip (regenerate-from-YAML), e.g. an edited mediaRole reverting.
  if (entry.mediaRole) doc.mediaRole = entry.mediaRole;
  if (entry.filesystem) doc.filesystem = entry.filesystem;
  if (entry.volumeLabel) doc.volumeLabel = entry.volumeLabel;
  if (entry.backupSet) doc.backupSet = { ...entry.backupSet };
  if (entry.backupFiles?.length) doc.backupFiles = entry.backupFiles.map(f => ({ ...f }));
  if (entry.condition) doc.condition = { ...entry.condition };
  if (entry.dosFiles?.length) doc.dosFiles = entry.dosFiles.map(f => ({ ...f }));
  if (entry.cpuTarget) doc.cpuTarget = entry.cpuTarget;
  if (entry.osRequirement) doc.osRequirement = entry.osRequirement;

  // NDFS data
  if (entry.ndfs) {
    doc.ndfs = entry.ndfs;
  }

  // Provenance
  if (entry.provenance) {
    doc.provenance = {
      contributor: entry.provenance.contributor,
      ...(entry.provenance.originalPath ? { originalPath: entry.provenance.originalPath } : {}),
      ...(entry.provenance.method ? { method: entry.provenance.method } : {}),
      ...(entry.provenance.dateImaged ? { dateImaged: entry.provenance.dateImaged } : {}),
      ...(entry.provenance.notes ? { notes: entry.provenance.notes } : {}),
      ...(entry.importedAt ? { importedAt: entry.importedAt } : {}),
    };
  }

  // Photos. Disk photos always live in the floppy YAML. Set photos normally
  // belong to the product+version GROUP folder (collections/{slug}/) and are
  // attached at load time -- but a freshly imported set photo physically sits
  // in THIS floppy's own folder until consolidateGroupPhotos moves it. We must
  // record those so consolidation can pick them up; group-attached set photos
  // (which live under collections/, i.e. outside this folder) are NOT written
  // back here, so a re-save of an already-consolidated entry stays clean.
  const photos: Record<string, unknown> = { disk: [], set: [] };
  const git = entry.storage?.git;
  if (yamlDir && git) {
    const dir = yamlDir;
    const inOwnFolder = (p: string) => {
      const rel = relative(dir, join(rootDir, p));
      return rel !== '' && !rel.startsWith('..');
    };
    if (git.diskPhotos?.length) {
      photos.disk = git.diskPhotos.map(p => relative(dir, join(rootDir, p)));
    }
    if (git.setPhotos?.length) {
      photos.set = git.setPhotos
        .filter(inOwnFolder)
        .map(p => relative(dir, join(rootDir, p)));
    }
    // Imaging logs (Greaseweazle read logs and the like) copied in beside the
    // image. Written so they are recorded rather than only showing up when
    // something lists the folder, e.g. a delete preview.
    if (git.imagingLogs?.length) {
      doc.imagingLogs = git.imagingLogs
        .filter(inOwnFolder)
        .map(p => relative(dir, join(rootDir, p)));
    }
  }
  doc.photos = photos;

  doc.tags = entry.tags ?? [];

  // Docs
  doc.docs = entry.docs ?? {
    piDocId: null,
    pdDocId: null,
    relatedDocIds: [],
    externalUrls: [],
  };

  // Legacy info
  if (entry.legacyId !== null) {
    doc.legacyId = entry.legacyId;
  }
  if (entry.legacyRefs) {
    doc.legacyRefs = entry.legacyRefs;
  }
  if (entry.storageClass) {
    doc.storageClass = entry.storageClass;
  }
  if (entry.storage?.internetArchive) {
    doc.internetArchive = entry.storage.internetArchive;
  }

  return doc;
}

/**
 * Parse a YAML doc (from a file next to an image) back into a CatalogEntry.
 */
function yamlDocToEntry(doc: Record<string, unknown>, yamlRelPath: string, rootDir: string): CatalogEntry {
  const yamlAbsDir = dirname(join(rootDir, yamlRelPath));
  const product = doc.product as Record<string, unknown> | undefined;
  const image = doc.image as Record<string, unknown> | undefined;
  const prov = doc.provenance as Record<string, unknown> | undefined;
  const photos = doc.photos as Record<string, unknown> | undefined;
  const ndfs = doc.ndfs as { users: any[]; files: any[] } | undefined;
  const docsObj = doc.docs as Record<string, unknown> | undefined;
  const ia = doc.internetArchive as Record<string, unknown> | undefined;

  // Resolve relative photo paths to repo-relative paths
  const diskPhotoRels = (photos?.disk as string[] | undefined) ?? [];
  const setPhotoRels = (photos?.set as string[] | undefined) ?? [];
  const labelTransRel = photos?.labelTranscription as string | undefined;

  const diskPhotos = diskPhotoRels.map(p => relative(rootDir, join(yamlAbsDir, p)));
  const setPhotos = setPhotoRels.map(p => relative(rootDir, join(yamlAbsDir, p)));
  const labelTranscription = labelTransRel
    ? relative(rootDir, join(yamlAbsDir, labelTransRel))
    : null;

  const imagingLogs = ((doc.imagingLogs as string[] | undefined) ?? [])
    .map(p => relative(rootDir, join(yamlAbsDir, p)));

  // Determine imagePath from YAML file location (same name but .img.gz)
  const yamlBaseName = basename(yamlRelPath, '.yaml');
  const imgGzPath = join(dirname(yamlRelPath), yamlBaseName + '.img.gz');

  const entry: CatalogEntry = {
    schemaVersion: '1.0',
    id: String(doc.id ?? ''),
    type: 'floppy',
    md5: String(doc.md5 ?? ''),
    volumeName: doc.volumeName as string | null ?? null,
    productId: product?.id as string | null ?? null,
    version: product?.version as string | null ?? null,
    systemNumber: product?.systemNumber as string | null ?? null,
    diskNumber: product?.diskNumber as number | null ?? null,
    diskTotal: product?.diskTotal as number | null ?? null,
    mediaRole: doc.mediaRole as string | null ?? null,
    storageClass: doc.storageClass as any ?? 'floppy-in-git',
    imageSizeBytes: image?.sizeBytes as number | null ?? null,
    imageFormat: image?.format as string ?? 'raw',
    controller: image?.controller as string | null ?? 'floppy',
    totalPages: image?.totalPages as number | null ?? null,
    pageSize: image?.pageSize as number | null ?? null,
    bootFormat: image?.bootFormat as string | null ?? null,
    bootProgram: image?.bootProgram as string | null ?? null,
    cpuTarget: doc.cpuTarget as string[] | null ?? null,
    osRequirement: doc.osRequirement as string | null ?? null,
    ndfs: ndfs ?? null,
    filesystem: (doc.filesystem as any) ?? null,
    volumeLabel: (doc.volumeLabel as string | null) ?? null,
    backupSet: (doc.backupSet as CatalogEntry['backupSet']) ?? null,
    backupFiles: (doc.backupFiles as CatalogEntry['backupFiles']) ?? null,
    condition: (doc.condition as CatalogEntry['condition']) ?? null,
    dosFiles: (doc.dosFiles as CatalogEntry['dosFiles']) ?? null,
    docs: docsObj ? {
      piDocId: docsObj.piDocId as string | null ?? null,
      pdDocId: docsObj.pdDocId as string | null ?? null,
      relatedDocIds: docsObj.relatedDocIds as string[] ?? [],
      externalUrls: docsObj.externalUrls as Array<{ url: string; title: string }> ?? [],
    } : null,
    provenance: prov ? {
      contributor: String(prov.contributor ?? 'unknown'),
      originalPath: prov.originalPath as string | undefined ?? undefined,
      method: prov.method as string | undefined ?? undefined,
      dateImaged: prov.dateImaged as string | undefined ?? undefined,
      notes: prov.notes as string | undefined ?? undefined,
    } : null,
    storage: {
      git: {
        imagePath: imgGzPath,
        yamlPath: yamlRelPath,
        diskPhotos,
        setPhotos,
        labelTranscription,
        imagingLogs,
      },
      internetArchive: ia ? {
        itemId: String(ia.itemId ?? ''),
        syncStatus: ia.syncStatus as any ?? 'pending',
      } : { itemId: `norskdata-floppy-${doc.id}`, syncStatus: 'pending' },
    },
    variants: null,
    fluxPreservation: null,
    legacyId: doc.legacyId as number | null ?? null,
    legacyRefs: doc.legacyRefs as any ?? null,
    importedAt: prov?.importedAt as string | null ?? null,
    tags: doc.tags as string[] | null ?? null,
  };

  return entry;
}

/**
 * Save a single floppy YAML file next to its image.
 */
export async function saveFloppyYaml(rootDir: string, entry: CatalogEntry): Promise<void> {
  const yamlPath = entry.storage?.git?.yamlPath;
  if (!yamlPath) {
    throw new Error(`Entry ${entry.id} has no yamlPath`);
  }

  const absPath = join(rootDir, yamlPath);
  await mkdir(dirname(absPath), { recursive: true });

  const doc = entryToYamlDoc(entry, rootDir);
  const yamlStr = yamlStringify(doc, { lineWidth: 0 });
  await writeFile(absPath, yamlStr, 'utf-8');
}

// ── Group folders (set-level photos shared per product+version) ──

interface GroupInfo { slug: string; setPhotos: string[]; labelTranscription: string | null }

/**
 * Load product+version groups from collections/{slug}/group.yaml.
 * Each group owns the set photos shared by all disks of that product+version,
 * stored once (instead of copied into every disk folder). Keyed by
 * "productId|version". Paths are returned repo-relative (collections/{slug}/x).
 */
export async function loadGroups(rootDir: string): Promise<Map<string, GroupInfo>> {
  const groups = new Map<string, GroupInfo>();
  const dir = join(rootDir, COLLECTIONS_DIR);
  let names: string[];
  try { names = await readdir(dir); } catch { return groups; }
  for (const name of names) {
    const gy = join(dir, name, 'group.yaml');
    try {
      const doc = yamlParse(await readFile(gy, 'utf-8'));
      if (!doc || !doc.productId) continue;
      const base = `${COLLECTIONS_DIR}/${name}`;
      groups.set(`${doc.productId}|${doc.version ?? ''}`, {
        slug: name,
        setPhotos: Array.isArray(doc.photos) ? doc.photos.map((p: string) => `${base}/${p}`) : [],
        labelTranscription: doc.labelTranscription ? `${base}/${doc.labelTranscription}` : null,
      });
    } catch { /* not a group folder */ }
  }
  return groups;
}

const groupSlug = (pid: string, ver: string) =>
  `${pid}-${ver}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Move set photos (and set-level transcription) out of per-disk images/{md5}/
 * folders into the shared product+version group folder (collections/{slug}/),
 * stored once, and clear photos.set from the floppy YAMLs. Idempotent -- a no-op
 * once nothing has photos.set. Run after import so new imports don't re-duplicate.
 * For a photo that diverged across copies (e.g. a rotation that hit one copy),
 * the newest copy by mtime is kept canonical so manual rotations aren't lost.
 */
export async function consolidateGroupPhotos(rootDir: string): Promise<number> {
  const imagesDir = join(rootDir, 'images');
  interface G { pid: string; ver: string; photos: Map<string, string[]>; trans: Map<string, string[]>; members: Set<string> }
  const groups = new Map<string, G>();
  let yamlFiles: string[];
  try { yamlFiles = await glob('**/*.yaml', { cwd: imagesDir }); } catch { return 0; }
  for (const yf of yamlFiles) {
    const abs = join(imagesDir, yf);
    let doc: any;
    try { doc = yamlParse(await readFile(abs, 'utf-8')); } catch { continue; }
    const p = doc?.product ?? {};
    const photos = doc?.photos ?? {};
    const setp: string[] = photos.set ?? [];
    const trans: string | undefined = photos.labelTranscription;
    if (!p.id || (!setp.length && !trans)) continue;
    const ver = p.version ?? '';
    const key = `${p.id}|${ver}`;
    if (!groups.has(key)) groups.set(key, { pid: p.id, ver, photos: new Map(), trans: new Map(), members: new Set() });
    const g = groups.get(key)!;
    g.members.add(abs);
    const dir = dirname(abs);
    for (const ph of setp) { if (!g.photos.has(ph)) g.photos.set(ph, []); g.photos.get(ph)!.push(join(dir, ph)); }
    if (trans) { if (!g.trans.has(trans)) g.trans.set(trans, []); g.trans.get(trans)!.push(join(dir, trans)); }
  }
  if (groups.size === 0) return 0;

  const newest = async (paths: string[]): Promise<string | null> => {
    const ex: { p: string; m: number }[] = [];
    for (const p of paths) { try { ex.push({ p, m: (await stat(p)).mtimeMs }); } catch { /* gone */ } }
    ex.sort((a, b) => b.m - a.m);
    return ex[0]?.p ?? null;
  };

  let moved = 0;
  for (const g of groups.values()) {
    const slug = groupSlug(g.pid, g.ver);
    const gdir = join(rootDir, COLLECTIONS_DIR, slug);
    await mkdir(gdir, { recursive: true });
    let gdoc: any = { name: g.ver ? `${g.pid} ${g.ver}` : g.pid, productId: g.pid, photos: [] as string[] };
    if (g.ver) gdoc.version = g.ver;
    try { const ex = yamlParse(await readFile(join(gdir, 'group.yaml'), 'utf-8')); if (ex) gdoc = { ...gdoc, ...ex, photos: Array.isArray(ex.photos) ? ex.photos : [] }; } catch { /* new group */ }
    const photoSet = new Set<string>(gdoc.photos);
    for (const [fname, paths] of g.photos) {
      const canon = await newest(paths);
      if (!canon) continue;
      await copyFile(canon, join(gdir, fname));
      photoSet.add(fname);
      for (const p of paths) { await unlink(p).catch(() => { /* ignore */ }); moved++; }
    }
    gdoc.photos = Array.from(photoSet);
    for (const [fname, paths] of g.trans) {
      const canon = await newest(paths);
      if (!canon) continue;
      await copyFile(canon, join(gdir, fname));
      gdoc.labelTranscription = fname;
      for (const p of paths) { await unlink(p).catch(() => { /* ignore */ }); }
    }
    await writeFile(join(gdir, 'group.yaml'), yamlStringify(gdoc, { lineWidth: 0 }), 'utf-8');
    for (const yp of g.members) {
      let txt = await readFile(yp, 'utf-8');
      txt = txt.replace(/^(  set:)\n(    - .*\n)+/m, '$1 []\n');
      txt = txt.replace(/^  labelTranscription: .*\n/m, '');
      await writeFile(yp, txt, 'utf-8');
    }
  }
  return moved;
}

// ── Catalog loading (scan YAML files) ────────────────────────

/**
 * Load the full catalog by scanning images/**\/*.yaml files.
 * Also loads legacy entries from catalog/legacy.json.
 */
export async function loadCatalog(rootDir: string): Promise<Catalog> {
  const entries: CatalogEntry[] = [];

  // 1. Scan all YAML files in images/
  const imagesDir = join(rootDir, 'images');
  try {
    const yamlFiles = await glob('**/*.yaml', { cwd: imagesDir });
    for (const yamlFile of yamlFiles) {
      const yamlRelPath = join('images', yamlFile);
      try {
        const raw = await readFile(join(rootDir, yamlRelPath), 'utf-8');
        const doc = yamlParse(raw);
        if (doc && doc.id && doc.md5) {
          const entry = yamlDocToEntry(doc, yamlRelPath, rootDir);
          entries.push(entry);
        }
      } catch {
        // Skip malformed YAML
      }
    }
  } catch {
    // images/ may not exist
  }

  // 2. Load legacy entries (metadata-only, no .img.gz)
  try {
    const legacyPath = join(rootDir, LEGACY_FILE);
    const raw = await readFile(legacyPath, 'utf-8');
    const legacyEntries: CatalogEntry[] = JSON.parse(raw);
    entries.push(...legacyEntries);
  } catch {
    // No legacy file yet
  }

  // 3. Attach shared set photos from the product+version group folder
  const groups = await loadGroups(rootDir);
  for (const e of entries) {
    if (!e.productId || !e.storage?.git) continue;
    const g = groups.get(`${e.productId}|${e.version ?? ''}`);
    if (!g) continue;
    e.storage.git.setPhotos = g.setPhotos;
    if (g.labelTranscription) e.storage.git.labelTranscription = g.labelTranscription;
  }

  // Deterministic order. The YAML files are read in filesystem glob order, which
  // is not stable across machines/runs -- without this, every regenerate would
  // reshuffle catalog/floppies.json and every import PR would diff the whole
  // file. Sort by id so the generated JSON is stable and diffs show real changes.
  entries.sort((a, b) => a.id.localeCompare(b.id));

  return { entries };
}

/**
 * DANGER -- writes catalog/floppies.json directly from an in-memory array.
 *
 * Do NOT use this in the server or any import path. floppies.json must only ever
 * be produced from the YAML source of truth via generateCatalogJson()/
 * persistCatalog(); writing it from memory drops YAML-only fields (tags, set
 * photos, IA status) and can persist a stale/partial catalog -- this was the
 * source of an entire class of "I edited it but it reverted" bugs.
 *
 * The one-off legacy migration scripts that needed it have been removed.
 * Nothing may call it.
 */
export async function saveCatalog(rootDir: string, catalog: Catalog): Promise<void> {
  const filePath = join(rootDir, FLOPPIES_FILE);
  const json = JSON.stringify(catalog.entries, null, 2) + '\n';
  await writeFile(filePath, json, 'utf-8');
}

/**
 * Canonical "persist the catalog" operation. Run this after any change that
 * touches floppy YAML (import, product assignment, photo attach):
 *   1. consolidate freshly-imported set photos into their product GROUP folder
 *   2. regenerate catalog/floppies.json + catalog/products.json from YAML
 *
 * Always regenerating from the YAML source of truth (rather than writing an
 * in-memory snapshot) means the JSON can never drift to a partial/stale state.
 * This is the single call that replaces the old saveCatalog + generateCatalogJson
 * pair -- callers must have written their YAML changes first.
 */
export async function persistCatalog(rootDir: string): Promise<void> {
  await consolidateGroupPhotos(rootDir);
  await generateCatalogJson(rootDir);
}

/**
 * Generate catalog JSON files from scanned YAML data.
 * Writes catalog/floppies.json and catalog/products.json.
 */
export async function generateCatalogJson(rootDir: string): Promise<void> {
  const catalog = await loadCatalog(rootDir);
  const products = await loadProducts(rootDir);

  // Write catalog/floppies.json
  await mkdir(join(rootDir, 'catalog'), { recursive: true });
  const floppiesJson = JSON.stringify(catalog.entries, null, 2) + '\n';
  await writeFile(join(rootDir, FLOPPIES_FILE), floppiesJson, 'utf-8');

  // Write catalog/products.json (in the legacy { Id, Name } format)
  const productsJson = JSON.stringify(
    products.map(p => ({ Id: p.id, Name: p.name })),
    null,
    2
  ) + '\n';
  await writeFile(join(rootDir, PRODUCTS_FILE), productsJson, 'utf-8');
}

// ── Collection YAML operations ───────────────────────────────

/**
 * Load collections by scanning collections/*.yaml files.
 */
export async function loadCollections(rootDir: string): Promise<Collection[]> {
  const collectionsDir = join(rootDir, COLLECTIONS_DIR);
  const collections: Collection[] = [];

  try {
    const files = await readdir(collectionsDir);
    for (const f of files) {
      if (!f.endsWith('.yaml')) continue;
      try {
        const raw = await readFile(join(collectionsDir, f), 'utf-8');
        const doc = yamlParse(raw);
        if (doc && doc.name) {
          collections.push({
            name: doc.name,
            description: doc.description ?? '',
            items: doc.items ?? [],
          });
        }
      } catch {
        // Skip malformed YAML
      }
    }
  } catch {
    // collections/ may not exist
  }

  return collections;
}

// ── Query helpers ────────────────────────────────────────────

/**
 * Find a catalog entry by MD5 hash.
 */
export function findByMd5(catalog: Catalog, md5: string): CatalogEntry | undefined {
  const normalized = md5.toLowerCase();
  return catalog.entries.find(e => e.md5 === normalized);
}

/**
 * Find catalog entries by volume name (case-insensitive substring match).
 */
export function findByVolumeName(catalog: Catalog, name: string): CatalogEntry[] {
  const lower = name.toLowerCase();
  return catalog.entries.filter(e =>
    e.volumeName && e.volumeName.toLowerCase().includes(lower)
  );
}

/** OS distribution volume name pattern (e.g., N-10-203-I, N-900-188-A) */
const OS_DIST_PATTERN = /^(N-\d+-\d+(?:-\d+)?)-([A-Z])/i;

/** Patch volume name pattern */
const PATCH_PATTERN = /^((?:ND-)?PATCH[- ]?(?:SIN(?:TRAN)?[- ]?)?(?:\d+[- ]?)?(?:\S+)?)/i;

/**
 * Generate a content-derived ID from entry data.
 *
 * Naming strategies:
 * 1. ND product match: {productId}-{version}-d{disk}-{md5[:8]}
 * 2. OS distribution:  os-{distName}-{md5[:8]}
 * 3. Patch:            patch-{patchName}-{md5[:8]}
 * 4. Unknown:          img-{md5[:12]}
 */
export function generateId(md5: string, volumeName: string | null): string {
  // Strategy 1: ND product match
  const match = matchProduct(volumeName);
  if (match) {
    const disk = match.diskNumber ?? 1;
    const version = match.version ?? 'X';
    const productPart = match.productId.toLowerCase().replace(/[^a-z0-9]/g, '-');
    return `${productPart}-${version.toLowerCase()}-d${disk}-${md5.slice(0, 8)}`;
  }

  if (volumeName) {
    const trimmed = volumeName.trim();

    // Strategy 2: OS distribution
    const osDist = trimmed.match(OS_DIST_PATTERN);
    if (osDist) {
      const distName = osDist[1].toLowerCase().replace(/[^a-z0-9]/g, '-');
      return `os-${distName}-${osDist[2].toLowerCase()}-${md5.slice(0, 8)}`;
    }

    // Strategy 3: Patch
    const patchMatch = trimmed.match(PATCH_PATTERN);
    if (patchMatch) {
      const patchName = patchMatch[1].toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
      return `patch-${patchName}-${md5.slice(0, 8)}`;
    }
  }

  // Strategy 4: Unknown
  return `img-${md5.slice(0, 12)}`;
}
