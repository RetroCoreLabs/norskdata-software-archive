#!/usr/bin/env node

/**
 * CLI for the Norsk Data Software Archive.
 * Provides migration, import, search, validation, and IA sync commands.
 */

import { Command } from 'commander';
import { basename } from 'path';
import { resolve } from 'path';
import { printDepCheck } from './api/check-deps.js';
import { loadCatalog, findByMd5, findByVolumeName, generateCatalogJson, loadProducts, saveProductYaml, saveFloppyYaml, consolidateGroupPhotos } from './api/catalog.js';
import { getUnsyncedEntries, getSyncStatusSummary, syncToIa, detectChanges } from './api/ia-sync.js';
import { runImportFile, runImportFolder } from './api/import-runner.js';
import { writeIndex } from './api/index-builder.js';
import { buildStaticSite } from './api/static-site-builder.js';

const program = new Command();

/**
 * Resolve the repository root directory.
 * cli.ts is at tools/src/cli.ts, compiled to tools/dist/cli.js.
 * The repo root is two levels up from dist/.
 */
function getRepoRoot(): string {
  return resolve(import.meta.dirname ?? '.', '..', '..');
}

program
  .name('ndfloppy-cli')
  .description('Import, catalog, and sync tools for the Norsk Data Software Archive')
  .version('0.2.0');

// --- import ---
program
  .command('import')
  .description('Import a floppy image file into the catalog')
  .argument('<source>', 'Path to image file')
  .option('--contributor <name>', 'Contributor name', 'unknown')
  .option('--source <desc>', 'Source description')
  .action(async (source: string, options: { contributor: string; source?: string }) => {
    const rootDir = getRepoRoot();
    const filePath = resolve(source);

    try {
      const result = await runImportFile(rootDir, filePath, {
        contributor: options.contributor,
        source: options.source,
      });

      if (result.errors) process.exit(1);
      if (result.duplicates) {
        console.log(`Duplicate: ${filePath} already in catalog`);
        return;
      }
      if (result.variants) {
        console.log('Variant detected: same volume name as an existing entry');
      }

      const entry = result.imported[0];
      console.log(`Imported: ${entry.id} (${entry.volumeName ?? 'no volume name'}) [${entry.storageClass}]`);
    } catch (err) {
      console.error('Import failed:', err);
      process.exit(1);
    }
  });

// --- import-folder ---
program
  .command('import-folder')
  .description('Batch import all .img files from a folder')
  .argument('<folder>', 'Path to folder containing .img files')
  .option('--contributor <name>', 'Contributor name', 'unknown')
  .option('--source <desc>', 'Source description', 'unknown')
  .option('--recursive', 'Scan subfolders recursively')
  .action(async (folder: string, options: { contributor: string; source: string; recursive?: boolean }) => {
    const rootDir = getRepoRoot();
    const folderPath = resolve(folder);

    try {
      const result = await runImportFolder(rootDir, folderPath, {
        contributor: options.contributor,
        source: options.source,
        recursive: options.recursive,
      });

      console.log(`\nImport complete:`);
      console.log(`  Imported:   ${result.imported.length}`);
      console.log(`  Duplicates: ${result.duplicates}`);
      console.log(`  Variants:   ${result.variants}`);
      console.log(`  Errors:     ${result.errors}`);
    } catch (err) {
      console.error('Import failed:', err);
      process.exit(1);
    }
  });

// --- search ---
program
  .command('search')
  .description('Search the catalog by volume name, product ID, tags, or directory content')
  .argument('<query>', 'Search query (substring match)')
  .option('--limit <n>', 'Maximum results to show', '20')
  .action(async (query: string, options: { limit: string }) => {
    const rootDir = getRepoRoot();
    const limit = parseInt(options.limit, 10);

    try {
      const catalog = await loadCatalog(rootDir);
      const lowerQuery = query.toLowerCase();

      const results = catalog.entries.filter(entry => {
        if (entry.volumeName?.toLowerCase().includes(lowerQuery)) return true;
        if (entry.productId?.toLowerCase().includes(lowerQuery)) return true;
        if (entry.id.toLowerCase().includes(lowerQuery)) return true;
        if (entry.tags?.some(t => t.toLowerCase().includes(lowerQuery))) return true;
        if (entry.directoryContentRaw?.toLowerCase().includes(lowerQuery)) return true;
        return false;
      });

      console.log(`Found ${results.length} result(s) for "${query}":\n`);

      const shown = results.slice(0, limit);
      for (const entry of shown) {
        console.log(`  ${entry.id}`);
        console.log(`    Volume:  ${entry.volumeName ?? '(none)'}`);
        console.log(`    Product: ${entry.productId ?? '(unmatched)'}`);
        console.log(`    MD5:     ${entry.md5}`);
        if (entry.tags?.length) {
          console.log(`    Tags:    ${entry.tags.join(', ')}`);
        }
        console.log('');
      }

      if (results.length > limit) {
        console.log(`  ... and ${results.length - limit} more. Use --limit to show more.`);
      }
    } catch (err) {
      console.error('Search failed:', err);
      process.exit(1);
    }
  });

// --- check ---
program
  .command('check')
  .description('Validate the catalog against the schema (basic checks)')
  .action(async () => {
    const rootDir = getRepoRoot();

    try {
      const catalog = await loadCatalog(rootDir);
      let errors = 0;

      console.log(`Validating ${catalog.entries.length} entries...\n`);

      // Check required fields
      const requiredFields = ['schemaVersion', 'id', 'type', 'md5', 'imageFormat'] as const;
      for (const entry of catalog.entries) {
        for (const field of requiredFields) {
          if (entry[field] === undefined || entry[field] === null) {
            console.error(`  ERROR: Entry ${entry.id ?? entry.md5}: missing required field "${field}"`);
            errors++;
          }
        }
      }

      // Check ID uniqueness
      const idCounts = new Map<string, number>();
      for (const entry of catalog.entries) {
        idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
      }
      for (const [id, count] of idCounts) {
        if (count > 1) {
          console.error(`  ERROR: Duplicate ID "${id}" appears ${count} times`);
          errors++;
        }
      }

      // Check MD5 uniqueness
      const md5Counts = new Map<string, number>();
      for (const entry of catalog.entries) {
        md5Counts.set(entry.md5, (md5Counts.get(entry.md5) ?? 0) + 1);
      }
      for (const [md5, count] of md5Counts) {
        if (count > 1) {
          console.error(`  ERROR: Duplicate MD5 "${md5}" appears ${count} times`);
          errors++;
        }
      }

      // Check MD5 format
      const md5Pattern = /^[0-9a-f]{32}$/;
      for (const entry of catalog.entries) {
        if (!md5Pattern.test(entry.md5)) {
          console.error(`  ERROR: Entry ${entry.id}: invalid MD5 format "${entry.md5}"`);
          errors++;
        }
      }

      if (errors === 0) {
        console.log('All checks passed.');
      } else {
        console.error(`\n${errors} error(s) found.`);
        process.exit(1);
      }
    } catch (err) {
      console.error('Check failed:', err);
      process.exit(1);
    }
  });

// --- check-deps ---
program
  .command('check-deps')
  .description('Validate all prerequisites are installed')
  .action(() => {
    printDepCheck();
  });

// --- ia-sync ---
program
  .command('ia-sync')
  .description('Incremental sync with Internet Archive')
  .option('--dry-run', 'Show what would change without uploading')
  .option('--limit <n>', 'Maximum items to sync', '10')
  .option('--detect-changes', 'Check git files for modifications before syncing')
  .action(async (options: { dryRun?: boolean; limit: string; detectChanges?: boolean }) => {
    const rootDir = getRepoRoot();
    const limit = parseInt(options.limit, 10);

    try {
      const catalog = await loadCatalog(rootDir);

      // Show status summary
      const summary = getSyncStatusSummary(catalog);
      console.log('Sync status summary:');
      for (const [status, count] of Object.entries(summary)) {
        if (count > 0) console.log(`  ${status}: ${count}`);
      }
      console.log('');

      // Detect changes if requested
      const changedIds = new Set<string>();
      if (options.detectChanges) {
        const modified = await detectChanges(catalog, rootDir);
        if (modified.length > 0) {
          console.log(`Detected ${modified.length} modified entries.\n`);
        }
        for (const id of modified) changedIds.add(id);
      }

      const unsynced = getUnsyncedEntries(catalog);
      console.log(`${unsynced.length} entries not yet synced to Internet Archive.\n`);

      const batch = unsynced.slice(0, limit);
      for (const entry of batch) {
        await syncToIa(entry, options.dryRun ?? true);
        if (options.dryRun === false) changedIds.add(entry.id); // real sync updates IA status
      }

      // Persist changed entries to their YAML (source of truth), then regenerate
      // the catalog JSON from YAML -- never write the JSON from an in-memory copy.
      if (changedIds.size > 0) {
        for (const id of changedIds) {
          const entry = catalog.entries.find(e => e.id === id);
          if (entry?.storage?.git?.yamlPath) await saveFloppyYaml(rootDir, entry);
        }
        await generateCatalogJson(rootDir);
      }
    } catch (err) {
      console.error('IA sync failed:', err);
      process.exit(1);
    }
  });

// --- build-index ---
program
  .command('build-index')
  .description('Rebuild catalog/index.json from floppies.json')
  .action(async () => {
    const rootDir = getRepoRoot();

    try {
      const catalog = await loadCatalog(rootDir);
      await writeIndex(rootDir, catalog);
    } catch (err) {
      console.error('Index build failed:', err);
      process.exit(1);
    }
  });

// --- mcp ---
program
  .command('mcp')
  .description('Start the MCP server for floppy archive access')
  .action(async () => {
    // Dynamically import and run the MCP server
    await import('./mcp/server.js');
  });

// --- ia-verify ---
program
  .command('ia-verify')
  .description('Verify checksums of all Internet Archive items')
  .action(() => {
    console.log('ia-verify: Not yet implemented');
  });

// --- ia-upload ---
program
  .command('ia-upload')
  .description('Upload a single item to Internet Archive')
  .argument('[item]', 'Item ID to upload')
  .action((_item) => {
    console.log('ia-upload: Not yet implemented');
  });

// --- build-static-site ---
program
  .command('build-static-site')
  .description('Build a self-contained static HTML site for GitHub Pages')
  .action(async () => {
    const rootDir = getRepoRoot();
    try {
      await buildStaticSite(rootDir);
    } catch (err) {
      console.error('Static site build failed:', err);
      process.exit(1);
    }
  });

// --- migrate-products ---
program
  .command('migrate-products')
  .description('Migrate catalog/products.json to individual YAML files in products/')
  .action(async () => {
    try {
      await import('./migrate-products.js');
    } catch (err) {
      console.error('Product migration failed:', err);
      process.exit(1);
    }
  });

// --- extract-legacy ---
program
  .command('extract-legacy')
  .description('Extract legacy (metadata-only) entries to catalog/legacy.json')
  .action(async () => {
    try {
      await import('./extract-legacy.js');
    } catch (err) {
      console.error('Extract legacy failed:', err);
      process.exit(1);
    }
  });

// --- rebuild-catalog ---
program
  .command('rebuild-catalog')
  .description('Regenerate catalog/floppies.json and catalog/products.json from YAML files')
  .action(async () => {
    const rootDir = getRepoRoot();
    try {
      console.log('Scanning YAML files and regenerating catalog JSON...');
      const movedPhotos = await consolidateGroupPhotos(rootDir);
      if (movedPhotos > 0) console.log(`Consolidated ${movedPhotos} duplicate set-photo copies into group folders.`);
      await generateCatalogJson(rootDir);
      const catalog = await loadCatalog(rootDir);
      const products = await loadProducts(rootDir);
      console.log(`Generated catalog with ${catalog.entries.length} entries and ${products.length} products.`);
    } catch (err) {
      console.error('Rebuild failed:', err);
      process.exit(1);
    }
  });

// --- identify ---
program
  .command('identify <path>')
  .alias('detect')
  .description('Identify what a disk image holds (NDFS, MS-DOS, BACKUP-SYSTEM, WINCH-TO-FLOPP, tar) - a file or a folder of images')
  .option('-r, --recursive', 'descend into sub-folders')
  .option('--json', 'machine-readable output')
  .option('--only <kind>', 'list only images of this kind (ndfs, dos, backup, winch, tar, none)')
  .action(async (target: string, opts: { recursive?: boolean; json?: boolean; only?: string }) => {
    const { stat, readdir } = await import('fs/promises');
    const { join } = await import('path');
    const { identifyImage, looksLikeImageFile } = await import('./api/identify.js');

    async function collect(p: string, depth: number): Promise<string[]> {
      const st = await stat(p);
      if (st.isFile()) return [p];
      if (!st.isDirectory()) return [];
      const out: string[] = [];
      for (const name of (await readdir(p)).sort()) {
        const full = join(p, name);
        let s;
        try { s = await stat(full); } catch { continue; }
        if (s.isDirectory()) {
          if (opts.recursive && depth < 8) out.push(...await collect(full, depth + 1));
        } else if (looksLikeImageFile(name)) {
          out.push(full);
        }
      }
      return out;
    }

    let files: string[];
    try {
      files = await collect(target, 0);
    } catch (err) {
      console.error(`Cannot read ${target}: ${err}`);
      process.exit(1);
    }
    if (!files.length) {
      console.error(`No disk images found in ${target}` + (opts.recursive ? '' : ' (try --recursive)'));
      process.exit(1);
    }

    const results = [];
    for (const f of files) {
      const r = await identifyImage(f);
      if (opts.only && r.kind !== opts.only) continue;
      results.push(r);
    }

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    const nameW = Math.min(30, Math.max(4, ...results.map(r => (r.name ?? '').length)));
    const fileW = Math.min(42, Math.max(4, ...results.map(r => basename(r.path).length)));
    for (const r of results) {
      const size = (r.bytes / 1024).toFixed(0).padStart(7) + ' KB';
      console.log(
        basename(r.path).padEnd(fileW) + '  ' +
        r.kind.padEnd(7) + ' ' +
        size + '  ' +
        (r.name ?? '').padEnd(nameW) + '  ' +
        (r.error ? 'ERROR: ' + r.error : r.detail)
      );
    }

    const counts: Record<string, number> = {};
    for (const r of results) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
    console.log('\n' + results.length + ' image(s): ' +
      Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
  });

program.parse();
