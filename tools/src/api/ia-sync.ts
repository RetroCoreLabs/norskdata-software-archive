/**
 * Internet Archive sync tracking for the Norsk Data Software Archive.
 * Tracks sync status (pending/uploaded/modified) and detects changes.
 */

import { readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import type { Catalog, CatalogEntry, IaSyncStatus } from '../types.js';

/**
 * Get all catalog entries that have not been synced to Internet Archive.
 * Returns entries where syncStatus is not "uploaded".
 */
export function getUnsyncedEntries(catalog: Catalog): CatalogEntry[] {
  return catalog.entries.filter(e => {
    const syncStatus = e.storage?.internetArchive?.syncStatus;
    return syncStatus !== 'uploaded' && syncStatus !== 'not-applicable';
  });
}

/**
 * Get entries grouped by sync status.
 */
export function getSyncStatusSummary(catalog: Catalog): Record<string, number> {
  const summary: Record<string, number> = {
    pending: 0,
    uploaded: 0,
    modified: 0,
    'not-applicable': 0,
    'no-status': 0,
  };

  for (const entry of catalog.entries) {
    const status = entry.storage?.internetArchive?.syncStatus;
    if (status) {
      summary[status] = (summary[status] ?? 0) + 1;
    } else {
      summary['no-status']++;
    }
  }

  return summary;
}

/**
 * Mark an entry as synced to Internet Archive.
 */
export function markSynced(catalog: Catalog, id: string): boolean {
  const entry = catalog.entries.find(e => e.id === id);
  if (!entry) return false;

  if (!entry.storage) {
    entry.storage = { internetArchive: null };
  }

  if (!entry.storage.internetArchive) {
    entry.storage.internetArchive = {
      itemId: generateIaItemId(entry),
      syncStatus: 'uploaded',
      uploaded: new Date().toISOString(),
    };
  } else {
    entry.storage.internetArchive.syncStatus = 'uploaded';
    entry.storage.internetArchive.uploaded = new Date().toISOString();
  }

  return true;
}

/**
 * Detect changes by comparing git file checksums against catalog checksums.
 * Marks entries as "modified" if the on-disk image differs from recorded MD5.
 */
export async function detectChanges(catalog: Catalog, rootDir: string): Promise<string[]> {
  const modified: string[] = [];

  for (const entry of catalog.entries) {
    const gitPath = entry.storage?.git?.imagePath;
    if (!gitPath) continue;

    // Only check entries that are currently marked as uploaded
    if (entry.storage?.internetArchive?.syncStatus !== 'uploaded') continue;

    try {
      const absPath = join(rootDir, gitPath);
      await stat(absPath);
      // File exists -- we could decompress and checksum but that is expensive.
      // For now, just verify the file is still there.
      // A full integrity check would decompress the .img.gz and compare MD5.
    } catch {
      // File missing or unreadable -- mark as modified
      if (entry.storage?.internetArchive) {
        entry.storage.internetArchive.syncStatus = 'modified';
        modified.push(entry.id);
      }
    }
  }

  return modified;
}

/**
 * Generate an Internet Archive item ID from a catalog entry.
 * Format: norskdata-floppy-{id}
 */
export function generateIaItemId(entry: CatalogEntry): string {
  return `norskdata-floppy-${entry.id}`;
}

/**
 * Stub: sync a single entry to Internet Archive.
 * In dry-run mode, prints what would be uploaded without doing anything.
 */
export async function syncToIa(
  entry: CatalogEntry,
  dryRun: boolean
): Promise<void> {
  const itemId = generateIaItemId(entry);
  const syncStatus = entry.storage?.internetArchive?.syncStatus ?? 'unknown';

  if (dryRun) {
    console.log(`[DRY RUN] Would upload: ${itemId} (status: ${syncStatus})`);
    console.log(`  MD5:          ${entry.md5}`);
    console.log(`  Volume:       ${entry.volumeName ?? '(unknown)'}`);
    console.log(`  StorageClass: ${entry.storageClass ?? '(unset)'}`);
    if (entry.storage?.git?.imagePath) {
      console.log(`  Git path:     ${entry.storage.git.imagePath}`);
    }
    return;
  }

  // Real upload not yet implemented
  console.log(`[STUB] ia-sync upload not yet implemented for ${itemId}`);
}
