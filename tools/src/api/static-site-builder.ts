/**
 * Static site generator for the Norsk Data Software Archive.
 * Produces a single self-contained site/index.html with all data
 * embedded as inline JSON. No fetch() calls, works with file:// protocol.
 */

import ts from 'typescript';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { marked } from 'marked';
import { join } from 'path';
import { parse as yamlParse } from 'yaml';
import { readdir } from 'fs/promises';
import { createHash } from 'crypto';
import type { CatalogEntry } from '../types.js';
import { generateCatalogJson } from './catalog.js';
import { DOC_DIRS, DOC_KIND_LABELS, docTitle } from './nd-docs.js';
import type { DocKind } from './nd-docs.js';

interface ProductData {
  id: string;
  name: string;
  description?: string | null;
  categories?: string[];
  platform?: string[];
  /** ND document ids; the files live in docs/nd/<collection>/<id>.md */
  docs?: { productInfo?: string[]; installationDescription?: string[] };
}

interface CategoryData {
  id: string;
  name: string;
  description: string;
}

/** Build the complete static site into site/index.html */
export async function buildStaticSite(rootDir: string): Promise<void> {
  const catalogPath = join(rootDir, 'catalog/floppies.json');
  const categoriesPath = join(rootDir, 'categories/product-categories.yaml');
  const productsDir = join(rootDir, 'products');
  const siteDir = join(rootDir, 'site');

  console.log('Regenerating catalog from YAML...');
  await generateCatalogJson(rootDir);

  console.log('Loading catalog...');
  const entries: CatalogEntry[] = JSON.parse(await readFile(catalogPath, 'utf-8'));

  console.log('Loading categories...');
  const categoriesRaw = yamlParse(await readFile(categoriesPath, 'utf-8')) as CategoryData[];

  console.log('Loading products...');
  const products: ProductData[] = [];
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
          categories: Array.isArray(doc.categories) ? doc.categories : undefined,
          platform: Array.isArray(doc.platform) ? doc.platform : undefined,
          docs: doc.docs && typeof doc.docs === 'object' ? {
            productInfo: Array.isArray(doc.docs.productInfo) ? doc.docs.productInfo : undefined,
            installationDescription: Array.isArray(doc.docs.installationDescription) ? doc.docs.installationDescription : undefined,
          } : undefined,
        });
      }
    } catch { /* skip malformed */ }
  }
  products.sort((a, b) => a.id.localeCompare(b.id));

  // Load NDFS browser library bundle
  console.log('Loading NDFS browser library...');
  let ndfsBundleJS = '';
  const bundlePaths = [
    join(rootDir, 'tools', 'ndfs-browser-bundle.js'),
    '/tmp/ndfs-browser.js',
  ];
  for (const bp of bundlePaths) {
    try {
      ndfsBundleJS = await readFile(bp, 'utf-8');
      console.log(`NDFS library loaded from ${bp} (${(ndfsBundleJS.length / 1024).toFixed(1)} KB)`);
      break;
    } catch { /* try next */ }
  }
  if (!ndfsBundleJS) {
    console.warn('WARNING: NDFS browser bundle not found -- NDFS viewer will be disabled');
  }

  // The dosfs and ndbackup libraries are plain ES modules with no imports, so
  // they can be inlined directly: strip the export keywords and publish the
  // entry points as globals, the same shape the NDFS bundle uses.
  //
  // They are compiled here from the TypeScript source rather than read out of
  // tools/dist. The Pages workflow runs this builder with tsx and never runs
  // npm run build, so dist does not exist on the runner - reading it left the
  // published site with no DOS or backup reader at all.
  let mediaLibsJS = '';
  for (const [rel, globals] of [
    ['src/lib/dosfs/index.ts', ['DosVolume', 'NotFatError']],
    ['src/lib/ndbackup/index.ts', ['isBackupVolume', 'readBackupVolume', 'readBackupFile', 'isWinchVolume', 'readWinchVolume', 'readWinchPage']],
    ['src/lib/backupsets/index.ts', ['groupBackupSets', 'backupSetFor', 'setKeyOf', 'describeSet', 'setVerdict']],
    ['src/lib/ndfsrecover/index.ts', ['applyLayout', 'readLayout', 'recoverNdfs', 'rawNameSet', 'describeRecovery']],
    ['src/lib/readgroups/index.ts', ['groupReads', 'gradeRead', 'diskOf', 'describeGroup']],
  ] as [string, string[]][]) {
    try {
      const tsSource = await readFile(join(rootDir, 'tools', rel), 'utf-8');
      const compiled = ts.transpileModule(tsSource, {
        compilerOptions: { target: ts.ScriptTarget.ES2019, module: ts.ModuleKind.ESNext, removeComments: false },
        fileName: rel,
      }).outputText;
      const plain = compiled
        .replace(/^export\s+default\s+.*$/gm, '')
        .replace(/^export\s+/gm, '');
      mediaLibsJS += '\n(function(){\n' + plain + '\n' +
        globals.map(g => `window.${g} = typeof ${g} !== 'undefined' ? ${g} : undefined;`).join('\n') +
        '\n})();\n';
    } catch {
      console.warn(`WARNING: ${rel} not found -- its viewer will be disabled in the static site`);
    }
  }
  console.log(`Media libraries inlined: ${(mediaLibsJS.length / 1024).toFixed(1)} KB (dosfs + ndbackup + backupsets + ndfsrecover + readgroups)`);

  console.log(`Loaded ${entries.length} catalog entries, ${products.length} products, ${categoriesRaw.length} categories.`);

  // Content-hash versions for cache-busting photo URLs. Uses the file content
  // (not mtime, which git checkout resets), so it's stable across CI builds and
  // changes only when a photo's bytes change.
  const photoPaths = new Set<string>();
  for (const e of entries) {
    const git = (e as any).storage?.git;
    if (!git) continue;
    for (const p of [...(git.diskPhotos ?? []), ...(git.setPhotos ?? [])]) if (p) photoPaths.add(p);
  }
  const photoVersions: Record<string, string> = {};
  for (const p of photoPaths) {
    try { photoVersions[p] = createHash('md5').update(await readFile(join(rootDir, p))).digest('hex').slice(0, 8); } catch { /* missing file */ }
  }

  await mkdir(siteDir, { recursive: true });

  const docTitles = await buildDocPages(rootDir, siteDir, products);

  const html = generateHtml(entries, products, categoriesRaw, ndfsBundleJS + mediaLibsJS, photoVersions, docTitles);
  const outPath = join(siteDir, 'index.html');
  await writeFile(outPath, html, 'utf-8');

  const sizeKB = (Buffer.byteLength(html, 'utf-8') / 1024).toFixed(1);
  console.log(`Static site built: ${outPath} (${sizeKB} KB)`);
}


/** Every document id referenced by any product, with its collection. */
function referencedDocs(products: ProductData[]): Map<string, DocKind> {
  const out = new Map<string, DocKind>();
  for (const p of products) {
    for (const kind of ['productInfo', 'installationDescription'] as const) {
      for (const id of p.docs?.[kind] ?? []) out.set(id, kind);
    }
  }
  return out;
}

/**
 * Render each referenced ND document from docs/nd/<collection>/<id>.md into its
 * own site/docs/<id>.html. Kept out of index.html on purpose: the documents are
 * ~4 MB in total and a reader opens one at a time. Plain links, no fetch(), so
 * the site still works over file://.
 * Returns docId -> display title, for the links on the product page.
 */
async function buildDocPages(
  rootDir: string,
  siteDir: string,
  products: ProductData[],
): Promise<Record<string, string>> {
  const refs = referencedDocs(products);
  if (refs.size === 0) return {};

  // Which products cite each document (one document can cover several).
  const citedBy = new Map<string, ProductData[]>();
  for (const p of products) {
    for (const kind of ['productInfo', 'installationDescription'] as const) {
      for (const id of p.docs?.[kind] ?? []) {
        if (!citedBy.has(id)) citedBy.set(id, []);
        citedBy.get(id)!.push(p);
      }
    }
  }

  const outDir = join(siteDir, 'docs');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'doc.css'), DOC_CSS, 'utf-8');

  const titles: Record<string, string> = {};
  let written = 0, missing = 0, skipped = 0;
  for (const [id, kind] of refs) {
    const src = join(rootDir, 'docs/nd', DOC_DIRS[kind], `${id}.md`);
    let md: string;
    try {
      md = await readFile(src, 'utf-8');
    } catch {
      missing++;
      continue;
    }
    titles[id] = docTitle(md, id);

    // Skip the page when it is already newer than its markdown. Rendering all
    // 374 documents costs ~500 ms of every site build, and they change only
    // when a document is added or edited.
    const outFile = join(outDir, `${id}.html`);
    try {
      const [srcStat, outStat] = await Promise.all([stat(src), stat(outFile)]);
      if (outStat.mtimeMs >= srcStat.mtimeMs) { skipped++; continue; }
    } catch { /* no page yet - render it */ }

    const body = await marked.parse(md);
    const cites = (citedBy.get(id) ?? [])
      .map(p => `<a href="../index.html#/products/${encodeURIComponent(p.id)}">${escHtml(p.id)} ${escHtml(p.name)}</a>`)
      .join(' &middot; ');
    await writeFile(join(outDir, `${id}.html`), `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(id)} - ${escHtml(titles[id])}</title>
<link rel="stylesheet" href="doc.css">
</head>
<body>
<div class="nd-doc">
<p class="nd-doc-back"><a href="../index.html#/products">&larr; Products</a></p>
<h1 class="nd-doc-id">${escHtml(id)}</h1>
<p class="nd-doc-kind">${DOC_KIND_LABELS[kind]}</p>
${cites ? `<p class="nd-doc-cited">Describes: ${cites}</p>` : ''}
<hr>
${body}
</div>
</body>
</html>
`, 'utf-8');
    written++;
  }
  console.log(`Document pages: ${written} written, ${skipped} unchanged` +
    (missing ? `, ${missing} referenced but missing on disk` : ''));
  return titles;
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Stand-alone stylesheet for the rendered ND documents (same tokens as index.html). */
const DOC_CSS = `:root, html[data-theme="dark"] {
  --bg:#14181f; --bg-elev:#1c222c; --bg-sunken:#0d1116; --border:#2b323d;
  --text:#e7eaf0; --text-muted:#99a2b2; --accent:#5b9dff;
}
html[data-theme="light"] {
  --bg:#ffffff; --bg-elev:#f7f8fa; --bg-sunken:#eef0f4; --border:#d5dae2;
  --text:#1a1f28; --text-muted:#5a6472; --accent:#0d47a1;
}
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
.nd-doc { max-width:960px; margin:0 auto; padding:2rem 1.25rem 4rem; }
.nd-doc-back { margin:0 0 1rem; }
.nd-doc-id { margin:0; font-size:1.5rem; }
.nd-doc-kind { margin:0.25rem 0 0; color:var(--text-muted); font-size:0.9rem; }
.nd-doc-cited { margin:0.5rem 0 0; color:var(--text-muted); font-size:0.9rem; }
a { color:var(--accent); }
hr { border:0; border-top:1px solid var(--border); margin:1.5rem 0; }
h1,h2,h3,h4 { line-height:1.3; margin:1.75rem 0 0.75rem; }
h2 { font-size:1.25rem; } h3 { font-size:1.1rem; }
p, li { overflow-wrap:break-word; }
code, pre { background:var(--bg-sunken); border:1px solid var(--border); border-radius:4px; }
code { padding:0.1rem 0.3rem; font-size:0.9em; }
pre { padding:0.75rem; overflow-x:auto; } pre code { border:0; padding:0; }
table { border-collapse:collapse; width:100%; margin:1rem 0; display:block; overflow-x:auto; }
th, td { border:1px solid var(--border); padding:0.4rem 0.6rem; text-align:left; vertical-align:top; }
th { background:var(--bg-elev); }
blockquote { margin:1rem 0; padding:0.5rem 1rem; border-left:3px solid var(--border); color:var(--text-muted); }
img { max-width:100%; }
`;

function escJson(data: unknown): string {
  // Escape </script> inside JSON to prevent breaking the HTML
  return JSON.stringify(data).replace(/<\/script/gi, '<\\/script');
}

function generateHtml(
  catalog: CatalogEntry[],
  products: ProductData[],
  categories: CategoryData[],
  ndfsBundleJS: string,
  photoVersions: Record<string, string>,
  docTitles: Record<string, string>,
): string {
  // Escape </script> in the bundle to prevent breaking HTML
  const safeBundleJS = ndfsBundleJS.replace(/<\/script/gi, '<\\/script');

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark" data-mode="public">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Norsk Data Software Archive</title>
<link rel="icon" href="favicon.ico">
<style>
${getThemeCSS()}
</style>
</head>
<body>
<a href="#main-content" class="skip-link">Skip to main content</a>

<header class="nd-header">
  <a class="nd-logo" href="#/" title="Dashboard"><img class="nd-logo-img" src="data:image/png;base64,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" alt="Norsk Data"><span>Norsk Data Software Archive</span></a>
  <nav class="nd-nav" id="main-nav">
    <a class="nd-nav-link nd-active" href="#/" data-route="dashboard">
      <span class="nd-nav-label">Dashboard</span>
    </a>
    <a class="nd-nav-link" href="#/catalog" data-route="catalog">
      <span class="nd-nav-label">Catalog</span>
    </a>
    <a class="nd-nav-link" href="#/products" data-route="products">
      <span class="nd-nav-label">Products</span>
    </a>
    <a class="nd-nav-link" href="#/about" data-route="about">
      <span class="nd-nav-label">About</span>
    </a>
  </nav>
  <div class="nd-ext-links">
    <a class="nd-ext-link nd-ext-org" href="https://retrocorelabs.github.io/" title="RetroCore Labs" aria-label="RetroCore Labs"><img src="data:image/png;base64,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" alt="" width="26" height="26"></a>
    <a class="nd-ext-link" href="https://github.com/RetroCoreLabs/norskdata-software-archive" title="GitHub" aria-label="GitHub"><svg viewBox="0 0 16 16" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a>
  </div>
  <button class="nd-theme-toggle" id="theme-toggle" aria-label="Toggle dark mode" title="Toggle theme"></button>
</header>

<main class="nd-main" id="main-content">
  <div class="nd-view" id="view"></div>
</main>

<footer class="nd-footer">
  Norsk Data Software Archive &mdash; read-only catalog &mdash;
  <a href="https://github.com/RetroCoreLabs/norskdata-software-archive">GitHub</a>
</footer>

<div id="nd-modal" class="nd-modal-overlay" style="display:none">
  <div class="nd-modal" id="nd-modal-content"></div>
</div>

${safeBundleJS ? `<script>\n${safeBundleJS}\n</script>` : '<!-- NDFS library not available -->'}
<script>
var CATALOG = ${escJson(catalog)};
var PRODUCTS = ${escJson(products)};
var PHOTO_VERSIONS = ${escJson(photoVersions)};
var CATEGORIES = ${escJson(categories)};
var DOC_TITLES = ${escJson(docTitles)};
</script>
<script>
${getAppJS()}
</script>
</body>
</html>`;
}

function getThemeCSS(): string {
  return `/* ================================================================
   Theme system -- semantic tokens (WCAG AA ≥ 4.5:1 contrast)
   ================================================================ */
:root,
html[data-theme="dark"] {
  --bg: #14181f;
  --bg-elev: #1c222c;
  --bg-sunken: #0d1116;
  --border: #2b323d;
  --border-strong: #3a4250;
  --text: #e7eaf0;
  --text-muted: #99a2b2;
  --accent: #5b9dff;
  --accent-hover: #80b4ff;
  --accent-bg: #14233d;
  --on-accent: #0b1424;

  --info: #6fb0ff;        --info-bg: #14233d;
  --tag-os: #3fd0de;      --tag-os-bg: #0e3338;
  --ok: #5fd07a;          --ok-bg: #143420;
  --tag-patch: #c98cf0;   --tag-patch-bg: #2a1640;
  --warn: #ff9d54;        --warn-bg: #3a2310;
  --danger: #ff7b7b;      --danger-bg: #3a1717;
  --tag-product: #6fb0ff; --tag-product-bg: #14233d;
}

html[data-theme="light"] {
  --bg: #f7f8f9;
  --bg-elev: #ffffff;
  --bg-sunken: #eceef1;
  --border: #dcdfe5;
  --border-strong: #c5c9d1;
  --text: #181c22;
  --text-muted: #586273;
  --accent: #1763d6;
  --accent-hover: #1250b0;
  --accent-bg: #e6f0ff;
  --on-accent: #ffffff;

  --info: #0a5fd0;        --info-bg: #e6f0ff;
  --tag-os: #0a6f79;      --tag-os-bg: #d9f5f7;
  --ok: #14773a;          --ok-bg: #e3f7e8;
  --tag-patch: #7e22ce;   --tag-patch-bg: #f5e8ff;
  --warn: #b23c0a;        --warn-bg: #ffece0;
  --danger: #c1271f;      --danger-bg: #ffe5e3;
  --tag-product: #0a5fd0; --tag-product-bg: #e6f0ff;
}

/* ================================================================
   Reset + base
   ================================================================ */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre { font-family: 'Consolas', 'Courier New', monospace; }

/* ================================================================
   Layout: header, main, footer
   ================================================================ */
.nd-header {
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  padding: 0 1.5rem;
  display: flex;
  align-items: center;
  gap: 1.5rem;
  height: 3.25rem;
  flex-shrink: 0;
}

.nd-logo {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  text-decoration: none;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--accent);
  white-space: nowrap;
  letter-spacing: 0.02em;
}

/* ND's own logo. Black artwork on a
   transparent ground, so it is inverted on the dark theme. */
.nd-logo-img {
  height: 26px;
  width: auto;
  display: block;
}
:root:not([data-theme="light"]) .nd-logo-img { filter: invert(1) brightness(1.6); }
html[data-theme="light"] .nd-logo-img { filter: none; }

.nd-nav {
  display: flex;
  gap: 0;
  flex: 1;
  overflow-x: auto;
}

.nd-nav-link {
  display: inline-flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 1rem;
  height: 3.25rem;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text-muted);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.15s;
  text-decoration: none;
  line-height: 1.2;
}

.nd-nav-link small {
  font-size: 0.65rem;
  font-weight: 400;
  opacity: 0.7;
}

.nd-nav-label {
  font-size: 0.85rem;
}

.nd-nav-link:hover {
  color: var(--text);
  text-decoration: none;
}

.nd-nav-link.nd-active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

.nd-theme-toggle {
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0.35rem 0.5rem;
  font-size: 1rem;
  line-height: 1;
  transition: background-color 0.15s;
  flex-shrink: 0;
}

.nd-theme-toggle:hover {
  color: var(--text);
  border-color: var(--text-muted);
}

/* Links to the RetroCore Labs front page (the organisation picture) and to this repository,
   at the right of the header next to the theme switch. The picture is a dark square, so it gets
   a light backing on the dark theme. */
.nd-ext-links {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-shrink: 0;
}
.nd-ext-link {
  display: flex;
  align-items: center;
  color: var(--text-muted);
  line-height: 1;
}
.nd-ext-link:hover { color: var(--text); }
.nd-ext-org img { display: block; border-radius: 4px; }
:root:not([data-theme="light"]) .nd-ext-org img { background: #e7eaf0; padding: 2px; box-sizing: content-box; }

.nd-main {
  flex: 1;
  padding: 1.5rem;
  max-width: 1400px;
  width: 100%;
  margin: 0 auto;
}

.nd-view {
  min-height: 300px;
}

.nd-footer {
  background: var(--bg-sunken);
  border-top: 1px solid var(--border);
  padding: 0.4rem 1.5rem;
  font-size: 0.8rem;
  color: var(--text-muted);
  flex-shrink: 0;
}

/* ================================================================
   Local/public mode split
   ================================================================ */
[data-mode="public"] .nd-write-only { display: none; }
[data-mode="local"] .nd-public-only { display: none; }

/* ================================================================
   Component: nd-card
   ================================================================ */
.nd-card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}

.nd-card h3 {
  color: var(--accent);
  margin-bottom: 0.75rem;
  font-size: 1.1rem;
}

/* ================================================================
   Component: nd-badge
   ================================================================ */
/* Documentation presence markers in the products table. Deliberately quiet:
   muted, unboxed, no colour - they mark a fact, they are not a call to action. */
.nd-docmark {
  display: inline-block;
  margin-right: 0.4rem;
  font-size: 0.78rem;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  text-decoration: none;
}
.nd-docmark:hover, .nd-docmark:focus-visible {
  color: var(--accent);
  text-decoration: underline;
}
.nd-docmark sup { font-size: 0.65em; margin-left: 0.05rem; }
.nd-docmark:last-child { margin-right: 0; }

.nd-badge {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  background: var(--accent-bg);
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
}

.nd-badge-ok      { color: var(--ok);       background: var(--ok-bg);       border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.nd-badge-info    { color: var(--info);     background: var(--info-bg);     border-color: color-mix(in srgb, var(--info) 30%, transparent); }
.nd-badge-warn    { color: var(--warn);     background: var(--warn-bg);     border-color: color-mix(in srgb, var(--warn) 30%, transparent); }
.nd-badge-danger  { color: var(--danger);   background: var(--danger-bg);   border-color: color-mix(in srgb, var(--danger) 30%, transparent); }
.nd-badge-product { color: var(--tag-product); background: var(--tag-product-bg); border-color: color-mix(in srgb, var(--tag-product) 30%, transparent); }
.nd-badge-os      { color: var(--tag-os);   background: var(--tag-os-bg);   border-color: color-mix(in srgb, var(--tag-os) 30%, transparent); }
.nd-badge-patch   { color: var(--tag-patch); background: var(--tag-patch-bg); border-color: color-mix(in srgb, var(--tag-patch) 30%, transparent); }

/* Button color variants -- higher specificity to override .nd-btn base */
.nd-btn.nd-badge-ok    { color: var(--ok);       background: var(--ok-bg);       border-color: color-mix(in srgb, var(--ok) 30%, transparent); }
.nd-btn.nd-badge-info  { color: var(--info);     background: var(--info-bg);     border-color: color-mix(in srgb, var(--info) 30%, transparent); }
.nd-btn.nd-badge-os    { color: var(--tag-os);   background: var(--tag-os-bg);   border-color: color-mix(in srgb, var(--tag-os) 30%, transparent); }
.nd-btn.nd-badge-patch { color: var(--tag-patch); background: var(--tag-patch-bg); border-color: color-mix(in srgb, var(--tag-patch) 30%, transparent); }

/* ================================================================
   Component: nd-quick-stats (label + value blocks)
   ================================================================ */
.nd-quick-stats {
  display: flex;
  gap: 1.25rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}
.nd-quick-stat {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  cursor: default;
}
.nd-quick-stat-lbl {
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  font-weight: 600;
}
.nd-quick-stat-val {
  font-size: 0.95rem;
  font-weight: 700;
  color: var(--text);
}

/* ================================================================
   Component: nd-btn
   ================================================================ */
.nd-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.5rem 1rem;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent);
  background: color-mix(in srgb, var(--accent) 9%, var(--bg-elev));
  color: var(--accent);
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  transition: background-color 0.15s;
}

.nd-btn:hover {
  background: color-mix(in srgb, var(--accent) 16%, var(--bg-elev));
  border-color: color-mix(in srgb, var(--accent) 55%, transparent);
}
.nd-btn:disabled { opacity: 0.45; cursor: not-allowed; }

.nd-btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.nd-btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }

.nd-btn-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-muted);
}

.nd-btn-ghost:hover {
  color: var(--text);
  background: var(--accent-bg);
}

/* ================================================================
   Component: nd-table
   ================================================================ */
.nd-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
  table-layout: fixed;
}

.nd-table th {
  background: var(--bg-sunken);
  color: var(--text-muted);
  padding: 0.5rem 0.6rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  font-weight: 600;
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  cursor: pointer;
  user-select: none;
}

.nd-table th:hover { color: var(--text); }

.nd-table td {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid var(--border);
  word-break: break-word;
}

.nd-table tr:hover td {
  background: var(--accent-bg);
}

/* ================================================================
   Component: nd-input, nd-select
   ================================================================ */
.nd-input, .nd-select {
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  font-size: 0.9rem;
}

.nd-input:focus, .nd-select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-bg);
}

/* ================================================================
   Component: nd-tag
   ================================================================ */
.nd-tag {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.6rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
  gap: 0.25rem;
}

.nd-tag-product { background: var(--tag-product-bg); color: var(--tag-product); }
.nd-tag-os      { background: var(--tag-os-bg);      color: var(--tag-os); }
.nd-tag-patch   { background: var(--tag-patch-bg);    color: var(--tag-patch); }

/* ================================================================
   Component: nd-stat
   ================================================================ */
.nd-hero-stats {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.5rem;
}

.nd-stat {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem 1.5rem;
  text-align: center;
  min-width: 120px;
  flex: 1;
}

.nd-stat-value {
  font-size: 2rem;
  font-weight: 700;
  font-family: 'Consolas', 'Courier New', monospace;
  line-height: 1.2;
  color: var(--text);
}

.nd-stat-ok .nd-stat-value { color: var(--ok); }
.nd-stat-warn .nd-stat-value { color: var(--warn); }

.nd-stat-label {
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 0.25rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* ================================================================
   Component: nd-placeholder
   ================================================================ */
.nd-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 300px;
  color: var(--text-muted);
  text-align: center;
}

.nd-placeholder h2 {
  font-size: 1.4rem;
  color: var(--text);
  margin-bottom: 0.5rem;
}

.nd-placeholder p {
  font-size: 0.95rem;
}

/* ================================================================
   Dashboard grid
   ================================================================ */
.nd-dash-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

/* ================================================================
   Filter chips
   ================================================================ */
.nd-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 1rem;
}

.nd-chip {
  display: inline-block;
  padding: 0.25rem 0.7rem;
  border-radius: 16px;
  font-size: 0.8rem;
  font-weight: 500;
  background: var(--bg-elev);
  color: var(--text-muted);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.15s;
}

.nd-chip:hover {
  border-color: var(--accent);
  color: var(--text);
}

.nd-chip.nd-chip-active {
  background: var(--accent-bg);
  color: var(--accent);
  border-color: var(--accent);
}

/* ================================================================
   Pagination
   ================================================================ */
.nd-pagination {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 1rem;
  font-size: 0.85rem;
  color: var(--text-muted);
}

/* ================================================================
   Search bar
   ================================================================ */
.nd-search-bar {
  margin-bottom: 1rem;
}

.nd-search-bar input {
  width: 100%;
  max-width: 500px;
}

/* ================================================================
   Detail meta grid
   ================================================================ */
.nd-meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0.25rem 1rem;
  font-size: 0.85rem;
}

.nd-meta-grid dt { color: var(--text-muted); font-weight: 600; }
.nd-meta-grid dd { margin: 0 0 0.25rem 0; }

/* Details toggle (collapsible section with rounded border) */
.nd-details-toggle {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 1rem;
  overflow: hidden;
}
.nd-details-toggle summary {
  padding: 0.6rem 1rem;
  cursor: pointer;
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--text-muted);
}
.nd-details-toggle summary:hover { color: var(--text); }
.nd-details-toggle .nd-details-body {
  padding: 0 1rem 1rem 1rem;
}

/* Definition list (label: value pairs) */
.nd-dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.75rem;
  font-size: 0.85rem;
}
.nd-dl dt { color: var(--text-muted); white-space: nowrap; }
.nd-dl dd { word-break: break-all; }

/* Copyable code block */
.nd-copyable {
  display: inline-block;
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.2rem 0.5rem;
  font-family: Consolas, monospace;
  font-size: 0.8rem;
  word-break: break-all;
}

/* ================================================================
   NDFS file details
   ================================================================ */
.nd-ndfs-box {
  background: var(--bg-sunken);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.5rem;
  margin: 0.5rem 0;
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 0.8rem;
  max-height: 400px;
  overflow-y: auto;
}

.nd-ndfs-box .nd-table { font-size: 0.8rem; }
.nd-ndfs-box .nd-table th {
  background: var(--tag-patch-bg);
  color: var(--tag-patch);
  border-bottom: 1px solid var(--tag-patch);
  padding: 0.25rem 0.5rem;
}
.nd-ndfs-box .nd-table td { padding: 0.2rem 0.5rem; }

/* ================================================================
   Version group
   ================================================================ */
.nd-version-group {
  margin: 1rem 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.nd-version-header {
  background: var(--tag-os-bg);
  color: var(--tag-os);
  padding: 0.5rem 1rem;
  font-weight: 600;
  border-bottom: 1px solid var(--tag-os);
}

.nd-version-body { padding: 0.75rem 1rem; }

/* ================================================================
   Provenance
   ================================================================ */
.nd-provenance {
  background: var(--warn-bg);
  border: 1px solid var(--warn);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  margin-top: 0.5rem;
  font-size: 0.85rem;
  color: var(--warn);
}

/* ================================================================
   BPUN indicator
   ================================================================ */
.nd-bpun-ok { color: var(--ok); }
.nd-bpun-fail { color: var(--warn); }

/* ================================================================
   Skip link
   ================================================================ */
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  background: var(--accent);
  color: #fff;
  padding: 8px;
  z-index: 100;
  transition: top 0.2s;
}
.skip-link:focus { top: 0; }

/* ================================================================
   Component: Modal
   ================================================================ */
.nd-modal-overlay {
  display: none;
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.6);
  z-index: 1000;
  align-items: center;
  justify-content: center;
}

.nd-modal {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 90%;
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,0.3);
}

.nd-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
}

.nd-modal-header h3 {
  margin: 0;
  color: var(--accent);
}

.nd-modal-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 1.5rem;
  cursor: pointer;
  padding: 0 0.25rem;
  line-height: 1;
}

.nd-modal-close:hover { color: var(--text); }

.nd-modal-body {
  padding: 1rem 1.25rem;
  overflow-y: auto;
  flex: 1;
}

.nd-modal-wide {
  max-width: 1000px;
  width: 90%;
  max-height: 90vh;
}

.nd-modal-photo {
  background: rgba(0,0,0,0.95);
  border: none;
  box-shadow: none;
  max-width: none;
  width: 100vw;
  height: 100vh;
  border-radius: 0;
  position: relative;
  display: flex;
  flex-direction: column;
}

.nd-photo-viewer-close {
  position: absolute;
  top: 12px;
  right: 16px;
  z-index: 10;
  background: rgba(0,0,0,0.5);
  color: #fff;
  border: none;
  font-size: 2rem;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
  transition: background-color 0.2s;
}
.nd-photo-viewer-close:hover { background: var(--accent, #3498db); }

.nd-photo-viewer-container {
  flex: 1;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  user-select: none;
}
.nd-photo-viewer-container.dragging { cursor: grabbing; }

.nd-photo-viewer-container img {
  max-width: 95%;
  max-height: 90vh;
  transform-origin: center center;
  transition: transform 0.1s ease-out;
  user-select: none;
  border-radius: 4px;
  box-shadow: 0 10px 50px rgba(0,0,0,0.5);
  pointer-events: auto;
}

.nd-photo-zoom-controls {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  align-items: center;
  background-color: rgba(0,0,0,0.7);
  padding: 10px 16px;
  border-radius: 8px;
  z-index: 10;
}

.nd-photo-zoom-controls button {
  background-color: var(--accent, #3498db);
  color: #fff;
  border: none;
  width: 36px;
  height: 36px;
  border-radius: 4px;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.2s;
}
.nd-photo-zoom-controls button:hover { background-color: #2980b9; }

.nd-photo-zoom-level {
  color: #fff;
  font-size: 14px;
  min-width: 55px;
  text-align: center;
  font-weight: 600;
}

/* ================================================================
   NDFS Viewer styles
   ================================================================ */
.ndfs-viewer-header {
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border);
  font-size: 0.82rem;
  color: var(--text-muted);
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}

.ndfs-viewer-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.ndfs-user-panel {
  width: 180px;
  min-width: 140px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
  padding: 0.5rem 0;
  flex-shrink: 0;
}

.ndfs-user-panel h4 {
  margin: 0 0 0.25rem 0;
  padding: 0 0.75rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--text-muted);
  letter-spacing: 0.05em;
}

.ndfs-user-item {
  padding: 0.35rem 0.75rem;
  cursor: pointer;
  font-size: 0.82rem;
  border-left: 3px solid transparent;
  transition: background 0.15s;
}

.ndfs-user-item:hover { background: var(--accent-bg); }

.ndfs-user-item.ndfs-user-active {
  background: var(--accent-bg);
  border-left-color: var(--accent);
  color: var(--accent);
}

.ndfs-user-item .ndfs-user-count {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.ndfs-file-panel {
  flex: 1;
  overflow: auto;
  min-width: 0;
}

.ndfs-file-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}

.ndfs-file-table th {
  position: sticky;
  top: 0;
  background: var(--bg-elev);
  text-align: left;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  color: var(--text-muted);
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.ndfs-file-table td {
  padding: 0.3rem 0.5rem;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}

.ndfs-file-table tr:hover { background: var(--accent-bg); }

.ndfs-file-table tr.ndfs-file-selected { background: var(--accent-bg); }

.ndfs-file-actions {
  padding: 0.5rem 0.75rem;
  border-top: 1px solid var(--border);
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  align-items: center;
}

.ndfs-file-actions .nd-btn {
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
}

.ndfs-file-actions .ndfs-selected-label {
  font-size: 0.78rem;
  color: var(--text-muted);
  margin-right: auto;
}

.ndfs-hex-view {
  font-family: 'Courier New', monospace;
  font-size: 0.72rem;
  white-space: pre;
  overflow: auto;
  max-height: 400px;
  padding: 0.75rem;
  background: var(--bg-sunken);
  border-radius: 4px;
  line-height: 1.4;
}

.ndfs-text-view {
  font-family: 'Courier New', monospace;
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-all;
  overflow: auto;
  max-height: 400px;
  padding: 0.75rem;
  background: var(--bg-sunken);
  border-radius: 4px;
  line-height: 1.4;
}

.ndfs-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem;
  color: var(--text-muted);
  gap: 0.75rem;
}

.ndfs-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: ndfs-spin 0.7s linear infinite;
}

@keyframes ndfs-spin {
  to { transform: rotate(360deg); }
}

/* ================================================================
   Photos
   ================================================================ */
.nd-photo-thumb {
  display: inline-block;
  max-width: 200px;
  max-height: 160px;
  border-radius: 6px;
  border: 1px solid var(--border);
  cursor: pointer;
  margin: 0.25rem;
  transition: border-color 0.15s;
  object-fit: contain;
}

.nd-photo-thumb:hover { border-color: var(--accent); }

.nd-photo-gallery {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

/* ================================================================
   Responsive
   ================================================================ */
@media (max-width: 768px) {
  .nd-hero-stats { flex-direction: column; }
  .nd-dash-grid { grid-template-columns: 1fr; }
  .nd-table { font-size: 0.8rem; }
  .nd-table th, .nd-table td { padding: 0.3rem 0.4rem; }
  .nd-header { gap: 0.75rem; padding: 0 0.75rem; }
  /* The header carries the two extra links now; below this width the ND logo alone stands for the title. */
  .nd-logo span { display: none; }
  .nd-ext-links { gap: 0.4rem; }
  .ndfs-viewer-layout { flex-direction: column; }
  .ndfs-user-panel { width: 100%; border-right: none; border-bottom: 1px solid var(--border); }
}

/* About page typography. The global reset (* { margin:0; padding:0 }) strips
   list indentation, which left bullets flush against the card edge. Restore a
   comfortable, well-indented layout -- scoped to .nd-about. */
.nd-about h2 { margin-bottom: 0.5rem; }
.nd-about .nd-card { padding: 1.25rem 1.5rem; margin-bottom: 1.1rem; }
.nd-about .nd-card h3 { margin-bottom: 0.7rem; }
.nd-about p { line-height: 1.7; margin-bottom: 0.6rem; }
.nd-about p:last-child { margin-bottom: 0; }
.nd-about ul, .nd-about ol { padding-left: 2.25rem; margin: 0.5rem 0 0.25rem; }
.nd-about ul { list-style: disc; }
.nd-about ol { list-style: decimal; }
.nd-about li { margin-bottom: 0.55rem; line-height: 1.65; padding-left: 0.35rem; }
.nd-about li:last-child { margin-bottom: 0; }
.nd-about li::marker { color: var(--text-muted); }
`;
}

function getAppJS(): string {
  return `(function() {
  'use strict';

  var REPO_RAW_BASE = 'https://raw.githubusercontent.com/RetroCoreLabs/norskdata-software-archive/main/';

  // ── Helpers ──────────────────────────────────────────────────
  function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function formatBytes(b) {
    if (b == null) return '-';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }

  function ndQuickStat(val, label, tooltip) {
    return '<div class="nd-quick-stat"' + (tooltip ? ' title="' + tooltip + '"' : '') + '><div class="nd-quick-stat-lbl">' + label + '</div><div class="nd-quick-stat-val">' + val + '</div></div>';
  }

  function rawUrl(path) {
    if (!path) return '';
    // Served locally (make site-serve), images/ and collections/ come from the
    // repository itself, so the viewers work on images not yet pushed to main.
    var host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return '/' + path;
    return REPO_RAW_BASE + path;
  }

  function photoUrl(path) {
    if (!path) return '';
    var v = PHOTO_VERSIONS[path];
    return rawUrl(path) + (v ? '?v=' + v : '');
  }

  function photoImg(path) {
    var url = photoUrl(path);
    return '<img class="nd-photo-thumb" src="' + esc(url) + '" alt="Photo" loading="lazy" onclick="ndShowPhoto(this.src)">';
  }

  function bpunMark(file) {
    if (file.bpunValid === true) return ' <span title="BPUN checksum valid" style="color:var(--ok);cursor:help;padding:0 0.2rem">\\u2713</span>';
    if (file.bpunValid === false) return ' <span title="BPUN checksum INVALID" style="color:var(--danger);cursor:help;padding:0 0.2rem;font-weight:bold">\\u2717</span>';
    if (file.type === 'BPUN') return ' <span title="BPUN checksum not validated" style="color:var(--text-muted);cursor:help;padding:0 0.2rem">?</span>';
    return '';
  }

  function fileDisplayName(file) {
    var user = file.userName || '';
    var name = file.name || file.fullName || '';
    // Only append :TYPE if name doesn't already include it
    if (name.indexOf(':') === -1 && file.type) {
      name = name + ':' + file.type;
    }
    return '<span style="color:var(--accent);font-weight:700">(' + esc(user) + ')</span>' + esc(name);
  }

  // Build lookup maps
  var productMap = {};
  for (var i = 0; i < PRODUCTS.length; i++) {
    productMap[PRODUCTS[i].id] = PRODUCTS[i];
  }
  var categoryMap = {};
  for (var i = 0; i < CATEGORIES.length; i++) {
    categoryMap[CATEGORIES[i].id] = CATEGORIES[i];
  }

  // Build catalog lookup
  var catalogMap = {};
  for (var i = 0; i < CATALOG.length; i++) {
    catalogMap[CATALOG[i].id] = CATALOG[i];
  }

  var view = document.getElementById('view');
  var PAGE_SIZE = 50;

  // ── Modal ────────────────────────────────────────────────────
  var ndModal = {
    _onClose: null,
    open: function(html, options) {
      options = options || {};
      var overlay = document.getElementById('nd-modal');
      var content = document.getElementById('nd-modal-content');
      content.innerHTML = html;
      content.className = 'nd-modal' + (options.wide ? ' nd-modal-wide' : '') + (options.photo ? ' nd-modal-photo' : '');
      ndModal._onClose = options.onClose || null;
      overlay.style.display = 'flex';
    },
    close: function() {
      var overlay = document.getElementById('nd-modal');
      overlay.style.display = 'none';
      document.getElementById('nd-modal-content').innerHTML = '';
      if (ndModal._onClose) {
        ndModal._onClose();
        ndModal._onClose = null;
      }
    }
  };
  window.ndModal = ndModal;

  // Wire overlay click/escape to close
  document.addEventListener('DOMContentLoaded', function() {
    var modalEl = document.getElementById('nd-modal');
    if (modalEl) {
      modalEl.addEventListener('click', function(ev) {
        if (ev.target === this) ndModal.close();
      });
    }
  });
  document.addEventListener('keydown', function(ev) {
    var modalEl = document.getElementById('nd-modal');
    if (ev.key === 'Escape' && modalEl && modalEl.style.display === 'flex') {
      ndModal.close();
    }
  });

  // ── Photo Viewer (zoom, rotate, pan) ──────────────────────────
  var pvZoom = 1, pvRotation = 0, pvPanX = 0, pvPanY = 0;
  var pvDragging = false, pvDragStartX = 0, pvDragStartY = 0, pvPanStartX = 0, pvPanStartY = 0;
  var PV_MIN = 0.5, PV_MAX = 10, PV_STEP = 0.25;

  function pvUpdate() {
    var img = document.getElementById('nd-pv-img');
    if (img) img.style.transform = 'translate(' + pvPanX + 'px,' + pvPanY + 'px) scale(' + pvZoom + ') rotate(' + pvRotation + 'deg)';
    var lvl = document.getElementById('nd-pv-level');
    if (lvl) lvl.textContent = Math.round(pvZoom * 100) + '%';
  }

  function pvReset() { pvZoom = 1; pvRotation = 0; pvPanX = 0; pvPanY = 0; pvUpdate(); }

  window.ndShowPhoto = function(src) {
    pvReset();
    var html =
      '<button class="nd-photo-viewer-close" onclick="ndModal.close()">&times;</button>' +
      '<div class="nd-photo-viewer-container" id="nd-pv-container">' +
        '<img id="nd-pv-img" src="' + src + '" alt="Photo" draggable="false">' +
      '</div>' +
      '<div class="nd-photo-zoom-controls">' +
        '<button onclick="ndPvRotateL()" title="Rotate left">&#8630;</button>' +
        '<button onclick="ndPvZoomOut()" title="Zoom out">&minus;</button>' +
        '<span class="nd-photo-zoom-level" id="nd-pv-level">100%</span>' +
        '<button onclick="ndPvZoomIn()" title="Zoom in">&plus;</button>' +
        '<button onclick="ndPvRotateR()" title="Rotate right">&#8631;</button>' +
        '<button onclick="ndPvReset()" title="Reset">R</button>' +
      '</div>';
    ndModal.open(html, { photo: true, onClose: function() { pvReset(); } });

    // Wire mouse/wheel events after DOM is ready
    setTimeout(function() {
      var container = document.getElementById('nd-pv-container');
      if (!container) return;

      container.addEventListener('wheel', function(e) {
        e.preventDefault();
        var delta = e.deltaY > 0 ? -PV_STEP : PV_STEP;
        var nz = Math.max(PV_MIN, Math.min(PV_MAX, pvZoom + delta));
        if (nz !== pvZoom) {
          pvZoom = nz;
          if (pvZoom <= 1) { pvPanX = 0; pvPanY = 0; }
          pvUpdate();
        }
      }, { passive: false });

      container.addEventListener('mousedown', function(e) {
        if (e.target.tagName === 'IMG' && pvZoom > 1) {
          pvDragging = true;
          pvDragStartX = e.clientX; pvDragStartY = e.clientY;
          pvPanStartX = pvPanX; pvPanStartY = pvPanY;
          container.classList.add('dragging');
          e.preventDefault();
        }
      });

      document.addEventListener('mousemove', function pvMove(e) {
        if (pvDragging) {
          pvPanX = pvPanStartX + (e.clientX - pvDragStartX);
          pvPanY = pvPanStartY + (e.clientY - pvDragStartY);
          pvUpdate();
        }
      });

      document.addEventListener('mouseup', function pvUp() {
        if (pvDragging) {
          pvDragging = false;
          var c = document.getElementById('nd-pv-container');
          if (c) c.classList.remove('dragging');
        }
      });
    }, 0);
  };

  window.ndPvZoomIn = function() { pvZoom = Math.min(PV_MAX, pvZoom + PV_STEP); pvUpdate(); };
  window.ndPvZoomOut = function() { pvZoom = Math.max(PV_MIN, pvZoom - PV_STEP); if (pvZoom <= 1) { pvPanX = 0; pvPanY = 0; } pvUpdate(); };
  window.ndPvRotateL = function() { pvRotation = (pvRotation - 90 + 360) % 360; pvUpdate(); };
  window.ndPvRotateR = function() { pvRotation = (pvRotation + 90) % 360; pvUpdate(); };
  window.ndPvReset = function() { pvReset(); };

  // Keyboard shortcuts for image viewer (same as ndfloppy PCB viewer)
  document.addEventListener('keydown', function(e) {
    var modal = document.getElementById('nd-modal');
    if (!modal || modal.style.display !== 'flex') return;
    var hasViewer = document.getElementById('nd-pv-img');
    if (!hasViewer) return;
    if (e.key === '+' || e.key === '=') { ndPvZoomIn(); e.preventDefault(); }
    else if (e.key === '-') { ndPvZoomOut(); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { ndPvRotateR(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { ndPvRotateL(); e.preventDefault(); }
    else if (e.key === 'r' || e.key === 'R') { ndPvReset(); e.preventDefault(); }
  });

  // ── Theme toggle ─────────────────────────────────────────────
  var themeBtn = document.getElementById('theme-toggle');
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeBtn.textContent = theme === 'dark' ? '\u263E' : '\u2600';
    themeBtn.title = 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme';
  }
  var savedTheme = localStorage.getItem('nd-theme');
  applyTheme(savedTheme === 'light' ? 'light' : 'dark');

  themeBtn.addEventListener('click', function() {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : 'dark';
    localStorage.setItem('nd-theme', next);
    applyTheme(next);
  });

  // ── Router ───────────────────────────────────────────────────
  function getRoute() {
    var h = location.hash || '#/';
    if (h === '#' || h === '') h = '#/';
    var raw = h.substring(1);                 // strip '#'
    var q = raw.indexOf('?');
    return q < 0 ? raw : raw.substring(0, q);
  }

  /** The query string of the current hash, as an object. */
  function getRouteParams() {
    var h = location.hash || '';
    var q = h.indexOf('?');
    var out = {};
    if (q < 0) return out;
    h.substring(q + 1).split('&').forEach(function(pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      if (eq < 0) out[decodeURIComponent(pair)] = '';
      else out[decodeURIComponent(pair.substring(0, eq))] = decodeURIComponent(pair.substring(eq + 1));
    });
    return out;
  }

  function navigate() {
    ndModal.close();
    var route = getRoute();
    // Update nav active states
    var links = document.querySelectorAll('.nd-nav-link');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      var r = href ? href.substring(1) : '';
      if (route === r || (r !== '/' && route.indexOf(r) === 0)) {
        links[i].classList.add('nd-active');
      } else {
        links[i].classList.remove('nd-active');
      }
    }
    // Fix: dashboard should only be active on exact match
    var dashLink = document.querySelector('[data-route="dashboard"]');
    if (dashLink) {
      if (route === '/') {
        dashLink.classList.add('nd-active');
      } else {
        dashLink.classList.remove('nd-active');
      }
    }

    if (route === '/') return renderDashboard();
    if (route === '/catalog') {
      // Links from the dashboard arrive as #/catalog?contributor=fvdm or
      // ?product=unmatched, so the filters have to come from the hash.
      var p = getRouteParams();
      catalogState.contributor = p.contributor || '';
      catalogState.unmatched = p.product === 'unmatched';
      if (p.media) catalogState.media = p.media;
      if (p.condition) catalogState.condition = p.condition;
      if (p.q !== undefined) catalogState.query = p.q;
      catalogState.page = 0;
      return renderCatalog();
    }
    if (route === '/products') return renderProducts();
    if (route === '/about') return renderAbout();
    if (route.indexOf('/products/') === 0) {
      var pid = decodeURIComponent(route.substring('/products/'.length));
      return renderProductDetail(pid);
    }
    if (route.indexOf('/disks/') === 0) {
      var did = decodeURIComponent(route.substring('/disks/'.length));
      return renderDiskDetail(did);
    }
    renderDashboard();
  }

  window.addEventListener('hashchange', navigate);

  // ── Dashboard ────────────────────────────────────────────────
  function renderDashboard() {
    var totalImages = CATALOG.length;
    var productIds = {};
    var fileTypes = {};
    var bootFormats = {};
    var storageClasses = {};
    var totalFiles = 0;
    var contributors = {};

    for (var i = 0; i < CATALOG.length; i++) {
      var e = CATALOG[i];
      if (e.productId) productIds[e.productId] = (productIds[e.productId] || 0) + 1;
      var sc = e.storageClass || 'unknown';
      storageClasses[sc] = (storageClasses[sc] || 0) + 1;
      var bf = e.bootFormat || 'unknown';
      bootFormats[bf] = (bootFormats[bf] || 0) + 1;
      if (e.ndfs && e.ndfs.files) {
        totalFiles += e.ndfs.files.length;
        for (var j = 0; j < e.ndfs.files.length; j++) {
          var ft = e.ndfs.files[j].type || 'unknown';
          fileTypes[ft] = (fileTypes[ft] || 0) + 1;
        }
      }
      if (e.provenance && e.provenance.contributor && e.provenance.contributor !== 'unknown') {
        contributors[e.provenance.contributor] = (contributors[e.provenance.contributor] || 0) + 1;
      }
    }

    var matchedProducts = Object.keys(productIds).length;
    var unmatchedCount = 0;
    for (var i = 0; i < CATALOG.length; i++) {
      if (!CATALOG[i].productId) unmatchedCount++;
    }

    // Top products
    var topProducts = Object.keys(productIds).map(function(k) { return { id: k, count: productIds[k] }; });
    topProducts.sort(function(a, b) { return b.count - a.count; });
    topProducts = topProducts.slice(0, 10);

    // Top file types
    var topFileTypes = Object.keys(fileTypes).map(function(k) { return { type: k, count: fileTypes[k] }; });
    topFileTypes.sort(function(a, b) { return b.count - a.count; });
    topFileTypes = topFileTypes.slice(0, 12);

    // Boot formats
    var bootList = Object.keys(bootFormats).map(function(k) { return { format: k, count: bootFormats[k] }; });
    bootList.sort(function(a, b) { return b.count - a.count; });

    // Contributors
    var contribList = Object.keys(contributors).map(function(k) { return { name: k, count: contributors[k] }; });
    contribList.sort(function(a, b) { return b.count - a.count; });

    var html = '<h2>Archive Overview</h2>';

    // Stats row
    html += '<div class="nd-hero-stats">';
    html += statCard(totalImages, 'Floppy Images');
    html += statCard(matchedProducts, 'Products Matched');
    html += statCard(PRODUCTS.length, 'Products Known');
    html += statCard(totalFiles, 'NDFS Files');
    html += statCard(storageClasses['floppy-in-git'] || 0, 'In Git');
    // Floppies with no product assigned yet - clicking shows exactly those.
    html += '<a href="#/catalog?product=unmatched" style="text-decoration:none;color:inherit">' +
      statCard(unmatchedCount, 'Unmatched', unmatchedCount > 0 ? 'nd-stat-warn' : '') + '</a>';
    html += '</div>';

    // Grid
    html += '<div class="nd-dash-grid">';

    // Top products card
    html += '<div class="nd-card"><h3>Top Products</h3>';
    html += '<table class="nd-table"><thead><tr><th>Product</th><th>Images</th></tr></thead><tbody>';
    for (var i = 0; i < topProducts.length; i++) {
      var p = topProducts[i];
      var pn = productMap[p.id] ? productMap[p.id].name : p.id;
      html += '<tr><td><a href="#/products/' + encodeURIComponent(p.id) + '">' + esc(p.id) + ' - ' + esc(pn) + '</a></td>';
      html += '<td>' + p.count + '</td></tr>';
    }
    html += '</tbody></table></div>';

    // File types card
    html += '<div class="nd-card"><h3>NDFS File Types</h3>';
    html += '<table class="nd-table"><thead><tr><th>Type</th><th>Count</th></tr></thead><tbody>';
    for (var i = 0; i < topFileTypes.length; i++) {
      html += '<tr><td><span class="nd-badge nd-badge-info">' + esc(topFileTypes[i].type) + '</span></td>';
      html += '<td>' + topFileTypes[i].count + '</td></tr>';
    }
    html += '</tbody></table></div>';

    // Boot formats card
    html += '<div class="nd-card"><h3>Boot Formats</h3>';
    html += '<table class="nd-table"><thead><tr><th>Format</th><th>Count</th></tr></thead><tbody>';
    for (var i = 0; i < bootList.length; i++) {
      html += '<tr><td><span class="nd-badge nd-badge-os">' + esc(bootList[i].format) + '</span></td>';
      html += '<td>' + bootList[i].count + '</td></tr>';
    }
    html += '</tbody></table></div>';

    // Contributors card
    if (contribList.length > 0) {
      html += '<div class="nd-card"><h3>Contributors</h3>';
      html += '<table class="nd-table"><thead><tr><th>Name</th><th>Images</th></tr></thead><tbody>';
      for (var i = 0; i < contribList.length; i++) {
        var link = '#/catalog?contributor=' + encodeURIComponent(contribList[i].name);
        html += '<tr><td><a href="' + link + '">' + esc(contribList[i].name) + '</a></td>';
        html += '<td><a href="' + link + '" style="color:inherit">' + contribList[i].count + '</a></td></tr>';
      }
      html += '</tbody></table></div>';
    }

    html += '</div>'; // end grid

    view.innerHTML = html;
  }

  function statCard(value, label, extraClass) {
    return '<div class="nd-stat ' + (extraClass || '') + '">' +
      '<div class="nd-stat-value">' + value + '</div>' +
      '<div class="nd-stat-label">' + esc(label) + '</div></div>';
  }

  // ── Catalog ──────────────────────────────────────────────────
  var catalogState = { query: '', media: 'all', condition: 'all', contributor: '', unmatched: false, page: 0, sortCol: null, sortDir: 'asc' };

  var catalogDebounce;

  /**
   * What an image holds. Most are NDFS, but the archive also has MS-DOS
   * floppies, SINTRAN BACKUP-SYSTEM volumes, WINCH-TO-FLOPP directory backups,
   * tar archives and blank or unreadable disks. Without this the whole lot just
   * reads "unmatched" with nothing saying why.
   */
  var MEDIA_LABEL = { ndfs: 'NDFS', dos: 'DOS', backup: 'BACKUP', winch: 'WINCH', tar: 'TAR', none: 'none' };
  var MEDIA_FILTERS = [
    ['all', 'All media'], ['ndfs', 'ND filesystem'], ['dos', 'MS-DOS'],
    ['backup', 'BACKUP-SYSTEM'], ['winch', 'WINCH-TO-FLOPP'], ['tar', 'tar archive'], ['none', 'no filesystem'],
  ];
  /** What an image counts as when the filter runs: undetected images count as ND. */
  function mediaOf(e) {
    return e.filesystem || (e.ndfs && (e.ndfs.files || e.ndfs.users) ? 'ndfs' : 'none');
  }
  var CONDITION_FILTERS = [['all', 'Any'], ['ok', 'Readable'], ['damaged', 'Damaged only']];
  function isDamaged(e) { return !!(e.condition && e.condition.status === 'damaged'); }
  var conditionCounts = { all: CATALOG.length, ok: 0, damaged: 0 };
  for (var ci2 = 0; ci2 < CATALOG.length; ci2++) {
    if (isDamaged(CATALOG[ci2])) conditionCounts.damaged++; else conditionCounts.ok++;
  }
  var mediaCounts = { all: CATALOG.length };
  for (var mi = 0; mi < CATALOG.length; mi++) {
    var mk = mediaOf(CATALOG[mi]);
    mediaCounts[mk] = (mediaCounts[mk] || 0) + 1;
  }
  for (var mf = 0; mf < MEDIA_FILTERS.length; mf++) {
    if (mediaCounts[MEDIA_FILTERS[mf][0]] === undefined) mediaCounts[MEDIA_FILTERS[mf][0]] = 0;
  }
  function mediaCell(e) {
    var fs = e.filesystem || (e.ndfs && (e.ndfs.files || e.ndfs.users) ? 'ndfs' : null);
    if (!fs) return '<span style="color:var(--text-muted)">-</span>';
    var label = MEDIA_LABEL[fs] || fs;
    if (e.condition && e.condition.status === 'damaged' && e.condition.recovery) {
      return '<span style="color:var(--text-muted);font-size:0.8rem">' + label + '</span> ' +
        '<span class="nd-badge nd-badge-warn" style="font-size:0.68rem" title="' +
        esc('The master block is damaged; this file list was recovered by rebuilding the pointers, and ' +
            e.condition.recovery.namesConfirmedInBytes + ' of ' + e.condition.recovery.filesRecovered +
            ' names are confirmed by the image itself') + '">recovered</span>';
    }
    if (e.condition && e.condition.status === 'damaged') {
      // Recorded as the ND floppy it is, but nothing can be read off it - say so
      // in the listing rather than letting it pass as a complete disk.
      return '<span style="color:var(--text-muted);font-size:0.8rem">' + label + '</span> ' +
        '<span class="nd-badge nd-badge-warn" style="font-size:0.68rem" title="' +
        esc(e.condition.ndNamesFound + ' ND file names are in the bytes, but the filesystem structures cannot be read (' +
            (e.condition.parserError || '') + '), so no file list can be shown') + '">damaged</span>';
    }
    if (fs === 'ndfs') return '<span style="color:var(--text-muted);font-size:0.8rem">' + label + '</span>';
    if (fs === 'none') return '<span style="color:var(--text-muted);font-size:0.8rem;font-style:italic">' + label + '</span>';
    return '<span class="nd-badge" style="font-size:0.72rem">' + label + '</span>';
  }

  function renderCatalog() {
    // Only build the shell once; updateCatalogResults rebuilds just the table
    var shell = '<h2>Full Catalog (' + CATALOG.length + ' images)</h2>';
    shell += '<div class="nd-search-bar" style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap">' +
      '<input class="nd-input" type="text" id="cat-search" style="flex:1 1 18rem" placeholder="Search by volume, product, file name, MD5, tags..." value="' + esc(catalogState.query) + '">' +
      '<label style="font-size:0.85rem;white-space:nowrap">Media <select class="nd-input" id="cat-media" style="width:auto">' +
        MEDIA_FILTERS.map(function(m) {
          return '<option value="' + m[0] + '"' + (catalogState.media === m[0] ? ' selected' : '') + '>' + m[1] +
            ' (' + mediaCounts[m[0]] + ')</option>';
        }).join('') +
      '</select></label>' +
      '<label style="font-size:0.85rem;white-space:nowrap" title="A damaged floppy holds ND material - SINTRAN file names are in the bytes - but its filesystem structures cannot be read, so no file list can be shown">' +
        'Condition <select class="nd-input" id="cat-condition" style="width:auto">' +
        CONDITION_FILTERS.map(function(cf) {
          return '<option value="' + cf[0] + '"' + (catalogState.condition === cf[0] ? ' selected' : '') + '>' + cf[1] +
            ' (' + conditionCounts[cf[0]] + ')</option>';
        }).join('') +
      '</select></label></div>';
    if (catalogState.contributor || catalogState.unmatched) {
      shell += '<p style="margin:0.25rem 0 0.5rem">';
      if (catalogState.contributor) {
        shell += '<span class="nd-badge nd-badge-info">contributed by ' + esc(catalogState.contributor) + '</span> ';
      }
      if (catalogState.unmatched) {
        shell += '<span class="nd-badge nd-badge-warn">no product assigned</span> ';
      }
      shell += '<a href="#/catalog" style="font-size:0.85rem">show everything</a></p>';
    }
    shell += '<p id="cat-count" style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem"></p>';
    shell += '<div id="cat-results" style="overflow-x:auto"></div>';
    shell += '<div class="nd-pagination" id="cat-pager"></div>';

    view.innerHTML = shell;

    var conditionSelect = document.getElementById('cat-condition');
    conditionSelect.addEventListener('change', function() {
      catalogState.condition = this.value;
      catalogState.page = 0;
      updateCatalogResults();
    });

    var mediaSelect = document.getElementById('cat-media');
    mediaSelect.addEventListener('change', function() {
      catalogState.media = this.value;
      catalogState.page = 0;
      updateCatalogResults();
    });

    var searchInput = document.getElementById('cat-search');
    searchInput.addEventListener('input', function() {
      clearTimeout(catalogDebounce);
      catalogDebounce = setTimeout(function() {
        catalogState.query = searchInput.value;
        catalogState.page = 0;
        updateCatalogResults();
      }, 200);
    });
    searchInput.focus();

    updateCatalogResults();
  }

  function updateCatalogResults() {
    var filtered = filterCatalog(catalogState.query);

    if (catalogState.sortCol !== null) {
      filtered = sortEntries(filtered, catalogState.sortCol, catalogState.sortDir);
    }

    var totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
    if (catalogState.page >= totalPages) catalogState.page = totalPages - 1;
    var start = catalogState.page * PAGE_SIZE;
    var pageEntries = filtered.slice(start, start + PAGE_SIZE);

    document.getElementById('cat-count').textContent = filtered.length + ' results';

    var html = '<table class="nd-table" id="cat-table">';
    html += '<colgroup><col style="width:21%"><col style="width:7%"><col style="width:26%"><col style="width:6%"><col style="width:9%"><col style="width:12%"><col style="width:12%"><col style="width:7%"></colgroup>';
    html += '<thead><tr>';
    var cols = ['Volume Name', 'Media', 'Product', 'Version', 'Size', 'Boot Format', 'Files'];
    for (var c = 0; c < cols.length; c++) {
      var arrow = '';
      if (catalogState.sortCol === c) arrow = catalogState.sortDir === 'asc' ? ' \\u25B2' : ' \\u25BC';
      html += '<th data-col="' + c + '">' + cols[c] + arrow + '</th>';
    }
    html += '<th></th>';
    html += '</tr></thead><tbody>';

    for (var i = 0; i < pageEntries.length; i++) {
      var e = pageEntries[i];
      var pName = '';
      if (e.productId && productMap[e.productId]) pName = productMap[e.productId].name;
      else if (e.productId) pName = e.productId;
      html += '<tr>';
      html += '<td><a href="#/disks/' + encodeURIComponent(e.id) + '">' + esc(e.volumeName || e.volumeLabel || e.id) + '</a></td>';
      html += '<td>' + mediaCell(e) + '</td>';
      html += '<td>' + (e.productId ? '<a href="#/products/' + encodeURIComponent(e.productId) + '">' + esc(pName) + '</a>' : '<em style="color:var(--text-muted)">unmatched</em>') + '</td>';
      html += '<td>' + esc(e.version) + '</td>';
      html += '<td>' + formatBytes(e.imageSizeBytes) + '</td>';
      html += '<td><span class="nd-badge nd-badge-os">' + esc(e.bootFormat || '-') + '</span></td>';
      html += '<td>' + (e.ndfs && e.ndfs.files ? e.ndfs.files.length : '-') + '</td>';
      // Looking at the bytes is the only way to identify an image the detectors
      // cannot place, so the listing offers it directly rather than by way of
      // the disk page.
      html += '<td style="text-align:right"><button class="nd-btn nd-btn-sm" data-hex="' + esc(e.id) + '">Hex</button></td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('cat-results').innerHTML = html;

    // the viewer walks whatever the listing is currently showing
    setHexNavList(filtered.map(function(x) { return x.id; }));
    var hexButtons = document.querySelectorAll('#cat-table [data-hex]');
    for (var hb = 0; hb < hexButtons.length; hb++) {
      hexButtons[hb].addEventListener('click', function(ev) {
        ev.stopPropagation();
        openHexViewer(this.getAttribute('data-hex'));
      });
    }

    // Pagination
    var pagerHtml = '<button class="nd-btn" id="cat-prev" ' + (catalogState.page <= 0 ? 'disabled' : '') + '>Prev</button>';
    pagerHtml += '<span>Page ' + (catalogState.page + 1) + ' of ' + totalPages + '</span>';
    pagerHtml += '<button class="nd-btn" id="cat-next" ' + (catalogState.page >= totalPages - 1 ? 'disabled' : '') + '>Next</button>';
    document.getElementById('cat-pager').innerHTML = pagerHtml;

    document.getElementById('cat-prev').addEventListener('click', function() {
      if (catalogState.page > 0) { catalogState.page--; updateCatalogResults(); }
    });
    document.getElementById('cat-next').addEventListener('click', function() {
      if (catalogState.page < totalPages - 1) { catalogState.page++; updateCatalogResults(); }
    });

    // Sort headers
    var ths = document.querySelectorAll('#cat-table th');
    for (var t = 0; t < ths.length; t++) {
      ths[t].addEventListener('click', function() {
        var col = parseInt(this.getAttribute('data-col'));
        if (catalogState.sortCol === col) {
          catalogState.sortDir = catalogState.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          catalogState.sortCol = col;
          catalogState.sortDir = 'asc';
        }
        updateCatalogResults();
      });
    }
  }

  function filterCatalog(query) {
    var base = catalogState.media === 'all'
      ? CATALOG.slice()
      : CATALOG.filter(function(e) { return mediaOf(e) === catalogState.media; });
    if (catalogState.condition === 'ok') base = base.filter(function(e) { return !isDamaged(e); });
    else if (catalogState.condition === 'damaged') base = base.filter(isDamaged);
    if (catalogState.contributor) {
      base = base.filter(function(e) {
        return e.provenance && e.provenance.contributor === catalogState.contributor;
      });
    }
    if (catalogState.unmatched) base = base.filter(function(e) { return !e.productId; });
    if (!query) return base;
    var q = query.toLowerCase();
    return base.filter(function(e) {
      if (e.id && e.id.toLowerCase().indexOf(q) >= 0) return true;
      if (e.volumeName && e.volumeName.toLowerCase().indexOf(q) >= 0) return true;
      if (e.volumeLabel && e.volumeLabel.toLowerCase().indexOf(q) >= 0) return true;
      // the name the imaging gave it, e.g. ND-disk-00283 - often the only name
      // a floppy has, and the one written on its label
      if (e.storage && e.storage.git && e.storage.git.imagePath &&
          e.storage.git.imagePath.toLowerCase().indexOf(q) >= 0) return true;
      if (e.provenance && e.provenance.originalPath &&
          e.provenance.originalPath.toLowerCase().indexOf(q) >= 0) return true;
      if (e.filesystem && e.filesystem.toLowerCase().indexOf(q) >= 0) return true;
      if (e.productId && e.productId.toLowerCase().indexOf(q) >= 0) return true;
      if (e.productId && productMap[e.productId] && productMap[e.productId].name.toLowerCase().indexOf(q) >= 0) return true;
      if (e.version && e.version.toLowerCase().indexOf(q) >= 0) return true;
      if (e.bootFormat && e.bootFormat.toLowerCase().indexOf(q) >= 0) return true;
      if (e.md5 && e.md5.toLowerCase().indexOf(q) >= 0) return true;
      if (e.mediaRole && e.mediaRole.toLowerCase().indexOf(q) >= 0) return true;
      if (e.tags) {
        for (var t = 0; t < e.tags.length; t++) {
          if (e.tags[t].toLowerCase().indexOf(q) >= 0) return true;
        }
      }
      if (e.ndfs && e.ndfs.files) {
        for (var nf = 0; nf < e.ndfs.files.length; nf++) {
          if (e.ndfs.files[nf].name.toLowerCase().indexOf(q) >= 0) return true;
        }
      }
      // MS-DOS floppies: the whole tree, subdirectories included
      if (e.dosFiles) {
        for (var df = 0; df < e.dosFiles.length; df++) {
          if (e.dosFiles[df].path.toLowerCase().indexOf(q) >= 0) return true;
        }
      }
      // BACKUP-SYSTEM volumes have no directory - the ANSI labels are the listing
      if (e.backupFiles) {
        for (var bf = 0; bf < e.backupFiles.length; bf++) {
          if (e.backupFiles[bf].name.toLowerCase().indexOf(q) >= 0) return true;
        }
      }
      if (e.backupSet && e.backupSet.name && e.backupSet.name.toLowerCase().indexOf(q) >= 0) return true;
      return false;
    });
  }

  function sortEntries(arr, col, dir) {
    var sorted = arr.slice();
    sorted.sort(function(a, b) {
      var av, bv;
      switch (col) {
        case 0:
          av = (a.volumeName || a.volumeLabel || a.id || '').toLowerCase();
          bv = (b.volumeName || b.volumeLabel || b.id || '').toLowerCase();
          break;
        case 1: av = (a.filesystem || '').toLowerCase(); bv = (b.filesystem || '').toLowerCase(); break;
        case 2: av = (a.productId || '').toLowerCase(); bv = (b.productId || '').toLowerCase(); break;
        case 3: av = (a.version || '').toLowerCase(); bv = (b.version || '').toLowerCase(); break;
        case 4: av = a.imageSizeBytes || 0; bv = b.imageSizeBytes || 0; return dir === 'asc' ? av - bv : bv - av;
        case 5: av = (a.bootFormat || '').toLowerCase(); bv = (b.bootFormat || '').toLowerCase(); break;
        case 6:
          av = (a.ndfs && a.ndfs.files) ? a.ndfs.files.length : 0;
          bv = (b.ndfs && b.ndfs.files) ? b.ndfs.files.length : 0;
          return dir === 'asc' ? av - bv : bv - av;
        default: av = ''; bv = '';
      }
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }

  // ── Products ─────────────────────────────────────────────────
  var productsState = { query: '', category: null, sortCol: null, sortDir: 'asc' };
  var productsDebounce;

  // Pre-compute image counts (static data, won't change)
  var imgCount = {};
  for (var ic = 0; ic < CATALOG.length; ic++) {
    if (CATALOG[ic].productId) {
      imgCount[CATALOG[ic].productId] = (imgCount[CATALOG[ic].productId] || 0) + 1;
    }
  }

  function renderProducts() {
    var html = '<h2>Products (' + PRODUCTS.length + ')</h2>';
    html += '<div class="nd-search-bar"><input class="nd-input" type="text" id="prod-search" placeholder="Search products..." value="' + esc(productsState.query) + '"></div>';
    html += '<div class="nd-chips" id="prod-chips"></div>';
    html += '<p id="prod-count" style="font-size:0.85rem;color:var(--text-muted);margin-bottom:0.5rem"></p>';
    html += '<div id="prod-results"></div>';

    view.innerHTML = html;

    var searchInput = document.getElementById('prod-search');
    searchInput.addEventListener('input', function() {
      clearTimeout(productsDebounce);
      productsDebounce = setTimeout(function() {
        productsState.query = searchInput.value;
        updateProductsResults();
      }, 200);
    });

    updateProductChips();
    updateProductsResults();
  }

  function updateProductChips() {
    var chipsHtml = '<span class="nd-chip' + (productsState.category === null ? ' nd-chip-active' : '') + '" data-cat="">All</span>';
    for (var i = 0; i < CATEGORIES.length; i++) {
      var cat = CATEGORIES[i];
      var active = productsState.category === cat.id ? ' nd-chip-active' : '';
      chipsHtml += '<span class="nd-chip' + active + '" data-cat="' + esc(cat.id) + '">' + esc(cat.name) + '</span>';
    }
    document.getElementById('prod-chips').innerHTML = chipsHtml;

    var chips = document.querySelectorAll('.nd-chip');
    for (var i = 0; i < chips.length; i++) {
      chips[i].addEventListener('click', function() {
        var cat = this.getAttribute('data-cat');
        productsState.category = cat || null;
        updateProductChips();
        updateProductsResults();
      });
    }
  }

  function updateProductsResults() {
    var filtered = PRODUCTS.filter(function(p) {
      if (productsState.category) {
        if (!p.categories || p.categories.indexOf(productsState.category) < 0) return false;
      }
      if (productsState.query) {
        var q = productsState.query.toLowerCase();
        if (p.id.toLowerCase().indexOf(q) < 0 && p.name.toLowerCase().indexOf(q) < 0 &&
            (!p.description || p.description.toLowerCase().indexOf(q) < 0)) return false;
      }
      return true;
    });

    if (productsState.sortCol !== null) {
      filtered = sortProducts(filtered, productsState.sortCol, productsState.sortDir, imgCount);
    }

    document.getElementById('prod-count').textContent = filtered.length + ' products';

    var html = '<table class="nd-table" id="prod-table">';
    html += '<colgroup><col style="width:12%"><col style="width:33%"><col style="width:20%"><col style="width:14%"><col style="width:10%"><col style="width:11%"></colgroup>';
    html += '<thead><tr>';
    var prodCols = ['ID', 'Name', 'Categories', 'Platform', 'Images', 'Docs'];
    for (var pc = 0; pc < prodCols.length; pc++) {
      var parrow = '';
      if (productsState.sortCol === pc) parrow = productsState.sortDir === 'asc' ? ' \\u25B2' : ' \\u25BC';
      html += '<th data-col="' + pc + '">' + prodCols[pc] + parrow + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (var i = 0; i < filtered.length; i++) {
      var p = filtered[i];
      var cats = '';
      if (p.categories) {
        for (var c = 0; c < p.categories.length; c++) {
          var cn = categoryMap[p.categories[c]] ? categoryMap[p.categories[c]].name : p.categories[c];
          cats += '<span class="nd-badge nd-badge-info" style="margin-right:0.25rem">' + esc(cn) + '</span>';
        }
      }
      var plat = '';
      if (p.platform) {
        for (var pl = 0; pl < p.platform.length; pl++) {
          plat += '<span class="nd-badge nd-badge-os" style="margin-right:0.25rem">' + esc(p.platform[pl]) + '</span>';
        }
      }
      var count = imgCount[p.id] || 0;
      html += '<tr>';
      html += '<td><a href="#/products/' + encodeURIComponent(p.id) + '">' + esc(p.id) + '</a></td>';
      html += '<td>' + esc(p.name) + '</td>';
      html += '<td>' + cats + '</td>';
      html += '<td>' + plat + '</td>';
      html += '<td>' + (count > 0 ? '<span class="nd-badge nd-badge-ok">' + count + '</span>' : '<span style="color:var(--text-muted)">0</span>') + '</td>';
      html += '<td>' + docMarks(p) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('prod-results').innerHTML = html;

    // Sort headers
    var pths = document.querySelectorAll('#prod-table th');
    for (var pt = 0; pt < pths.length; pt++) {
      pths[pt].addEventListener('click', function() {
        var col = parseInt(this.getAttribute('data-col'));
        if (productsState.sortCol === col) {
          productsState.sortDir = productsState.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          productsState.sortCol = col;
          productsState.sortDir = 'asc';
        }
        updateProductsResults();
      });
    }
  }

  function sortProducts(arr, col, dir, imgCount) {
    var sorted = arr.slice();
    sorted.sort(function(a, b) {
      var av, bv;
      switch (col) {
        case 0: av = a.id.toLowerCase(); bv = b.id.toLowerCase(); break;
        case 1: av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
        case 2: av = (a.categories || []).join(',').toLowerCase(); bv = (b.categories || []).join(',').toLowerCase(); break;
        case 3: av = (a.platform || []).join(',').toLowerCase(); bv = (b.platform || []).join(',').toLowerCase(); break;
        case 4: av = imgCount[a.id] || 0; bv = imgCount[b.id] || 0; return dir === 'asc' ? av - bv : bv - av;
        case 5: av = docScore(a); bv = docScore(b); return dir === 'asc' ? av - bv : bv - av;
        default: av = ''; bv = '';
      }
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });
    return sorted;
  }

  // ── About ────────────────────────────────────────────────────
  function renderAbout() {
    var totalFiles = 0;
    for (var i = 0; i < CATALOG.length; i++) {
      if (CATALOG[i].ndfs && CATALOG[i].ndfs.files) totalFiles += CATALOG[i].ndfs.files.length;
    }

    view.innerHTML =
      '<div class="nd-about" style="max-width:820px">' +

      '<h2>About this project</h2>' +
      '<p style="font-size:1.05rem;line-height:1.7;margin-bottom:1.5rem">' +
        'The Norsk Data Software Archive is a preservation project dedicated to saving the software heritage of ' +
        '<strong>Norsk Data</strong>, a Norwegian minicomputer manufacturer that operated from 1967 to 1998. ' +
        'Norsk Data produced the NORD and ND series of minicomputers, running the SINTRAN operating system.' +
      '</p>' +

      '<div class="nd-card" style="margin-bottom:1rem">' +
        '<h3>What we preserve</h3>' +
        '<p>This archive contains floppy disk images from Norsk Data systems &mdash; operating systems, ' +
        'programming languages, office applications, test programs, database tools, and more. ' +
        'Each image is stored with its complete metadata: filesystem contents, checksums, provenance, ' +
        'and label photographs.</p>' +
        '<div class="nd-quick-stats" style="margin-top:1rem">' +
          ndQuickStat(CATALOG.length, 'Disk Images', 'Total preserved floppy disk images') +
          ndQuickStat(PRODUCTS.length, 'Products', 'Known Norsk Data software products') +
          ndQuickStat(totalFiles, 'Files', 'Individual files across all disk images') +
          ndQuickStat(CATEGORIES.length, 'Categories', 'Software categories') +
        '</div>' +
      '</div>' +

      '<div class="nd-card" style="margin-bottom:1rem">' +
        '<h3>Why this matters</h3>' +
        '<p>Norsk Data minicomputers were widely used in Scandinavian universities, research institutions, ' +
        'and industry throughout the 1970s and 1980s. As the original hardware deteriorates and floppy disks degrade, ' +
        'the software that ran on these machines risks being lost forever.</p>' +
        '<p style="margin-top:0.5rem">This project captures the raw disk images before the physical media fails, ' +
        'extracts and catalogs the NDFS filesystem contents, and makes everything searchable and accessible ' +
        'for researchers, historians, and anyone interested in computing history.</p>' +
      '</div>' +

      '<div class="nd-card" style="margin-bottom:1rem">' +
        '<h3>How it works</h3>' +
        '<ul style="line-height:1.8">' +
          '<li>Physical floppy disks are imaged using preservation-grade hardware like the ' +
            '<a href="https://kryoflux.com/" target="_blank" rel="noopener">Kryoflux</a> and ' +
            '<a href="https://github.com/keirf/greaseweazle" target="_blank" rel="noopener">Greaseweazle</a></li>' +
          '<li>Raw images are compressed and stored in git, each in a folder named by its MD5 hash</li>' +
          '<li>The NDFS filesystem on each disk is parsed to extract file listings, dates, and checksums</li>' +
          '<li>BPUN (Binary Package) files are validated against their embedded checksums</li>' +
          '<li>Products are matched by parsing volume names and cross-referencing the ND product catalog</li>' +
          '<li>Label photographs are preserved alongside the disk images</li>' +
        '</ul>' +
      '</div>' +

      '<div class="nd-card" style="margin-bottom:1rem">' +
        '<h3>The NDFS filesystem</h3>' +
        '<p>Norsk Data File System (NDFS) is the native filesystem used on ND minicomputers. ' +
        'This site includes a client-side NDFS parser that can read any disk image directly in your browser &mdash; ' +
        'browse files, view hex dumps, extract individual files, and validate BPUN checksums, ' +
        'all without any server-side processing.</p>' +
      '</div>' +

      '<div class="nd-card" style="margin-bottom:1rem">' +
        '<h3>Contributing</h3>' +
        '<p>If you have Norsk Data floppy disks, hard disk images, documentation, or other artifacts, ' +
        'we would love to hear from you. Every preserved disk adds to our understanding of this ' +
        'important chapter in Scandinavian computing history.</p>' +
      '</div>' +

      '<div class="nd-card" style="margin-bottom:1rem">' +
        '<h3>Links</h3>' +
        '<ul style="line-height:2">' +
          '<li><a href="https://github.com/RetroCoreLabs/norskdata-software-archive" target="_blank" rel="noopener">Source code on GitHub</a></li>' +
          '<li><a href="https://github.com/RetroCoreLabs/norskdata-software-archive/issues" target="_blank" rel="noopener">Report issues or contribute</a></li>' +
          '<li><a href="https://github.com/RetroCoreLabs" target="_blank" rel="noopener">RetroCoreLabs on GitHub</a></li>' +
        '</ul>' +
      '</div>' +

      '</div>';
  }

  // ── Product Detail ───────────────────────────────────────────
  // Quiet presence markers for the products table: ID = Program/Installation
  // Description, PI = Product Information sheet. Muted and unbadged on purpose -
  // 334 of 444 products have at least one, so a badge here would shout on most rows.
  function docMarks(product) {
    var d = product.docs;
    if (!d) return '';
    var out = '';
    out += docMark(d.installationDescription, 'ID', 'Program / Installation Description');
    out += docMark(d.productInfo, 'PI', 'Product Information sheet');
    return out;
  }

  // One marker, linked straight to the rendered document. With several documents
  // of the same kind the marker carries a count and links to the first; the rest
  // are listed on the product page.
  function docMark(ids, label, kindLabel) {
    if (!ids || !ids.length) return '';
    var title = ids.length === 1
      ? kindLabel + ': ' + (DOC_TITLES[ids[0]] || ids[0])
      : ids.length + ' ' + kindLabel + 's - opens ' + (DOC_TITLES[ids[0]] || ids[0]);
    return '<a class="nd-docmark" href="docs/' + encodeURIComponent(ids[0]) + '.html" title="' + esc(title) + '">' +
           label + (ids.length > 1 ? '<sup>' + ids.length + '</sup>' : '') + '</a>';
  }

  function docScore(product) {
    var d = product.docs || {};
    return ((d.installationDescription && d.installationDescription.length) ? 2 : 0) +
           ((d.productInfo && d.productInfo.length) ? 1 : 0);
  }

  // ND documentation attached to this product. The documents are pre-rendered
  // to site/docs/<id>.html at build time and linked, not inlined - together they
  // are ~4 MB and a reader opens one at a time.
  function renderProductDocs(product) {
    if (!product.docs) return '';
    var groups = [
      ['installationDescription', 'Installation Description'],
      ['productInfo', 'Product Information']
    ];
    var out = '';
    for (var g = 0; g < groups.length; g++) {
      var ids = product.docs[groups[g][0]];
      if (!ids || !ids.length) continue;
      out += '<div style="margin-bottom:0.75rem">';
      out += '<div style="color:var(--text-muted);font-size:0.85rem;margin-bottom:0.25rem">' + esc(groups[g][1]) + '</div>';
      for (var i = 0; i < ids.length; i++) {
        var t = DOC_TITLES[ids[i]] || ids[i];
        out += '<div><a href="docs/' + encodeURIComponent(ids[i]) + '.html"><code>' + esc(ids[i]) + '</code></a> &ndash; ' + esc(t) + '</div>';
      }
      out += '</div>';
    }
    if (!out) return '';
    return '<div class="nd-card" style="margin-bottom:1rem"><h3 style="margin-top:0">Documentation</h3>' + out + '</div>';
  }

  function renderProductDetail(pid) {
    var product = productMap[pid];
    var pName = product ? product.name : pid;

    // Filter catalog entries for this product
    var entries = CATALOG.filter(function(e) { return e.productId === pid; });

    var html = '<p style="margin-bottom:0.5rem"><a href="#/products">&larr; Products</a></p>';
    html += '<h2>' + esc(pid) + ' - ' + esc(pName) + '</h2>';

    if (product) {
      if (product.description) html += '<p style="color:var(--text-muted);margin-bottom:0.5rem">' + esc(product.description) + '</p>';
      var meta = '';
      if (product.categories && product.categories.length) {
        for (var c = 0; c < product.categories.length; c++) {
          var cn = categoryMap[product.categories[c]] ? categoryMap[product.categories[c]].name : product.categories[c];
          meta += '<span class="nd-badge nd-badge-info" style="margin-right:0.25rem">' + esc(cn) + '</span>';
        }
      }
      if (product.platform && product.platform.length) {
        for (var pl = 0; pl < product.platform.length; pl++) {
          meta += '<span class="nd-badge nd-badge-os" style="margin-right:0.25rem">' + esc(product.platform[pl]) + '</span>';
        }
      }
      if (meta) html += '<p style="margin-bottom:1rem">' + meta + '</p>';
      html += renderProductDocs(product);
    }

    html += '<p><span class="nd-badge">' + entries.length + ' image' + (entries.length !== 1 ? 's' : '') + '</span></p>';

    if (entries.length === 0) {
      html += '<div class="nd-placeholder"><p>No floppy images matched to this product yet.</p></div>';
      view.innerHTML = html;
      return;
    }

    // Group by version
    var byVersion = {};
    var versionOrder = [];
    for (var i = 0; i < entries.length; i++) {
      var ver = entries[i].version || '(unknown)';
      if (!byVersion[ver]) { byVersion[ver] = []; versionOrder.push(ver); }
      byVersion[ver].push(entries[i]);
    }
    versionOrder.sort();

    for (var v = 0; v < versionOrder.length; v++) {
      var ver = versionOrder[v];
      var ventries = byVersion[ver];
      html += '<div class="nd-version-group">';
      html += '<div class="nd-version-header">Version ' + esc(ver) + ' (' + ventries.length + ' image' + (ventries.length !== 1 ? 's' : '') + ')</div>';
      html += '<div class="nd-version-body">';

      // Collect set photos from entries in this version
      var versionSetPhotos = [];
      for (var ei = 0; ei < ventries.length; ei++) {
        var vGit = ventries[ei].storage && ventries[ei].storage.git;
        if (vGit && vGit.setPhotos && vGit.setPhotos.length > 0) {
          for (var sp = 0; sp < vGit.setPhotos.length; sp++) {
            if (versionSetPhotos.indexOf(vGit.setPhotos[sp]) < 0) {
              versionSetPhotos.push(vGit.setPhotos[sp]);
            }
          }
        }
      }
      if (versionSetPhotos.length > 0) {
        html += '<div class="nd-photo-gallery" style="margin-bottom:0.75rem">';
        for (var sp = 0; sp < versionSetPhotos.length; sp++) {
          html += photoImg(versionSetPhotos[sp]);
        }
        html += '</div>';
      }

      for (var ei = 0; ei < ventries.length; ei++) {
        html += renderImageCard(ventries[ei]);
      }

      html += '</div></div>';
    }

    view.innerHTML = html;
  }

  // ── Disk Detail ──────────────────────────────────────────────
  function renderDiskDetail(diskId) {
    var entry = null;
    for (var i = 0; i < CATALOG.length; i++) {
      if (CATALOG[i].id === diskId) { entry = CATALOG[i]; break; }
    }

    if (!entry) {
      view.innerHTML = '<div class="nd-placeholder"><h2>Not Found</h2><p>Disk "' + esc(diskId) + '" not found in catalog.</p></div>';
      return;
    }

    var html = '<p style="margin-bottom:0.5rem"><a href="#/catalog">&larr; Catalog</a>';
    if (entry.productId) {
      html += ' | <a href="#/products/' + encodeURIComponent(entry.productId) + '">' + esc(entry.productId) + '</a>';
    }
    html += '</p>';

    html += '<h2>' + esc(entry.volumeName || entry.id) + '</h2>';
    html += renderImageCard(entry, true);

    view.innerHTML = html;
    bindRepairedDownload(view);
    view.querySelectorAll('[data-hex-read]').forEach(function(b) {
      b.addEventListener('click', function() { openHexViewer(this.getAttribute('data-hex-read')); });
    });
  }

  /**
   * Build a readable copy of a damaged floppy and hand it to the browser.
   *
   * The archive stores only what came off the physical disk, so the repaired
   * image does not exist anywhere: it is made here, from the original, by
   * writing back the master block pointers the recovery worked out.
   */
  function bindRepairedDownload(root) {
    var buttons = root.querySelectorAll('[data-recover-dl]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function() {
        var id = this.getAttribute('data-recover-dl');
        var entry = catalogMap[id];
        var rec = entry && entry.condition && entry.condition.recovery;
        if (!rec || typeof applyLayout === 'undefined') { alert('Recovery data not available in this build'); return; }
        var btn = this;
        btn.disabled = true;
        var was = btn.textContent;
        btn.textContent = 'Building...';
        loadImageBytes(id).then(function(bytes) {
          var aligned = bytes.length % 2048 === 0 ? bytes
            : (function() { var b = new Uint8Array(Math.ceil(bytes.length / 2048) * 2048); b.set(bytes); return b; })();
          var repaired = applyLayout(aligned, {
            object: { blockId: rec.layout.object, type: 1 },
            user: { blockId: rec.layout.user, type: 1 },
            bit: { blockId: rec.layout.bit, type: 0 },
          });
          var base = (entry.storage && entry.storage.git && entry.storage.git.imagePath || id)
            .split('/').pop().replace(/\\.img\\.gz$/, '').replace(/\\.img$/, '');
          downloadBytes(repaired, base + '-repaired.img');
          btn.disabled = false; btn.textContent = was;
        }).catch(function(err) {
          alert('Could not build the repaired image: ' + err);
          btn.disabled = false; btn.textContent = was;
        });
      });
    }
  }

  /** The name the imaging gave a disk, e.g. ND-disk-00055b. */
  function imageName(e) {
    var p = e.storage && e.storage.git && e.storage.git.imagePath;
    if (!p) return null;
    return p.split('/').pop().replace(/\.img\.gz$/i, '').replace(/\.img$/i, '');
  }

  // ── Image Card (shared) ──────────────────────────────────────
  function renderImageCard(e, full) {
    var html = '<div class="nd-card">';

    // ── Header: what the disk is called, then what the imaging called it ──
    // A DOS floppy has a FAT label rather than an NDFS volume name, and a
    // floppy with neither is only ever known by its image file name - showing
    // the entry id there told nobody anything.
    var file = imageName(e);
    var title = e.volumeName || e.volumeLabel || file || e.id;
    html += '<h3 style="font-family:Consolas,monospace;font-size:1.3rem;margin-bottom:0.25rem">' +
      '<a href="#/disks/' + encodeURIComponent(e.id) + '" style="color:var(--text)">' + esc(title) + '</a>' +
      (file && file !== title
        ? ' <span class="nd-text-muted" style="font-size:0.85rem;font-weight:normal">' + esc(file) + '</span>'
        : '') + '</h3>';

    if (e.productId) {
      var prodName = '';
      for (var pi = 0; pi < PRODUCTS.length; pi++) {
        if (PRODUCTS[pi].id === e.productId) { prodName = PRODUCTS[pi].name; break; }
      }
      html += '<div style="margin-bottom:0.75rem"><a href="#/products/' + encodeURIComponent(e.productId) + '"><code>' + esc(e.productId) + '</code>' +
        (prodName ? ' &mdash; ' + esc(prodName) : '') + '</a></div>';
    }

    // ── Badges row ──
    html += '<div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-bottom:0.75rem">';
    if (e.version) html += '<span class="nd-badge nd-badge-os" title="Software version/revision letter">' + esc('Version ' + e.version) + '</span>';
    if (e.diskNumber != null) html += '<span class="nd-badge" title="Disk number in a multi-disk set">Disk ' + e.diskNumber + '</span>';
    if (e.tags && e.tags.length) {
      for (var t = 0; t < e.tags.length; t++) {
        html += '<span class="nd-badge nd-badge-product">' + esc(e.tags[t]) + '</span>';
      }
    }
    html += '</div>';

    // ── Quick stats row ──
    html += '<div class="nd-quick-stats">';
    if (e.bootFormat) html += ndQuickStat(esc(e.bootFormat), 'Boot Format', 'How the floppy boots: none = not bootable, flomon = ND floppy monitor, binary = raw bootstrap, bpun = packaged binary');
    if (e.totalPages != null) html += ndQuickStat(e.totalPages, 'NDFS Pages', 'NDFS filesystem pages (1 page = ' + (e.pageSize || 1024) + ' bytes)');
    if (e.imageSizeBytes != null) html += ndQuickStat(formatBytes(e.imageSizeBytes), 'Image Size', 'Total size of the disk image file');
    if (e.ndfs && e.ndfs.files) html += ndQuickStat(e.ndfs.files.length, 'Files on Disk', 'Number of files stored on the floppy');
    html += '</div>';

    // ── Action buttons ──
    if (full && e.storage && e.storage.git && e.storage.git.imagePath) {
      html += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem">';
      html += '<a href="' + esc(rawUrl(e.storage.git.imagePath)) + '" class="nd-btn nd-btn-sm" download>Download .img.gz</a>';
      if (e.condition && e.condition.recovery) {
        // The archive keeps only what came off the physical floppy. A readable
        // copy is built here in the browser when someone asks for one.
        html += '<button class="nd-btn nd-btn-sm" data-recover-dl="' + esc(e.id) +
          '" title="The original image with the master block pointers rebuilt, so an emulator or the NDFS viewer can read it. Built now from the original - the archive stores only the original.">' +
          'Download repaired .img</button>';
      }
      if (e.storageClass === 'floppy-in-git') {
        // Offer the viewer that suits what the image actually holds. Opening the
        // NDFS viewer on a DOS disk or a backup volume only produces an error.
        var idArg = esc(e.id).replace(/'/g, "\\'");
        var fsKind = e.filesystem;
        if (fsKind === 'dos') {
          html += '<button class="nd-btn nd-btn-primary nd-btn-sm" onclick="openDosViewer(\\'' + idArg + '\\')">Open in DOS viewer</button>';
        } else if (fsKind === 'backup' || fsKind === 'winch') {
          html += '<button class="nd-btn nd-btn-primary nd-btn-sm" onclick="openBackupViewer(\\'' + idArg + '\\')">Open in backup viewer</button>';
        } else if (!fsKind || fsKind === 'ndfs') {
          html += '<button class="nd-btn nd-btn-primary nd-btn-sm" onclick="openNdfsViewer(\\'' + idArg + '\\')">Open in NDFS Viewer</button>';
        }
        // The bytes are worth looking at whatever the image holds - and for an
        // image with no filesystem at all they are the only thing there is.
        var hexLabel = esc(e.volumeName || e.volumeLabel || e.id).replace(/'/g, "\\'");
        html += '<button class="nd-btn nd-btn-sm" onclick="openHexViewer(\\'' + idArg + '\\', \\'' + hexLabel + '\\')">Open in HEX viewer</button>';
      }
      html += '</div>';
    }

    // ── MS-DOS directory tree ──
    // Recorded at import, so the listing is here without fetching the image.
    if (full && e.dosFiles && e.dosFiles.length) {
      var dosDirs = 0, dosBytes = 0;
      for (var dfi = 0; dfi < e.dosFiles.length; dfi++) {
        if (e.dosFiles[dfi].directory) dosDirs++; else dosBytes += e.dosFiles[dfi].bytes || 0;
      }
      html += '<h3 style="margin:1rem 0 0.35rem">Files on this disk</h3>';
      html += '<p class="nd-text-muted" style="margin:0 0 0.5rem;font-size:0.85rem">' +
        (e.dosFiles.length - dosDirs) + ' file(s) in ' + (dosDirs + 1) + ' director' + (dosDirs ? 'ies' : 'y') +
        ', ' + formatBytes(dosBytes) + ' in total.</p>';
      html += '<div style="overflow-x:auto;max-height:60vh"><table class="nd-table nd-table-compact"><thead><tr>' +
        '<th>Name</th><th style="text-align:right">Size</th><th>Modified</th></tr></thead><tbody>';
      e.dosFiles.forEach(function(f) {
        var depth = f.path.split('/').length - 1;
        var leaf = f.path.split('/').pop();
        html += '<tr><td style="padding-left:' + (0.5 + depth * 1.2) + 'rem"><code>' +
          (f.directory ? '&#128193; ' : '') + esc(leaf) + '</code></td>' +
          '<td style="text-align:right">' + (f.directory ? '<span class="nd-text-muted">&lt;DIR&gt;</span>' : f.bytes.toLocaleString()) + '</td>' +
          '<td class="nd-text-muted">' + esc(f.modified || '') + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }

    // ── BACKUP-SYSTEM listing ──
    // The ANSI labels are the only listing this format has, and they were
    // recorded at import - so the files show here without fetching the image.
    if (full && e.backupFiles && e.backupFiles.length) {
      var liveB = e.backupFiles.filter(function(f) { return !f.stale; });
      var staleB = e.backupFiles.length - liveB.length;
      html += '<h3 style="margin:1rem 0 0.35rem">Files on this volume</h3>';
      html += '<p class="nd-text-muted" style="margin:0 0 0.5rem;font-size:0.85rem">' +
        'SINTRAN III BACKUP-SYSTEM &middot; ' + liveB.length + ' file(s)' +
        (staleB ? ', ' + staleB + ' label(s) left from an older backup on the same media' : '') +
        (e.backupSet && e.backupSet.runDate ? ' &middot; ' + esc(e.backupSet.runDate) : '') +
        (e.backupSet && e.backupSet.system ? ' &middot; ' + esc(e.backupSet.system) : '') + '</p>';
      html += '<div style="overflow-x:auto;max-height:60vh"><table class="nd-table nd-table-compact"><thead><tr>' +
        '<th>File</th><th style="text-align:right">Bytes</th><th>Created</th></tr></thead><tbody>';
      e.backupFiles.forEach(function(f) {
        html += '<tr' + (f.stale ? ' class="nd-text-muted"' : '') + '><td><code>' + esc(f.name) + '</code>' +
          (f.continued ? ' <span class="nd-badge nd-badge-warn" style="font-size:0.65rem">continues on the next volume</span>' : '') +
          (f.stale ? ' <span style="font-size:0.7rem">stale</span>' : '') + '</td>' +
          '<td style="text-align:right">' + (f.bytes || 0).toLocaleString() + '</td>' +
          '<td class="nd-text-muted">' + esc(f.created || '') + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }

    // ── WINCH-TO-FLOPP: no file names exist on the media ──
    if (full && e.filesystem === 'winch' && e.backupSet) {
      html += '<h3 style="margin:1rem 0 0.35rem">What is on this volume</h3>';
      html += '<p class="nd-text-muted" style="margin:0 0 0.5rem;font-size:0.85rem">' +
        'WINCH-TO-FLOPP backup of directory <code>' + esc(e.backupSet.name) + '</code>, volume ' +
        e.backupSet.volumeNumber + ' of ' + e.backupSet.totalVolumes + ', ' + (e.backupSet.pageCount || 0) +
        ' page(s) stored' +
        (e.backupSet.pageFirst !== null && e.backupSet.pageFirst !== undefined
          ? ' (original pages ' + e.backupSet.pageFirst + ' to ' + e.backupSet.pageLast + ')' : '') +
        '. This format stores no file names on the media: they appear only when every volume of the set is ' +
        'reassembled. The backup viewer shows the page map and the state of the whole set.</p>';
    }

    // ── Other reads of the same physical floppy ──
    // A floppy that read badly was read again, so the archive can hold several
    // images of one disk. Showing them together says which attempt is the one
    // worth looking at, and that a disk was troublesome to read at all.
    if (typeof groupReads !== 'undefined' && full) {
      var mine = diskOf(e);
      var sameDisk = CATALOG.filter(function(x) { return diskOf(x) === mine; });
      if (sameDisk.length > 1) {
        var grp = groupReads(sameDisk)[0];
        var GR = { clean: ['nd-badge-ok', 'reads clean'], recovered: ['nd-badge-info', 'recovered'],
                   other: ['nd-badge', 'other filesystem'], damaged: ['nd-badge-warn', 'damaged'],
                   empty: ['nd-badge-warn', 'no filesystem'] };
        html += '<h3 style="margin:1rem 0 0.35rem">Reads of this floppy</h3>';
        html += '<p class="nd-text-muted" style="margin:0 0 0.5rem;font-size:0.85rem">' +
          'This physical disk was read ' + grp.reads.length + ' times' +
          (grp.bad ? ' and no attempt produced a readable filesystem' : '') + '. ' + esc(describeGroup(grp)) + '.</p>';
        html += '<div style="overflow-x:auto"><table class="nd-table nd-table-compact"><thead><tr>' +
          '<th>Image</th><th>MD5</th><th>Status</th><th style="text-align:right">Files</th>' +
          '<th style="text-align:right">Size</th><th></th></tr></thead><tbody>';
        grp.reads.forEach(function(r) {
          var badge = GR[r.grade] || ['nd-badge', r.grade];
          var isThis = r.id === e.id;
          html += '<tr>' +
            '<td><a href="#/disks/' + encodeURIComponent(r.id) + '"><code>' + esc(r.name) + '</code></a>' +
            (isThis ? ' <span class="nd-badge nd-badge-info" style="font-size:0.65rem">this one</span>' : '') +
            (r.best ? ' <span class="nd-text-muted" style="font-size:0.75rem">best read</span>' : '') +
            // The file name alone says nothing about whether two rows are the
            // same bytes imported twice; the checksum and the path it came from
            // do.
            (r.source ? '<div class="nd-text-muted" style="font-size:0.75rem">from <code>' + esc(r.source) + '</code></div>' : '') + '</td>' +
            '<td><code style="font-size:0.75rem">' + esc(r.md5 || '') + '</code></td>' +
            '<td><span class="nd-badge ' + badge[0] + '">' + badge[1] + '</span></td>' +
            '<td style="text-align:right">' + (r.files || '-') + ' files</td>' +
            '<td style="text-align:right" class="nd-text-muted">' + (r.imageSizeBytes ? Math.round(r.imageSizeBytes / 1024) + ' KB' : '-') + '</td>' +
            '<td style="text-align:right"><button class="nd-btn nd-btn-sm" data-hex-read="' + esc(r.id) + '">Hex</button></td>' +
            '</tr>';
        });
        html += '</tbody></table></div>';
      }
    }

    // ── NDFS file table (THE MAIN CONTENT) ──
    if (e.condition && e.condition.recovery && e.ndfs && e.ndfs.files && e.ndfs.files.length) {
      var rc = e.condition.recovery;
      html += '<p style="margin:0 0 0.75rem;padding:0.6rem 0.8rem;border:1px solid var(--border);border-radius:6px;font-size:0.85rem">' +
        '<span class="nd-badge nd-badge-warn">recovered listing</span> ' +
        'The master block on this floppy is damaged (' + esc(e.condition.parserError || '') + '). The file list below was not read ' +
        'from an intact filesystem: it comes from rebuilding the master block pointers (object ' + rc.layout.object +
        ', user ' + rc.layout.user + ', bit ' + rc.layout.bit + ') from what readable floppies of this size use. ' +
        rc.namesConfirmedInBytes + ' of ' + rc.filesRecovered + ' names (' + Math.round(rc.confirmRatio * 100) +
        '%) occur in the bytes of the image itself, which is why it is shown at all. Sizes and dates may be wrong.</p>';
    }
    if (e.ndfs && e.ndfs.files && e.ndfs.files.length > 0) {
      var hasAnyDate = false;
      for (var fd = 0; fd < e.ndfs.files.length; fd++) {
        if (e.ndfs.files[fd].dateCreatedStr || e.ndfs.files[fd].lastDateWrittenStr) { hasAnyDate = true; break; }
      }
      html += '<table class="nd-table" style="font-size:0.84rem;margin-bottom:1rem"><thead><tr>' +
        '<th>Name</th><th style="text-align:right">Pages</th><th style="text-align:right">Size</th>' +
        (hasAnyDate ? '<th>Created</th><th>Written</th>' : '') +
        '</tr></thead><tbody>';
      for (var f = 0; f < e.ndfs.files.length; f++) {
        var file = e.ndfs.files[f];
        html += '<tr>';
        html += '<td style="white-space:nowrap"><code style="font-size:0.8rem">' + fileDisplayName(file) + bpunMark(file) + '</code></td>';
        html += '<td style="text-align:right">' + (file.pages != null ? file.pages : '-') + '</td>';
        html += '<td style="text-align:right">' + formatBytes(file.bytes) + '</td>';
        if (hasAnyDate) {
          html += '<td style="color:var(--text-muted);font-size:0.8rem">' + esc(file.dateCreatedStr || '-') + '</td>';
          html += '<td style="color:var(--text-muted);font-size:0.8rem">' + esc(file.lastDateWrittenStr || '-') + '</td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
    }

    // ── Photos (below file table) ──
    if (full && e.storage && e.storage.git) {
      var git = e.storage.git;
      var hasPhotos = (git.diskPhotos && git.diskPhotos.length > 0) || (git.setPhotos && git.setPhotos.length > 0);
      if (hasPhotos) {
        html += '<div style="margin-bottom:1rem">';
        if (git.diskPhotos && git.diskPhotos.length > 0) {
          html += '<div class="nd-photo-gallery">';
          for (var dp = 0; dp < git.diskPhotos.length; dp++) html += photoImg(git.diskPhotos[dp]);
          html += '</div>';
        }
        if (git.setPhotos && git.setPhotos.length > 0) {
          html += '<div class="nd-photo-gallery">';
          for (var sp = 0; sp < git.setPhotos.length; sp++) html += photoImg(git.setPhotos[sp]);
          html += '</div>';
        }
        html += '</div>';
      }
    }

    // ── More details (collapsible, at the bottom -- same style as local UI) ──
    if (full) {
      html += '<details class="nd-details-toggle">';
      html += '<summary>More details</summary>';
      html += '<div class="nd-details-body">';

      // Verification
      html += '<h4 style="margin-bottom:0.5rem;color:var(--accent)">Verification checksums</h4>';
      html += '<dl class="nd-dl">';
      html += '<dt>ID</dt><dd><code class="nd-copyable">' + esc(e.id) + '</code></dd>';
      html += '<dt>MD5</dt><dd><code class="nd-copyable">' + esc(e.md5) + '</code></dd>';
      html += '</dl>';

      // Origin
      if (e.provenance) {
        html += '<h4 style="margin-top:1rem;margin-bottom:0.5rem;color:var(--accent)">Origin</h4>';
        html += '<dl class="nd-dl">';
        if (e.provenance.contributor && e.provenance.contributor !== 'unknown') html += '<dt>Contributed by</dt><dd><code class="nd-copyable">' + esc(e.provenance.contributor) + '</code></dd>';
        if (e.provenance.method) html += '<dt>Imaging method</dt><dd><code class="nd-copyable">' + esc(e.provenance.method) + '</code></dd>';
        if (e.provenance.dateImaged) html += '<dt>Date imaged</dt><dd><code class="nd-copyable">' + esc(e.provenance.dateImaged) + '</code></dd>';
        if (e.provenance.originalPath) html += '<dt>Source file</dt><dd><code class="nd-copyable">' + esc(e.provenance.originalPath) + '</code></dd>';
        if (e.provenance.notes) html += '<dt>Notes</dt><dd><code class="nd-copyable">' + esc(e.provenance.notes) + '</code></dd>';
        html += '</dl>';
      }

      // File location
      if (e.storage) {
        html += '<h4 style="margin-top:1rem;margin-bottom:0.5rem;color:var(--accent)">File location</h4>';
        html += '<dl class="nd-dl">';
        if (e.storage.git && e.storage.git.imagePath) html += '<dt>Local file</dt><dd><code class="nd-copyable">' + esc(e.storage.git.imagePath) + '</code></dd>';
        if (e.storageClass === 'floppy-in-git') {
          html += '<dt>Stored in</dt><dd><code class="nd-copyable">Repository (compressed)</code></dd>';
        }
        if (e.storage.internetArchive && e.storage.internetArchive.itemId && e.storage.internetArchive.syncStatus === 'uploaded') {
          html += '<dt>Internet Archive</dt><dd><a href="https://archive.org/details/' + esc(e.storage.internetArchive.itemId) + '" target="_blank" rel="noopener"><code class="nd-copyable">' + esc(e.storage.internetArchive.itemId) + '</code></a></dd>';
        }
        html += '</dl>';
      }

      // NDFS users removed -- not useful for end users
      if (false && e.ndfs && e.ndfs.users && e.ndfs.users.length > 0) {
        var userStrs = [];
        for (var u = 0; u < e.ndfs.users.length; u++) {
          userStrs.push(esc(e.ndfs.users[u].name) + ' (' + e.ndfs.users[u].pagesUsed + ' pages)');
        }
        html += userStrs.join(', ') + '</p>';
      }

      html += '</div></details>';
    }

    html += '</div>';
    return html;
  }

  // ── Gzip Decompression ──────────────────────────────────────
  function decompressGzip(compressedData) {
    var ds = new DecompressionStream('gzip');
    var writer = ds.writable.getWriter();
    writer.write(compressedData);
    writer.close();
    var reader = ds.readable.getReader();
    var chunks = [];
    return (function readChunk() {
      return reader.read().then(function(result) {
        if (result.done) {
          var total = chunks.reduce(function(s, c) { return s + c.length; }, 0);
          var out = new Uint8Array(total);
          var offset = 0;
          chunks.forEach(function(c) { out.set(c, offset); offset += c.length; });
          return out;
        }
        chunks.push(result.value);
        return readChunk();
      });
    })();
  }

  // ── DOS and backup viewers ──────────────────────────────────
  // The archive holds more than ND floppies: MS-DOS disks, SINTRAN
  // BACKUP-SYSTEM volumes and WINCH-TO-FLOPP directory dumps. The dosfs and
  // ndbackup libraries are inlined above, so these run entirely in the browser -
  // fetch the .img.gz, gunzip it, parse it, no server involved.
  function loadImageBytes(entryId) {
    var entry = catalogMap[entryId];
    if (!entry || !entry.storage || !entry.storage.git || !entry.storage.git.imagePath) {
      return Promise.reject(new Error('No image file for this entry'));
    }
    return fetch(rawUrl(entry.storage.git.imagePath))
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(function(buf) { return decompressGzip(new Uint8Array(buf)); });
  }

  function bytesToText(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var c = bytes[i] & 0x7f;                 // ND text carries the parity bit
      out += (c === 10 || c === 13 || c === 9 || (c >= 0x20 && c <= 0x7e)) ? String.fromCharCode(c) : '.';
    }
    return out;
  }

  function bytesToHex(bytes, limit) {
    var lines = [];
    for (var off = 0; off < bytes.length && off < limit; off += 16) {
      var h = '', a = '';
      for (var i = 0; i < 16; i++) {
        if (off + i >= bytes.length) { h += '   '; continue; }
        var b = bytes[off + i];
        h += (b < 16 ? '0' : '') + b.toString(16) + ' ' + (i === 7 ? ' ' : '');
        var c = b & 0x7f;
        a += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : '.';
      }
      lines.push(('00000000' + off.toString(16)).slice(-8) + '  ' + h + ' |' + a + '|');
    }
    if (bytes.length > limit) lines.push('... truncated at ' + (limit / 1024) + ' KB');
    return lines.join('\\n');
  }

  function downloadBytes(bytes, name) {
    var blob = new Blob([bytes], { type: 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    // NAME:TYPE -> NAME.TYPE: a colon is illegal in a Windows filename.
    a.download = name.replace(/:/g, '.').replace(/[^A-Za-z0-9._-]/g, '_');
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  window.openDosViewer = function(entryId) {
    if (typeof DosVolume === 'undefined') { alert('MS-DOS reader not available in this build'); return; }
    var entry = catalogMap[entryId] || {};
    ndModal.open('<div class="nd-modal-header"><h3>MS-DOS disk - <code>' +
      esc(entry.volumeLabel || entry.volumeName || entryId) + '</code></h3>' +
      '<button class="nd-modal-close" onclick="ndModal.close()">&times;</button></div>' +
      '<div class="nd-modal-body" id="dosbody">Reading image...</div>', { wide: true });
    loadImageBytes(entryId).then(function(bytes) {
      var vol = DosVolume.open(bytes);
      var all = vol.listAll().filter(function(x) { return !x.isVolumeLabel; });
      var cwd = '', selected = null;

      function children(dir) {
        return all.filter(function(x) {
          var cut = x.path.lastIndexOf('/');
          return (cut === -1 ? '' : x.path.slice(0, cut)) === dir;
        });
      }
      function render() {
        var rows = children(cwd);
        var h = '<p class="nd-text-muted" style="margin:0 0 0.5rem">' +
          '<strong>' + esc(vol.info.volumeLabel || '(no label)') + '</strong> &middot; OEM ' + esc(vol.info.oemName.trim()) +
          ' &middot; FAT' + vol.info.fatBits + ' &middot; ' + vol.info.totalBytes.toLocaleString() +
          ' B, ' + vol.info.freeBytes.toLocaleString() + ' B free &middot; ' + all.length + ' entries</p>';
        h += '<p style="margin:0 0 0.5rem"><a href="#" data-dir="">disk root</a>';
        var acc = '';
        (cwd ? cwd.split('/') : []).forEach(function(part) {
          acc = acc ? acc + '/' + part : part;
          h += ' / <a href="#" data-dir="' + esc(acc) + '"><code>' + esc(part) + '</code></a>';
        });
        h += '</p>';
        h += '<div style="max-height:50vh;overflow:auto"><table class="nd-table nd-table-compact"><thead><tr>' +
          '<th>Name</th><th style="text-align:right">Size</th><th>Modified</th></tr></thead><tbody>';
        if (cwd) {
          var up = cwd.indexOf('/') === -1 ? '' : cwd.slice(0, cwd.lastIndexOf('/'));
          h += '<tr data-dir="' + esc(up) + '" style="cursor:pointer"><td><code>&#8593; ..</code></td><td></td><td></td></tr>';
        }
        rows.filter(function(x) { return x.isDirectory; }).forEach(function(x) {
          h += '<tr data-dir="' + esc(x.path) + '" style="cursor:pointer"><td><code>&#128193; ' + esc(x.name) +
            '</code></td><td style="text-align:right" class="nd-text-muted">&lt;DIR&gt;</td><td class="nd-text-muted">' +
            esc(x.modified || '') + '</td></tr>';
        });
        rows.filter(function(x) { return !x.isDirectory; }).forEach(function(x) {
          h += '<tr data-file="' + esc(x.path) + '" style="cursor:pointer"' +
            (selected === x.path ? ' class="ndfs-file-selected"' : '') + '><td><code>' + esc(x.name) +
            '</code></td><td style="text-align:right">' + x.size.toLocaleString() + '</td><td class="nd-text-muted">' +
            esc(x.modified || '') + '</td></tr>';
        });
        h += '</tbody></table></div>';
        h += '<div class="ndfs-file-actions" style="margin-top:0.5rem">' +
          '<span class="ndfs-selected-label">' + (selected ? esc(selected) : 'Select a file') + '</span>' +
          '<button class="nd-btn nd-btn-sm nd-badge-ok" data-act="extract"' + (selected ? '' : ' disabled') + '>Extract</button>' +
          '<button class="nd-btn nd-btn-sm nd-badge-os" data-act="extract-strip"' + (selected ? '' : ' disabled') + '>Extract (strip parity)</button>' +
          '<button class="nd-btn nd-btn-sm nd-badge-info" data-act="hex"' + (selected ? '' : ' disabled') + '>View as hex</button>' +
          '<button class="nd-btn nd-btn-sm nd-badge-patch" data-act="text"' + (selected ? '' : ' disabled') + '>View as text</button>' +
          '</div>';
        var box = document.getElementById('dosbody');
        box.innerHTML = h;
        box.querySelectorAll('[data-dir]').forEach(function(el) {
          el.addEventListener('click', function(ev) { ev.preventDefault(); cwd = this.getAttribute('data-dir') || ''; selected = null; render(); });
        });
        box.querySelectorAll('[data-file]').forEach(function(el) {
          el.addEventListener('click', function() { selected = this.getAttribute('data-file'); render(); });
        });
        box.querySelectorAll('[data-act]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            if (!selected) return;
            var data = vol.readFile(selected);
            if (!data) { alert('Could not read that file'); return; }
            var act = this.getAttribute('data-act');
            var name = selected.split('/').pop();
            if (act === 'extract') downloadBytes(data, name);
            else if (act === 'extract-strip') {
              var st = new Uint8Array(data.length);
              for (var i = 0; i < data.length; i++) st[i] = data[i] & 0x7f;
              downloadBytes(st, name);
            } else {
              box.innerHTML = '<p><button class="nd-btn nd-btn-ghost nd-btn-sm" id="dos-back">&larr; back</button> <code>' +
                esc(selected) + '</code> <span class="nd-text-muted">' + data.length.toLocaleString() + ' bytes</span></p>' +
                '<pre style="user-select:text;background:var(--bg-sunken);border:1px solid var(--border);border-radius:4px;' +
                'padding:0.6rem;font-size:0.78rem;max-height:55vh;overflow:auto">' +
                esc(act === 'hex' ? bytesToHex(data, 65536) : bytesToText(data)) + '</pre>';
              document.getElementById('dos-back').addEventListener('click', render);
            }
          });
        });
      }
      render();
    }).catch(function(err) {
      document.getElementById('dosbody').innerHTML = '<p class="nd-text-muted">Could not read this disk: ' + esc(String(err)) + '</p>';
    });
  };

  // A hex dump of the raw image, so any floppy can be looked at byte by byte -
  // including the volumes of a backup set, which carry no file names. Rendered
  // one 32 KB window at a time: a whole 1.2 MB image at 16 bytes per row is
  // 76 800 rows, which no browser lays out smoothly.
  // hexNav is the list the viewer can walk: whatever the catalog is showing.
  var hexNav = { ids: [], index: -1 };
  window.setHexNavList = function(ids) { hexNav.ids = ids || []; };

  window.openHexViewer = function(entryId, label) {
    var WINDOW_BYTES = 32768, ROW = 16;
    var entry = catalogMap[entryId] || {};
    hexNav.index = hexNav.ids.indexOf(entryId);
    var place = hexNav.index >= 0 ? ' <span class="nd-text-muted" style="font-weight:normal">(' +
      (hexNav.index + 1) + ' of ' + hexNav.ids.length + ')</span>' : '';
    ndModal.open('<div class="nd-modal-header"><h3>Hex view - <code>' + esc(label || entry.volumeName || entryId) +
      '</code>' + place + '</h3><button class="nd-modal-close" onclick="ndModal.close()">&times;</button></div>' +
      '<div class="nd-modal-body" id="hexbody">Reading image...</div>', { wide: true });
    loadImageBytes(entryId).then(function(bytes) {
      var box = document.getElementById('hexbody');
      var start = 0, strip = true;
      function render() {
        if (start < 0) start = 0;
        if (start >= bytes.length) start = Math.max(0, bytes.length - WINDOW_BYTES);
        var end = Math.min(bytes.length, start + WINDOW_BYTES);
        var lines = [];
        for (var off = start; off < end; off += ROW) {
          var hex = '', txt = '';
          for (var i = 0; i < ROW; i++) {
            if (off + i < end) {
              var b = bytes[off + i];
              hex += (b < 16 ? '0' : '') + b.toString(16) + ' ';
              var c = strip ? (b & 0x7f) : b;
              txt += (c >= 0x20 && c <= 0x7e) ? String.fromCharCode(c) : '.';
            } else { hex += '   '; }
            if (i === 7) hex += ' ';
          }
          lines.push(('0000000' + off.toString(16)).slice(-8) + '  ' + hex + ' |' + txt + '|');
        }
        var h = '<div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;margin-bottom:0.5rem">' +
          (hexNav.index >= 0
            ? '<button class="nd-btn nd-btn-sm nd-btn-primary" id="hex-img-prev"' + (hexNav.index <= 0 ? ' disabled' : '') +
              '>&larr; Previous image</button>' +
              '<button class="nd-btn nd-btn-sm nd-btn-primary" id="hex-img-next"' +
              (hexNav.index >= hexNav.ids.length - 1 ? ' disabled' : '') + '>Next image &rarr;</button>'
            : '') +
          '<span class="nd-text-muted">' + bytes.length.toLocaleString() + ' bytes &middot; showing 0x' +
          start.toString(16) + ' - 0x' + (end - 1).toString(16) + '</span>' +
          '<button class="nd-btn nd-btn-sm" id="hex-prev"' + (start <= 0 ? ' disabled' : '') + '>Previous 32K</button>' +
          '<button class="nd-btn nd-btn-sm" id="hex-next"' + (end >= bytes.length ? ' disabled' : '') + '>Next 32K</button>' +
          '<label style="font-size:0.85rem">go to <input class="nd-input" id="hex-goto" style="width:9rem;font-size:0.8rem" placeholder="0x2000 or 8192"></label>' +
          '<label style="font-size:0.85rem;cursor:pointer" title="ND text is written with the parity bit set"><input type="checkbox" id="hex-strip"' +
          (strip ? ' checked' : '') + '> strip parity</label></div>';
        h += '<pre class="ndfs-hex-view" style="max-height:60vh;overflow:auto">' + esc(lines.join('\\n')) + '</pre>';
        box.innerHTML = h;
        var prev = document.getElementById('hex-prev'), next = document.getElementById('hex-next');
        prev.addEventListener('click', function() { start -= WINDOW_BYTES; render(); });
        next.addEventListener('click', function() { start += WINDOW_BYTES; render(); });
        var ip = document.getElementById('hex-img-prev'), inx = document.getElementById('hex-img-next');
        if (ip) ip.addEventListener('click', function() { openHexViewer(hexNav.ids[hexNav.index - 1]); });
        if (inx) inx.addEventListener('click', function() { openHexViewer(hexNav.ids[hexNav.index + 1]); });
        document.getElementById('hex-strip').addEventListener('change', function() { strip = this.checked; render(); });
        document.getElementById('hex-goto').addEventListener('change', function() {
          var v = this.value.trim();
          var n = /^0x/i.test(v) ? parseInt(v.slice(2), 16) : parseInt(v, 10);
          if (!isNaN(n)) { start = Math.floor(n / ROW) * ROW; render(); }
        });
      }
      render();
    }).catch(function(err) {
      document.getElementById('hexbody').innerHTML = '<p class="nd-text-muted">Could not read this image: ' + esc(String(err)) + '</p>';
    });
  };

  // Every volume of a WINCH-TO-FLOPP backup set, with the status of each image
  // and of the set as a whole. Grouped from the catalog that is already in the
  // page, so nothing extra is downloaded; each volume can still be opened or
  // dumped as hex on its own.
  window.renderBackupSetPanel = function(entryId, box) {
    if (!box || typeof groupBackupSets === 'undefined') return;
    var entry = catalogMap[entryId];
    var key = entry ? setKeyOf(entry) : null;
    if (!key) { box.innerHTML = ''; return; }
    var set = groupBackupSets(CATALOG).get(key);
    if (!set) { box.innerHTML = ''; return; }
    var chained = set.ordering === 'chained';
    var pct = set.pagesExpected ? Math.round(set.pagesHeld * 100 / set.pagesExpected) : 0;
    var h = '<div style="border:1px solid var(--border);border-radius:6px;margin:0.75rem 0;padding:0.75rem 1rem">';
    h += '<h4 style="margin:0 0 0.25rem">' + (chained ? 'Backup run' : 'Backup set') + ' <code>' + esc(set.name) + '</code>' +
      (set.label ? ' <span class="nd-text-muted" style="font-weight:normal">' + esc(set.label) + '</span>' : '') +
      (chained && set.runDate ? ' <span class="nd-text-muted" style="font-weight:normal">&middot; ' + esc(set.runDate) +
        (set.system ? ' &middot; ' + esc(set.system) : '') + '</span>' : '') + '</h4>';
    h += '<p style="margin:0 0 0.5rem"><span class="nd-badge ' + (set.complete ? 'nd-badge-ok' : 'nd-badge-warn') + '">' +
      esc(describeSet(set)) + '</span> <span class="nd-text-muted">' + set.imageCount + ' image(s)' +
      (chained ? ' &middot; ' + (set.fileCount || 0) + ' file(s) named across the run'
               : ' &middot; ' + set.pagesHeld.toLocaleString() + ' of ' + set.pagesExpected.toLocaleString() +
                 ' pages of the volumes held (' + pct + '%)') + '</span></p>';
    h += '<p class="nd-text-muted" style="margin:0 0 0.6rem;font-size:0.85rem">' + esc(setVerdict(set)) + '</p>';
    h += chained
      ? '<div style="overflow-x:auto"><table class="nd-table nd-table-compact"><thead><tr><th>Volume</th><th>Image</th>' +
        '<th style="text-align:right">Files</th><th>First file</th><th>Ends</th><th></th></tr></thead><tbody>'
      : '<div style="overflow-x:auto"><table class="nd-table nd-table-compact"><thead><tr><th>Volume</th><th>Image</th>' +
        '<th>Status</th><th style="text-align:right">Pages</th><th>Original pages</th><th></th></tr></thead><tbody>';
    set.slots.forEach(function(sl) {
      if (!sl.present) {
        h += '<tr><td><strong>' + sl.volumeNumber + '</strong></td><td colspan="4" class="nd-text-muted">not in the archive</td>' +
          '<td><span class="nd-badge nd-badge-warn">missing</span></td></tr>';
        return;
      }
      sl.reads.forEach(function(rd, i) {
        var isCurrent = rd.id === entryId;
        h += '<tr>';
        h += '<td>' + (i === 0 ? '<strong>' + sl.volumeNumber + '</strong>' : '') + '</td>';
        h += '<td><a href="#/disks/' + encodeURIComponent(rd.id) + '"><code>' + esc(rd.name) + '</code></a>' +
          (i === 0 ? '' : ' <span class="nd-text-muted" style="font-size:0.75rem">alternate read</span>') +
          (isCurrent ? ' <span class="nd-badge nd-badge-info" style="font-size:0.65rem">open</span>' : '') + '</td>';
        if (chained) {
          h += '<td style="text-align:right">' + (rd.fileCount || 0) +
            (rd.staleCount ? ' <span class="nd-text-muted" style="font-size:0.75rem">+' + rd.staleCount + ' stale</span>' : '') + '</td>';
          h += '<td><code style="font-size:0.8rem">' + esc(rd.firstFile || '-') + '</code></td>';
          h += '<td>' + (!rd.endsMidFile
            ? '<span class="nd-badge nd-badge-ok">ends clean</span>'
            : !rd.best
              ? '<span class="nd-badge">ends mid-file</span> <code style="font-size:0.75rem">' + esc(rd.lastFile || '') + '</code>'
              : rd.continuesTo
                ? '<span class="nd-badge nd-badge-info">continues</span> <code style="font-size:0.75rem">' + esc(rd.lastFile || '') + '</code>'
                : '<span class="nd-badge nd-badge-warn">cut off</span> <code style="font-size:0.75rem">' + esc(rd.brokenAt || rd.lastFile || '') +
                  '</code> <span class="nd-text-muted" style="font-size:0.75rem">no floppy here continues it</span>') + '</td>';
        } else {
        var badge = rd.status === 'complete' ? '<span class="nd-badge nd-badge-ok">complete</span>'
          : rd.status === 'partial'
            ? '<span class="nd-badge nd-badge-warn">' + (rd.sideOne ? 'side 0 only' : 'incomplete read') + '</span>'
            : '<span class="nd-badge">unknown</span>';
        h += '<td>' + badge + (rd.coverage !== null ? ' <span class="nd-text-muted" style="font-size:0.75rem">' +
          Math.round(rd.coverage * 100) + '%</span>' : '') + '</td>';
        h += '<td style="text-align:right">' + rd.pageCount.toLocaleString() +
          (rd.listedPages ? '<span class="nd-text-muted"> / ' + rd.listedPages.toLocaleString() + '</span>' : '') + '</td>';
        h += '<td class="nd-text-muted">' + (rd.pageFirst === null ? '-' : rd.pageFirst + '-' + rd.pageLast) + '</td>';
        }
        h += '<td style="white-space:nowrap"><button class="nd-btn nd-btn-sm" data-bk-open="' + esc(rd.id) + '"' +
          (isCurrent ? ' disabled' : '') + '>Open</button> <button class="nd-btn nd-btn-sm nd-badge-info" data-bk-hex="' +
          esc(rd.id) + '" data-bk-name="' + esc(rd.name) + '">Hex</button></td>';
        h += '</tr>';
      });
    });
    h += '</tbody></table></div></div>';
    box.innerHTML = h;
    box.querySelectorAll('[data-bk-open]').forEach(function(b) {
      b.addEventListener('click', function() { openBackupViewer(this.getAttribute('data-bk-open')); });
    });
    box.querySelectorAll('[data-bk-hex]').forEach(function(b) {
      b.addEventListener('click', function() { openHexViewer(this.getAttribute('data-bk-hex'), this.getAttribute('data-bk-name')); });
    });
  };

  window.openBackupViewer = function(entryId) {
    if (typeof isBackupVolume === 'undefined') { alert('Backup reader not available in this build'); return; }
    var entry = catalogMap[entryId] || {};
    ndModal.open('<div class="nd-modal-header"><h3>Backup volume - <code>' +
      esc(entry.volumeName || entryId) + '</code></h3>' +
      '<button class="nd-modal-close" onclick="ndModal.close()">&times;</button></div>' +
      '<div class="nd-modal-body" id="bkbody">Reading image...</div>', { wide: true });
    loadImageBytes(entryId).then(function(bytes) {
      var box = document.getElementById('bkbody');
      if (isWinchVolume(bytes)) {
        var w = readWinchVolume(bytes);
        var h = '<p class="nd-text-muted"><strong>WINCH-TO-FLOPP</strong> &middot; directory <code>' + esc(w.directoryName) +
          '</code> &middot; volume ' + w.volumeNumber + ' of ' + w.totalVolumes + ' &middot; ' + w.pages.length +
          ' page(s)' + (w.label ? ' &middot; "' + esc(w.label) + '"' : '') + '</p>';
        h += '<p class="nd-text-muted">This format stores no file names - it is a page-level dump of directory <code>' +
          esc(w.directoryName) + '</code>. File names appear only when all ' + w.totalVolumes +
          ' volumes of the set are reassembled into a directory image and read as NDFS.</p>';
        h += '<div id="bk-set"></div>';
        h += '<h4 style="margin:1rem 0 0.35rem">Pages on this volume</h4>';
        h += '<div style="max-height:40vh;overflow:auto"><table class="nd-table nd-table-compact"><thead><tr>' +
          '<th>Original page</th><th>Offset in image</th></tr></thead><tbody>';
        w.pages.slice(0, 400).forEach(function(p) {
          h += '<tr><td><code>' + p.pageNumber + '</code></td><td class="nd-text-muted">' + p.offset.toLocaleString() + '</td></tr>';
        });
        h += '</tbody></table></div>';
        box.innerHTML = h;
        renderBackupSetPanel(entryId, document.getElementById('bk-set'));
        return;
      }
      var v = readBackupVolume(bytes);
      var selected = -1;
      function render() {
        var live = v.files.filter(function(f) { return !f.stale; }).length;
        var h = '<p class="nd-text-muted"><strong>SINTRAN BACKUP-SYSTEM</strong> &middot; volume <code>' + esc(v.volumeId) +
          '</code> &middot; owner <code>' + esc(v.owner) + '</code> &middot; ' + live + ' file(s)' +
          (v.files.length - live ? ', ' + (v.files.length - live) + ' stale label(s)' : '') + '</p>';
        h += '<div id="bk-set"></div>';
        h += '<div style="max-height:50vh;overflow:auto"><table class="nd-table nd-table-compact"><thead><tr>' +
          '<th>File</th><th style="text-align:right">Bytes</th><th>Created</th><th>System</th></tr></thead><tbody>';
        v.files.forEach(function(f, i) {
          h += '<tr data-idx="' + i + '" style="cursor:pointer"' + (selected === i ? ' class="ndfs-file-selected"' : '') + '>' +
            '<td><code>' + esc(f.fullName) + '</code>' +
            (f.continued ? ' <span class="nd-badge nd-badge-warn" style="font-size:0.65rem">continues</span>' : '') +
            (f.stale ? ' <span class="nd-text-muted" style="font-size:0.7rem">stale</span>' : '') + '</td>' +
            '<td style="text-align:right">' + f.dataLength.toLocaleString() + '</td>' +
            '<td class="nd-text-muted">' + esc(f.created || '') + '</td>' +
            '<td class="nd-text-muted">' + esc(f.system || '') + '</td></tr>';
        });
        h += '</tbody></table></div>';
        var f = v.files[selected];
        h += '<div class="ndfs-file-actions" style="margin-top:0.5rem">' +
          '<span class="ndfs-selected-label">' + (f ? esc(f.fullName) : 'Select a file') + '</span>' +
          '<button class="nd-btn nd-btn-sm nd-badge-ok" data-act="extract"' + (f ? '' : ' disabled') + '>Extract</button>' +
          '<button class="nd-btn nd-btn-sm nd-badge-os" data-act="extract-strip"' + (f ? '' : ' disabled') + '>Extract (strip parity)</button>' +
          '<button class="nd-btn nd-btn-sm nd-badge-info" data-act="hex"' + (f ? '' : ' disabled') + '>View as hex</button>' +
          '<button class="nd-btn nd-btn-sm nd-badge-patch" data-act="text"' + (f ? '' : ' disabled') + '>View as text</button>' +
          '</div>';
        box.innerHTML = h;
        renderBackupSetPanel(entryId, document.getElementById('bk-set'));
        box.querySelectorAll('[data-idx]').forEach(function(tr) {
          tr.addEventListener('click', function() { selected = parseInt(this.getAttribute('data-idx'), 10); render(); });
        });
        box.querySelectorAll('[data-act]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var file = v.files[selected];
            if (!file) return;
            var data = readBackupFile(bytes, file);
            var act = this.getAttribute('data-act');
            if (act === 'extract') downloadBytes(data, file.fullName);
            else if (act === 'extract-strip') {
              var st = new Uint8Array(data.length);
              for (var i = 0; i < data.length; i++) st[i] = data[i] & 0x7f;
              downloadBytes(st, file.fullName);
            } else {
              box.innerHTML = '<p><button class="nd-btn nd-btn-ghost nd-btn-sm" id="bk-back">&larr; back</button> <code>' +
                esc(file.fullName) + '</code> <span class="nd-text-muted">' + data.length.toLocaleString() + ' bytes</span></p>' +
                '<pre style="user-select:text;background:var(--bg-sunken);border:1px solid var(--border);border-radius:4px;' +
                'padding:0.6rem;font-size:0.78rem;max-height:55vh;overflow:auto">' +
                esc(act === 'hex' ? bytesToHex(data, 65536) : bytesToText(data)) + '</pre>';
              document.getElementById('bk-back').addEventListener('click', render);
            }
          });
        });
      }
      render();
    }).catch(function(err) {
      document.getElementById('bkbody').innerHTML = '<p class="nd-text-muted">Could not read this volume: ' + esc(String(err)) + '</p>';
    });
  };

  // ── NDFS Viewer ─────────────────────────────────────────────
  var ndfsViewerState = {
    entryId: null,
    fs: null,
    files: null,
    users: null,
    selectedUser: null,
    selectedFileIdx: null,
    volumeName: null
  };

  window.openNdfsViewer = function(entryId) {
    if (typeof NdfsLib === 'undefined') {
      alert('NDFS library not available');
      return;
    }

    var entry = catalogMap[entryId];
    if (!entry || !entry.storage || !entry.storage.git || !entry.storage.git.imagePath) {
      alert('No image file available for this entry');
      return;
    }

    ndfsViewerState.entryId = entryId;
    ndfsViewerState.fs = null;
    ndfsViewerState.files = null;
    ndfsViewerState.users = null;
    ndfsViewerState.selectedUser = null;
    ndfsViewerState.selectedFileIdx = null;
    ndfsViewerState.volumeName = entry.volumeName || entry.id;

    ndModal.open(
      '<div class="nd-modal-header">' +
        '<h3>NDFS Viewer</h3>' +
        '<button class="nd-modal-close" onclick="ndModal.close()">&times;</button>' +
      '</div>' +
      '<div class="ndfs-loading"><div class="ndfs-spinner"></div><div>Fetching image...</div></div>',
      { wide: true }
    );

    var imgUrl = rawUrl(entry.storage.git.imagePath);

    fetch(imgUrl)
      .then(function(r) {
        if (!r.ok) throw new Error('Failed to fetch: ' + r.status);
        document.querySelector('#nd-modal-content .ndfs-loading div:last-child').textContent = 'Decompressing...';
        return r.arrayBuffer();
      })
      .then(function(buf) {
        return decompressGzip(new Uint8Array(buf));
      })
      .then(function(rawData) {
        document.querySelector('#nd-modal-content .ndfs-loading div:last-child').textContent = 'Parsing NDFS...';
        // A read that stops a fraction of a page short is still a readable ND
        // floppy; the parser refuses anything not a whole number of pages.
        var aligned = rawData.length % 2048 === 0 ? rawData
          : (function() { var b = new Uint8Array(Math.ceil(rawData.length / 2048) * 2048); b.set(rawData); return b; })();
        var fs = new NdfsLib.NdfsFileSystem(aligned, true);
        ndfsViewerState.fs = fs;

        // Extract file list using getObjectEntries (same API as server)
        var users = fs.getUsers();
        ndfsViewerState.users = users.map(function(u) { return { index: u.userIndex, name: u.userName, pagesUsed: u.pagesUsed, pagesReserved: u.pagesReserved }; });
        var objects = fs.getObjectEntries();
        var allFiles = [];
        objects.forEach(function(oe) {
          if (!oe || !oe.objectName) return;
          var dateCreated = oe.dateCreated ? NdfsLib.ndTimeToDate(oe.dateCreated) : null;
          var lastDateWritten = oe.lastDateWritten ? NdfsLib.ndTimeToDate(oe.lastDateWritten) : null;

          // BPUN checksum validation
          var bpunValid = null;
          if (oe.type === 'BPUN') {
            try {
              var fileData = fs.readFile(oe.userName + '/' + oe.objectName + ':' + oe.type);
              if (fileData && fileData.length >= 10) {
                var bangOff = -1;
                for (var bi = 0; bi < fileData.length; bi++) {
                  if (fileData[bi] === 0x21 || (fileData[bi] & 0x7F) === 0x21) { bangOff = bi; break; }
                }
                var dataOff = bangOff >= 0 ? bangOff + 1 : 0;
                if (dataOff + 4 <= fileData.length) {
                  var count = (fileData[dataOff + 2] << 8) | fileData[dataOff + 3];
                  if (count > 0) {
                    var wordsStart = dataOff + 4;
                    var wordsEnd = wordsStart + count * 2;
                    if (wordsEnd + 2 <= fileData.length) {
                      var calcSum = 0;
                      for (var ci = wordsStart; ci < wordsEnd; ci += 2) {
                        calcSum = (calcSum + ((fileData[ci] << 8) | fileData[ci + 1])) & 0xFFFF;
                      }
                      var stored = (fileData[wordsEnd] << 8) | fileData[wordsEnd + 1];
                      bpunValid = (calcSum === stored);
                    }
                  }
                }
              }
            } catch(e) { /* ignore */ }
          }

          allFiles.push({
            userName: oe.userName,
            fullName: oe.objectName + ':' + (oe.type || ''),
            name: oe.objectName,
            type: oe.type || '',
            pages: oe.pagesInFile,
            bytes: oe.bytesInFile,
            dateCreated: dateCreated ? dateCreated.toISOString() : null,
            lastDateWritten: lastDateWritten ? lastDateWritten.toISOString() : null,
            bpunValid: bpunValid,
            path: oe.userName + '/' + oe.objectName + ':' + (oe.type || '')
          });
        });
        allFiles.sort(function(a, b) { return a.fullName.localeCompare(b.fullName); });
        ndfsViewerState.files = allFiles;

        ndfsRenderViewer();
      })
      .catch(function(err) {
        var loading = document.querySelector('#nd-modal-content .ndfs-loading');
        if (loading) {
          loading.innerHTML = '<div style="color:var(--warn)">Error: ' + esc(String(err.message || err)) + '</div>';
        }
      });
  };

  function ndfsRenderViewer() {
    var files = ndfsViewerState.files;
    var users = ndfsViewerState.users;
    if (!files || !users) return;

    var headerHtml =
      '<div class="nd-modal-header">' +
        '<h3>NDFS Viewer: ' + esc(ndfsViewerState.volumeName) + '</h3>' +
        '<button class="nd-modal-close" onclick="ndModal.close()">&times;</button>' +
      '</div>' +
      '<div class="ndfs-viewer-header">' +
        '<span>Volume: <strong>' + esc(ndfsViewerState.volumeName) + '</strong></span>' +
        '<span>' + files.length + ' files</span>' +
        '<span>' + users.length + ' user' + (users.length !== 1 ? 's' : '') + '</span>' +
      '</div>';

    // User panel
    var userHtml = '<div class="ndfs-user-panel"><h4>Users</h4>';
    userHtml += '<div class="ndfs-user-item' + (ndfsViewerState.selectedUser === null ? ' ndfs-user-active' : '') + '" onclick="ndfsSelectUser(null)">';
    userHtml += 'All <span class="ndfs-user-count">(' + files.length + ')</span></div>';
    users.forEach(function(u) {
      var count = 0;
      files.forEach(function(f) { if (f.userName === u.name) count++; });
      var active = ndfsViewerState.selectedUser === u.name ? ' ndfs-user-active' : '';
      userHtml += '<div class="ndfs-user-item' + active + '" onclick="ndfsSelectUser(\\'' + esc(u.name).replace(/'/g, "\\\\'") + '\\')">';
      userHtml += esc(u.name) + ' <span class="ndfs-user-count">(' + count + ')</span>';
      userHtml += '<div style="font-size:0.68rem;color:var(--text-muted)">' + u.pagesUsed + '/' + u.pagesReserved + ' pg</div>';
      userHtml += '</div>';
    });
    userHtml += '</div>';

    // File table
    var fileHtml = '<div class="ndfs-file-panel">' + ndfsRenderFileTable() + '</div>';

    // Actions
    var actionsHtml = '<div class="ndfs-file-actions">' +
      '<span class="ndfs-selected-label" id="ndfs-sel-label">Select a file</span>' +
      '<button class="nd-btn nd-btn-sm nd-badge-ok" id="ndfs-btn-extract" disabled onclick="ndfsExtractFile(false)">Extract</button>' +
      '<button class="nd-btn nd-btn-sm nd-badge-os" id="ndfs-btn-extract-strip" disabled onclick="ndfsExtractFile(true)">Extract (strip parity)</button>' +
      '<button class="nd-btn nd-btn-sm nd-badge-info" id="ndfs-btn-hex" disabled onclick="ndfsShowHex()">View as hex</button>' +
      '<button class="nd-btn nd-btn-sm nd-badge-patch" id="ndfs-btn-text" disabled onclick="ndfsShowText()">View as text</button>' +
      '</div>';

    // File content area
    var contentArea = '<div id="ndfs-file-content" style="padding:0 0.75rem 0.75rem"></div>';

    var content = headerHtml +
      '<div class="ndfs-viewer-layout">' + userHtml + fileHtml + '</div>' +
      actionsHtml + contentArea;

    document.getElementById('nd-modal-content').innerHTML = content;
  }

  function ndfsGetFilteredFiles() {
    var files = ndfsViewerState.files || [];
    if (ndfsViewerState.selectedUser) {
      return files.filter(function(f) { return f.userName === ndfsViewerState.selectedUser; });
    }
    return files;
  }

  function ndfsRenderFileTable() {
    var filtered = ndfsGetFilteredFiles();

    if (filtered.length === 0) {
      return '<div class="ndfs-loading" style="padding:2rem"><div>No files found</div></div>';
    }

    var html = '<table class="ndfs-file-table"><thead><tr>' +
      '<th>Name</th><th style="text-align:right">Pages</th>' +
      '<th style="text-align:right">Size</th><th>Created</th>' +
      '</tr></thead><tbody>';

    filtered.forEach(function(f, i) {
      var selected = ndfsViewerState.selectedFileIdx === i ? ' ndfs-file-selected' : '';
      var sizeStr = f.bytes != null ? formatBytes(f.bytes) : '-';
      var created = f.dateCreated ? String(f.dateCreated).substring(0, 10) : '-';

      var crcIcon = '';
      if (f.bpunValid === true) {
        crcIcon = ' <span title="BPUN checksum valid" style="color:var(--ok);cursor:help;padding:0 0.2rem">\\u2713</span>';
      } else if (f.bpunValid === false) {
        crcIcon = ' <span title="BPUN checksum INVALID" style="color:var(--danger);cursor:help;padding:0 0.2rem;font-weight:bold">\\u2717</span>';
      }

      var displayName = '<span style="color:var(--accent);font-weight:700">(' + esc(f.userName) + ')</span>' + esc(f.fullName);

      html += '<tr class="' + selected + '" onclick="ndfsSelectFile(' + i + ')">' +
        '<td><code style="font-size:0.78rem">' + displayName + '</code>' + crcIcon + '</td>' +
        '<td style="text-align:right">' + (f.pages || '-') + '</td>' +
        '<td style="text-align:right">' + sizeStr + '</td>' +
        '<td style="color:var(--text-muted)">' + created + '</td>' +
        '</tr>';
    });

    html += '</tbody></table>';
    return html;
  }

  window.ndfsSelectUser = function(userName) {
    ndfsViewerState.selectedUser = userName;
    ndfsViewerState.selectedFileIdx = null;
    ndfsRenderViewer();
  };

  window.ndfsSelectFile = function(index) {
    ndfsViewerState.selectedFileIdx = index;
    var filtered = ndfsGetFilteredFiles();
    var file = filtered[index];
    if (!file) return;

    // Update selection highlighting
    var rows = document.querySelectorAll('.ndfs-file-table tr');
    for (var ri = 0; ri < rows.length; ri++) {
      if (ri === 0) continue;
      rows[ri].className = ri === index + 1 ? 'ndfs-file-selected' : '';
    }

    // Update label
    var label = document.getElementById('ndfs-sel-label');
    if (label) label.textContent = file.fullName + ' (' + formatBytes(file.bytes) + ')';

    // Enable buttons
    ['ndfs-btn-extract', 'ndfs-btn-extract-strip', 'ndfs-btn-hex', 'ndfs-btn-text'].forEach(function(id) {
      var btn = document.getElementById(id);
      if (btn) btn.disabled = false;
    });

    // Clear content area
    var contentEl = document.getElementById('ndfs-file-content');
    if (contentEl) contentEl.innerHTML = '';
  };

  function ndfsGetSelectedFile() {
    var filtered = ndfsGetFilteredFiles();
    if (ndfsViewerState.selectedFileIdx == null) return null;
    return filtered[ndfsViewerState.selectedFileIdx] || null;
  }

  window.ndfsExtractFile = function(stripParity) {
    var file = ndfsGetSelectedFile();
    if (!file || !ndfsViewerState.fs) return;

    try {
      var data = ndfsViewerState.fs.readFile(file.path);
      if (!data) {
        alert('Could not read file from NDFS image');
        return;
      }

      var bytes = new Uint8Array(data);
      if (stripParity) {
        var stripped = new Uint8Array(bytes.length);
        for (var i = 0; i < bytes.length; i++) {
          stripped[i] = bytes[i] & 0x7F;
        }
        bytes = stripped;
      }

      var blob = new Blob([bytes], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = file.fullName.replace(/:/g, '.');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Extract error: ' + (err.message || err));
    }
  };

  window.ndfsShowHex = function() {
    var file = ndfsGetSelectedFile();
    if (!file || !ndfsViewerState.fs) return;

    var contentEl = document.getElementById('ndfs-file-content');
    if (!contentEl) return;

    try {
      var data = ndfsViewerState.fs.readFile(file.path);
      if (!data) {
        contentEl.innerHTML = '<div style="color:var(--warn)">Could not read file</div>';
        return;
      }

      var bytes = new Uint8Array(data);
      var maxBytes = Math.min(bytes.length, 4096);
      var lines = [];
      for (var off = 0; off < maxBytes; off += 16) {
        var hex = '';
        var ascii = '';
        for (var j = 0; j < 16; j++) {
          if (off + j < maxBytes) {
            var b = bytes[off + j];
            hex += (b < 16 ? '0' : '') + b.toString(16).toUpperCase() + ' ';
            ascii += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
          } else {
            hex += '   ';
            ascii += ' ';
          }
        }
        var addr = off.toString(16).toUpperCase();
        while (addr.length < 6) addr = '0' + addr;
        lines.push(addr + '  ' + hex + ' ' + ascii);
      }

      var truncNote = maxBytes < bytes.length ? '<div style="color:var(--text-muted);font-size:0.78rem;margin-top:0.5rem">Showing first ' + maxBytes + ' of ' + bytes.length + ' bytes</div>' : '';

      contentEl.innerHTML =
        '<div style="margin-top:0.5rem">' +
          '<strong style="font-size:0.82rem">Hex: ' + esc(file.fullName) + ' (' + formatBytes(bytes.length) + ')</strong>' +
          '<div class="ndfs-hex-view">' + esc(lines.join('\\n')) + '</div>' +
          truncNote +
        '</div>';
    } catch (err) {
      contentEl.innerHTML = '<div style="color:var(--warn)">Hex view error: ' + esc(String(err.message || err)) + '</div>';
    }
  };

  window.ndfsShowText = function() {
    var file = ndfsGetSelectedFile();
    if (!file || !ndfsViewerState.fs) return;

    var contentEl = document.getElementById('ndfs-file-content');
    if (!contentEl) return;

    try {
      var data = ndfsViewerState.fs.readFile(file.path);
      if (!data) {
        contentEl.innerHTML = '<div style="color:var(--warn)">Could not read file</div>';
        return;
      }

      var bytes = new Uint8Array(data);
      // Strip parity for text display
      var stripped = new Uint8Array(bytes.length);
      for (var i = 0; i < bytes.length; i++) {
        stripped[i] = bytes[i] & 0x7F;
      }
      var text = new TextDecoder('ascii').decode(stripped);

      // Limit display
      var maxLen = 32768;
      var truncNote = '';
      if (text.length > maxLen) {
        text = text.substring(0, maxLen);
        truncNote = '<div style="color:var(--text-muted);font-size:0.78rem;margin-top:0.5rem">Showing first ' + maxLen + ' characters of ' + bytes.length + ' bytes</div>';
      }

      contentEl.innerHTML =
        '<div style="margin-top:0.5rem">' +
          '<strong style="font-size:0.82rem">Text: ' + esc(file.fullName) + ' (' + formatBytes(bytes.length) + ')</strong>' +
          '<div class="ndfs-text-view">' + esc(text) + '</div>' +
          truncNote +
        '</div>';
    } catch (err) {
      contentEl.innerHTML = '<div style="color:var(--warn)">Text view error: ' + esc(String(err.message || err)) + '</div>';
    }
  };

  // ── Boot ─────────────────────────────────────────────────────
  navigate();
})();`;
}

// Allow running directly: npx tsx tools/src/api/static-site-builder.ts
const isMain = process.argv[1]?.endsWith('static-site-builder.ts') || process.argv[1]?.endsWith('static-site-builder.js');
if (isMain) {
  const rootDir = process.env.ND_ROOT || join(import.meta.dirname || '.', '..', '..', '..');
  buildStaticSite(rootDir).then(() => {
    console.log('Static site generated.');
  }).catch(err => {
    console.error('Failed:', err);
    process.exit(1);
  });
}
