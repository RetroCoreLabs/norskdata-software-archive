#!/usr/bin/env node

/**
 * MCP server for the Norsk Data Software Archive.
 * Exposes floppy catalog search and retrieval tools via the Model Context Protocol.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import type { CatalogEntry } from '../types.js';
import { loadDocIndex, readDocMarkdown, DOC_KIND_LABELS, type DocIndex } from '../api/nd-docs.js';

// --- Data loading ---

interface Product {
  Id: string;
  Name: string;
}

let entries: CatalogEntry[] = [];
let products: Product[] = [];
let searchIndex: { entry: CatalogEntry; text: string }[] = [];
/** ND documents (docs/nd/**) referenced by products/*.yaml */
let docIndex: DocIndex = { docs: new Map(), byProduct: new Map() };
/** document id -> lowercased markdown, for search_documents */
let docText: Map<string, string> = new Map();

/**
 * Resolve the archive root directory.
 * Uses ARCHIVE_ROOT env var, or falls back to repo root relative to this file.
 */
function getArchiveRoot(): string {
  if (process.env.ARCHIVE_ROOT) {
    return resolve(process.env.ARCHIVE_ROOT);
  }
  // server.ts -> src/mcp/server.ts -> compiled to dist/mcp/server.js
  // repo root is three levels up from dist/mcp/
  return resolve(import.meta.dirname ?? '.', '..', '..', '..');
}

async function loadData(): Promise<void> {
  const root = getArchiveRoot();

  const floppiesRaw = await readFile(join(root, 'catalog/floppies.json'), 'utf-8');
  entries = JSON.parse(floppiesRaw);

  const productsRaw = await readFile(join(root, 'catalog/products.json'), 'utf-8');
  products = JSON.parse(productsRaw);

  // ND documentation: resolved from the docs: block of each products/*.yaml
  docIndex = await loadDocIndex(root);
  docText = new Map();
  for (const doc of docIndex.docs.values()) {
    const md = await readDocMarkdown(root, doc);
    if (md !== null) docText.set(doc.id, md.toLowerCase());
  }

  // Build search index: concatenate searchable fields into a single lowercase string
  searchIndex = entries.map(entry => {
    const parts: string[] = [
      entry.id,
      entry.volumeName ?? '',
      entry.productId ?? '',
      entry.version ?? '',
      entry.bootFormat ?? '',
      entry.storageClass ?? '',
      ...(entry.tags ?? []),
    ];

    // Add NDFS file names if available
    if (entry.ndfs?.files) {
      for (const f of entry.ndfs.files) {
        parts.push(f.name);
      }
    }

    // Add directory content for legacy entries without parsed NDFS
    if (entry.directoryContentRaw) {
      parts.push(entry.directoryContentRaw);
    }

    return { entry, text: parts.join(' ').toLowerCase() };
  });
}

// --- Helper functions ---

function summarizeEntry(entry: CatalogEntry) {
  return {
    id: entry.id,
    volumeName: entry.volumeName,
    productId: entry.productId,
    version: entry.version,
    bootFormat: entry.bootFormat,
    imageSizeBytes: entry.imageSizeBytes,
    storageClass: entry.storageClass,
  };
}

function findEntry(id: string): CatalogEntry | undefined {
  const lower = id.toLowerCase();
  return entries.find(e =>
    e.id.toLowerCase() === lower ||
    e.md5.toLowerCase() === lower ||
    (e.volumeName && e.volumeName.toLowerCase() === lower)
  );
}

// --- MCP Server setup ---

const server = new McpServer({
  name: 'norskdata-software-archive',
  version: '1.0.0',
});

// Tool: search_floppies
server.tool(
  'search_floppies',
  'Full-text search across floppy volume names, product IDs, NDFS file names, tags, and directory content',
  {
    query: z.string().describe('Search query (substring match)'),
    limit: z.number().default(10).describe('Maximum results to return'),
  },
  async ({ query, limit }) => {
    const lowerQuery = query.toLowerCase();
    const matches = searchIndex
      .filter(item => item.text.includes(lowerQuery))
      .slice(0, limit)
      .map(item => summarizeEntry(item.entry));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ count: matches.length, results: matches }, null, 2),
      }],
    };
  }
);

// Tool: get_floppy
server.tool(
  'get_floppy',
  'Get full metadata for a specific floppy image by ID, MD5, SHA256, or volume name',
  {
    id: z.string().describe('Catalog ID, MD5 hash, SHA256 hash, or volume name'),
  },
  async ({ id }) => {
    const entry = findEntry(id);
    if (!entry) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `No entry found for "${id}"` }),
        }],
        isError: true,
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(entry, null, 2),
      }],
    };
  }
);

// Tool: list_product_floppies
server.tool(
  'list_product_floppies',
  'List all floppy images associated with a product ID',
  {
    productId: z.string().describe('Product ID (e.g., "ND-10325")'),
  },
  async ({ productId }) => {
    const lower = productId.toLowerCase();
    const matches = entries
      .filter(e => e.productId?.toLowerCase() === lower)
      .map(summarizeEntry);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ productId, count: matches.length, floppies: matches }, null, 2),
      }],
    };
  }
);

// Tool: list_products
server.tool(
  'list_products',
  'List all known products with their floppy image counts',
  {},
  async () => {
    // Count images per product
    const countMap = new Map<string, number>();
    for (const entry of entries) {
      if (entry.productId) {
        countMap.set(entry.productId, (countMap.get(entry.productId) ?? 0) + 1);
      }
    }

    const result = products.map(p => ({
      productId: p.Id,
      productName: p.Name,
      imageCount: countMap.get(p.Id) ?? 0,
    }));

    // Also include products that appear in catalog but not in products.json
    for (const [pid, count] of countMap) {
      if (!products.find(p => p.Id === pid)) {
        result.push({ productId: pid, productName: '(unknown)', imageCount: count });
      }
    }

    result.sort((a, b) => b.imageCount - a.imageCount);

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ count: result.length, products: result }, null, 2),
      }],
    };
  }
);

// Tool: download_floppy
server.tool(
  'download_floppy',
  'Get the local path or Internet Archive URL for a floppy image file',
  {
    id: z.string().describe('Catalog ID, MD5 hash, SHA256 hash, or volume name'),
    targetDir: z.string().optional().describe('Optional target directory for downloaded files'),
  },
  async ({ id, targetDir: _targetDir }) => {
    const entry = findEntry(id);
    if (!entry) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `No entry found for "${id}"` }),
        }],
        isError: true,
      };
    }

    const root = getArchiveRoot();
    const result: Record<string, string | null> = {
      id: entry.id,
      storageClass: entry.storageClass,
      localPath: null,
      iaUrl: null,
    };

    // If in git, provide the local .img.gz path
    if (entry.storage?.git?.imagePath) {
      result.localPath = join(root, entry.storage.git.imagePath);
    }

    // Internet Archive URL - only once the item has really been uploaded;
    // every entry carries a generated itemId long before any upload happens.
    if (entry.storage?.internetArchive?.itemId && entry.storage.internetArchive.syncStatus === 'uploaded') {
      const itemId = entry.storage.internetArchive.itemId;
      result.iaUrl = `https://archive.org/details/${itemId}`;
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// Tool: list_floppy_files
server.tool(
  'list_floppy_files',
  'List NDFS files inside a floppy image from cached metadata (no download needed)',
  {
    id: z.string().describe('Catalog ID, MD5 hash, SHA256 hash, or volume name'),
  },
  async ({ id }) => {
    const entry = findEntry(id);
    if (!entry) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ error: `No entry found for "${id}"` }),
        }],
        isError: true,
      };
    }

    if (!entry.ndfs && !entry.directoryContentRaw) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: entry.id,
            volumeName: entry.volumeName,
            message: 'No NDFS metadata or directory content available for this image',
          }, null, 2),
        }],
      };
    }

    const result: Record<string, unknown> = {
      id: entry.id,
      volumeName: entry.volumeName,
      bootFormat: entry.bootFormat,
    };

    if (entry.ndfs) {
      result.users = entry.ndfs.users;
      result.files = entry.ndfs.files;
    } else if (entry.directoryContentRaw) {
      result.directoryContentRaw = entry.directoryContentRaw;
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// Tool: get_archive_stats
server.tool(
  'get_archive_stats',
  'Get summary statistics about the floppy archive',
  {},
  async () => {
    const byStorageClass: Record<string, number> = {};
    const byBootFormat: Record<string, number> = {};
    const productCounts: Record<string, number> = {};

    for (const entry of entries) {
      const sc = entry.storageClass ?? 'unknown';
      byStorageClass[sc] = (byStorageClass[sc] ?? 0) + 1;

      const bf = entry.bootFormat ?? 'unknown';
      byBootFormat[bf] = (byBootFormat[bf] ?? 0) + 1;

      if (entry.productId) {
        productCounts[entry.productId] = (productCounts[entry.productId] ?? 0) + 1;
      }
    }

    // Top 10 products by image count
    const topProducts = Object.entries(productCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([productId, count]) => {
        const product = products.find(p => p.Id === productId);
        return { productId, productName: product?.Name ?? '(unknown)', imageCount: count };
      });

    const stats = {
      totalImages: entries.length,
      byStorageClass,
      byBootFormat,
      productCount: Object.keys(productCounts).length,
      topProducts,
    };

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(stats, null, 2),
      }],
    };
  }
);


// --- ND documentation tools ---

/** Shape returned for a document, without its body. */
function summarizeDoc(id: string) {
  const d = docIndex.docs.get(id);
  if (!d) return null;
  return {
    documentId: d.id,
    title: d.title,
    kind: d.kind,
    kindLabel: DOC_KIND_LABELS[d.kind],
    path: d.path,
    describesProducts: d.products,
  };
}

// Tool: list_product_documents
server.tool(
  'list_product_documents',
  'List the ND documents (Program/Installation Descriptions and Product Information sheets) that describe a given product',
  {
    productId: z.string().describe('Product article number, e.g. ND-10174'),
  },
  async ({ productId }) => {
    const ids = docIndex.byProduct.get(productId) ?? [];
    const product = products.find(p => p.Id === productId);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          productId,
          productName: product?.Name ?? null,
          count: ids.length,
          documents: ids.map(summarizeDoc).filter(Boolean),
        }, null, 2),
      }],
    };
  }
);

// Tool: read_document
server.tool(
  'read_document',
  'Read the full markdown text of an ND document by its document id (e.g. ND-10174-10-EN). Use list_product_documents or search_documents to find ids.',
  {
    documentId: z.string().describe('ND document id, e.g. ND-10174-10-EN'),
    maxChars: z.number().default(40000).describe('Truncate the body to this many characters'),
    offset: z.number().default(0).describe('Character offset to start reading from, for paging through a long document'),
  },
  async ({ documentId, maxChars, offset }) => {
    const doc = docIndex.docs.get(documentId);
    if (!doc) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `No document "${documentId}"` }) }],
        isError: true,
      };
    }
    const md = await readDocMarkdown(getArchiveRoot(), doc);
    if (md === null) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: `Document "${documentId}" is referenced but missing at ${doc.path}` }) }],
        isError: true,
      };
    }
    const body = md.slice(offset, offset + maxChars);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          ...summarizeDoc(documentId),
          totalChars: md.length,
          offset,
          returnedChars: body.length,
          truncated: offset + body.length < md.length,
          markdown: body,
        }, null, 2),
      }],
    };
  }
);

// Tool: search_documents
server.tool(
  'search_documents',
  'Full-text search across all ND product documentation, returning matching documents with a snippet around the first hit',
  {
    query: z.string().describe('Search query (substring match, case-insensitive)'),
    limit: z.number().default(10).describe('Maximum documents to return'),
  },
  async ({ query, limit }) => {
    const q = query.toLowerCase();
    const results: unknown[] = [];
    for (const [id, text] of docText) {
      const at = text.indexOf(q);
      if (at === -1) continue;
      const root = getArchiveRoot();
      const doc = docIndex.docs.get(id)!;
      const md = await readDocMarkdown(root, doc);
      const start = Math.max(0, at - 120);
      results.push({
        ...summarizeDoc(id),
        matches: text.split(q).length - 1,
        snippet: (md ?? '').slice(start, at + q.length + 200).replace(/\s+/g, ' ').trim(),
      });
      if (results.length >= limit) break;
    }
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ count: results.length, results }, null, 2),
      }],
    };
  }
);

// --- Start server ---

async function main() {
  await loadData();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
