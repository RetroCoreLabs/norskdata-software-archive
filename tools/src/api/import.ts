/**
 * Single image importer for the Norsk Data Software Archive.
 * Supports gzip-compressed in-repo storage with MD5-based flat folders.
 *
 * Storage layout: images/{md5}/
 *   image.img.gz  - compressed floppy image
 *   image.yaml    - metadata (source of truth)
 *   image.JPG     - per-disk label photo
 *   labels.txt    - label transcription
 */

import { readFile, writeFile, mkdir, copyFile, stat, readdir } from 'fs/promises';
import { createHash } from 'crypto';
import { basename, dirname, join, extname } from 'path';
import { gzipSync } from 'zlib';
import type { Catalog, CatalogEntry, StorageClass } from '../types.js';
import { generateId, saveFloppyYaml } from './catalog.js';
import { checkDuplicate } from './dedup.js';
import { matchProduct } from './product-matcher.js';
import { detectFilesystem } from './filesystem-detect.js';
import { detectBootFormat as detectBootFormatBytes, detectBootProgram } from './boot-format.js';
import { pageAlign } from '../lib/ndfsalign/index.js';
import { readDosLabel, readBackupSet, readBackupFiles, readDosFiles } from './filesystem-detect.js';

/** Maximum raw image size for in-git storage (roughly 700 NDFS pages) */
/**
 * Largest image kept in git as a floppy.
 *
 * Covers every floppy format this archive sees, up to a 3.5 inch HD disk and
 * the slightly-over-size reads of one: 1,491,456 bytes for winlink/3.img. The
 * old ceiling of 1,400,000 sat just under a 1.44 MB floppy, so those were
 * classified as ia-only and - because nothing wrote them - disappeared.
 */
const FLOPPY_SIZE_LIMIT = 2_000_000;

/**
 * Reduce a source path to "<parent folder>/<filename>" for provenance.
 * Separator-agnostic so it works whether the importer runs on Linux
 * (/mnt/d/ND/foo/bar.img) or Windows (Z:\ND\foo\bar.img); the result always
 * uses forward slashes so the stored value is identical on every platform.
 */
function relativeSourcePath(filePath: string): string {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 1 ? parts.join('/') : parts.slice(-2).join('/');
}

/** Get file modification time as ISO date string (YYYY-MM-DD) */
async function getFileModTime(filePath: string): Promise<string | null> {
  try {
    const s = await stat(filePath);
    return s.mtime.toISOString().substring(0, 10);
  } catch {
    return null;
  }
}

// ── NDFS parsing ──────────────────────────────────────────────

interface NdfsParseResult {
  volumeName: string | null;
  totalPages: number;
  bootFormat: string | null;
  bootProgram: string | null;
  users: { name: string; pagesUsed: number }[];
  files: { name: string; type: string; pages: number; bytes: number; userName: string; dateCreated: number | null; lastDateRead: number | null; lastDateWritten: number | null; dateCreatedStr: string | null; lastDateReadStr: string | null; lastDateWrittenStr: string | null; bpunValid: boolean | null }[];
}

function formatNdDate(value: number | null | undefined): string | null {
  if (!value) return null;
  const year   = ((value >>> 26) & 0x3f) + 1950;
  const month  = (value >>> 22) & 0x0f;
  const day    = (value >>> 17) & 0x1f;
  const hour   = (value >>> 12) & 0x1f;
  const minute = (value >>> 6) & 0x3f;
  const second = value & 0x3f;
  if (month === 0 || day === 0) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

/**
 * What the boot area of page 0 holds, read from the bytes alone. Independent of
 * the filesystem: a damaged floppy still has a readable boot area.
 */
function readBootArea(buffer: Buffer): { format: string | null; program: string | null } {
  try {
    if (buffer.length < 2048) return { format: null, program: null };
    const page0 = new Uint8Array(buffer.subarray(0, 2048));
    return { format: detectBootFormatBytes(page0), program: detectBootProgram(page0) };
  } catch {
    return { format: null, program: null };
  }
}

async function tryParseNdfs(buffer: Buffer): Promise<NdfsParseResult | null> {
  try {
    const ndfsModule = await import('norskdata-ndfs');
    const NdfsFileSystem = ndfsModule.NdfsFileSystem;
    if (!NdfsFileSystem) return null;

    // padded to a whole number of pages: a read that stops a fraction of a
    // page short is still a readable ND floppy
    const fs = new NdfsFileSystem(pageAlign(new Uint8Array(buffer)), true);
    const volumeName = fs.getDirectoryName?.() ?? null;
    const masterBlock = fs.getMasterBlock?.();
    const totalPages = masterBlock?.imageSize ?? (buffer.length / 2048);

    // Read from the bytes of page 0 by this repo's own test, not the parser's:
    // the parser reads the words after the "!" packed and so validates nothing,
    // which is why every "bpun" it reports in this archive is a stray 0x21 in
    // ordinary data. See api/boot-format.ts and docs/boot-formats.md.
    let bootFormat: string | null = null;
    let bootProgram: string | null = null;
    try {
      const page0 = new Uint8Array(buffer.subarray(0, 2048));
      bootFormat = detectBootFormatBytes(page0);
      bootProgram = detectBootProgram(page0);
    } catch { /* ignore */ }

    const users: { name: string; pagesUsed: number }[] = [];
    try {
      const userList = fs.getUsers?.() ?? [];
      for (const u of userList) {
        if (u && u.userName) {
          users.push({ name: u.userName, pagesUsed: u.pagesUsed ?? 0 });
        }
      }
    } catch { /* ignore */ }

    const files: NdfsParseResult['files'] = [];
    try {
      const objectEntries = fs.getObjectEntries?.() ?? [];
      for (const oe of objectEntries) {
        if (oe && oe.objectName) {
          // BPUN checksum validation
          let bpunValid: boolean | null = null;
          if (oe.type === 'BPUN') {
            try {
              const fileData = fs.readFile(`${oe.userName}/${oe.objectName}:${oe.type}`);
              if (fileData && fileData.length >= 10) {
                let bangOff = -1;
                for (let i = 0; i < fileData.length; i++) {
                  if (fileData[i] === 0x21 || (fileData[i] & 0x7F) === 0x21) { bangOff = i; break; }
                }
                const dataOff = bangOff >= 0 ? bangOff + 1 : 0;
                if (dataOff + 4 <= fileData.length) {
                  const count = (fileData[dataOff + 2] << 8) | fileData[dataOff + 3];
                  if (count > 0) {
                    const wordsStart = dataOff + 4;
                    const wordsEnd = wordsStart + count * 2;
                    if (wordsEnd + 2 <= fileData.length) {
                      let calcSum = 0;
                      for (let i = wordsStart; i < wordsEnd; i += 2) {
                        calcSum = (calcSum + ((fileData[i] << 8) | fileData[i + 1])) & 0xFFFF;
                      }
                      const stored = (fileData[wordsEnd] << 8) | fileData[wordsEnd + 1];
                      bpunValid = (calcSum === stored);
                    }
                  }
                }
              }
            } catch { /* ignore */ }
          }

          files.push({
            name: oe.fullName ?? `${oe.objectName}:${oe.type ?? ''}`,
            type: oe.type ?? '',
            pages: oe.pagesInFile ?? 0,
            bytes: oe.bytesInFile ?? 0,
            userName: oe.userName ?? '',
            dateCreated: oe.dateCreated || null,
            lastDateRead: oe.lastDateRead || null,
            lastDateWritten: oe.lastDateWritten || null,
            dateCreatedStr: formatNdDate(oe.dateCreated),
            lastDateReadStr: formatNdDate(oe.lastDateRead),
            lastDateWrittenStr: formatNdDate(oe.lastDateWritten),
            bpunValid,
          });
        }
      }
    } catch { /* ignore */ }

    return { volumeName, totalPages, bootFormat, bootProgram, users, files };
  } catch {
    return null;
  }
}

// ── Path classification ───────────────────────────────────────

/**
 * Determine the target directory for an image.
 * Uses flat MD5-based folders: images/{md5}/
 */
export function classifyTargetPath(md5: string): string {
  return `images/${md5}`;
}

/**
 * Resolve filename collisions in target directory.
 * - Same name + same MD5 -> return null (skip, duplicate)
 * - Same name + different MD5 -> append _{md5[:6]} to basename
 * - No collision -> use original
 */
async function resolveFilename(
  rootDir: string,
  targetDir: string,
  baseName: string,
  md5: string
): Promise<string | null> {
  const gzName = baseName.replace(/\.img$/i, '') + '.img.gz';
  const targetPath = join(rootDir, targetDir, gzName);

  try {
    await stat(targetPath);
    // File exists - check if it's the same content
    const yamlName = baseName.replace(/\.img$/i, '') + '.yaml';
    const yamlPath = join(rootDir, targetDir, yamlName);
    try {
      const raw = await readFile(yamlPath, 'utf-8');
      const { parse } = await import('yaml');
      const doc = parse(raw);
      if (doc && doc.md5 === md5) {
        return null; // Same content, skip
      }
    } catch {
      // No YAML or can't read, treat as collision
    }
    // Different content - append md5 prefix
    const stem = baseName.replace(/\.img$/i, '');
    return `${stem}_${md5.slice(0, 6)}.img.gz`;
  } catch {
    // File doesn't exist, use original name
    return gzName;
  }
}

// ── Artifact scanning ─────────────────────────────────────────

export interface ScannedArtifacts {
  diskPhotos: Map<string, string[]>;  // imgFilename -> [photo filenames]
  setPhotos: string[];
  transcription: string | null;
  /** imgFilename -> [log filenames] for logs named after their own image */
  diskLogs: Map<string, string[]>;
  /** logs that belong to no single disk, copied to every disk of the set */
  imagingLogs: string[];
  unmapped: string[];                 // files not matching any configured extension
  /**
   * Photos named after an image file that is present in the source folder but
   * is not part of this run (already held, skipped, or imported separately).
   * They belong to that one disk, so they are neither a disk photo here nor a
   * photo of the set - they are left behind and only reported.
   */
  otherDiskPhotos: string[];
  /**
   * The same case for read logs: a log named after an image that lies in the
   * source folder but is not part of this run. It is that one disk's log, so
   * it is not the folder's either - left behind and only reported.
   */
  otherDiskLogs: string[];
}

/** Configurable extension lists for scanning */
export interface ScanExtensions {
  image: string[];    // e.g. ['.img', '.image', '.scp', '.hfe']
  photo: string[];    // e.g. ['.jpg', '.jpeg', '.png', '.tiff']
  document: string[]; // e.g. ['.txt', '.log', '.pdf']
}

export const DEFAULT_SCAN_EXTENSIONS: ScanExtensions = {
  image: ['.img', '.image'],
  photo: ['.jpg', '.jpeg', '.png', '.tiff', '.tif', '.bmp'],
  document: ['.txt', '.log', '.pdf'],
};

/**
 * Scan a source folder for all files, classify them by extension config.
 * Returns classified artifacts + unmapped files.
 */
export async function scanFolderArtifacts(
  sourceDir: string,
  imgFilenames: string[],
  volumeNames: (string | null)[],
  extensions?: ScanExtensions
): Promise<ScannedArtifacts> {
  const ext_cfg = extensions ?? DEFAULT_SCAN_EXTENSIONS;
  const diskPhotos = new Map<string, string[]>();
  const setPhotos: string[] = [];
  let transcription: string | null = null;
  const diskLogs = new Map<string, string[]>();
  const imagingLogs: string[] = [];
  const unmapped: string[] = [];
  const otherDiskPhotos: string[] = [];
  const otherDiskLogs: string[] = [];

  const imgBases = imgFilenames.map(f => f.replace(/\.[^.]+$/i, '').toLowerCase());
  const volBases = volumeNames.filter(Boolean).map(v => v!.toLowerCase());

  const photoExts = new Set(ext_cfg.photo.map(e => e.toLowerCase()));
  const docExts = new Set(ext_cfg.document.map(e => e.toLowerCase()));
  const imageExts = new Set(ext_cfg.image.map(e => e.toLowerCase()));

  try {
    const files = await readdir(sourceDir);

    // Every image file lying in the folder, not just the ones being imported
    // now. A folder that names its photos after its disks (1.img/1.jpg,
    // 2.img/2.jpg, ...) used to give every photo of a disk outside this run to
    // the whole set, so one floppy ended up carrying four other floppies'
    // label photos.
    const folderImgBases = new Set(
      files
        .filter(f => imageExts.has(extname(f).toLowerCase()))
        .map(f => f.replace(/\.[^.]+$/i, '').toLowerCase())
    );

    for (const f of files) {
      const ext = extname(f).toLowerCase();

      // Skip image files (they're handled by the import pipeline, not artifacts)
      if (imageExts.has(ext)) continue;

      // Skip directories
      try {
        const s = await stat(join(sourceDir, f));
        if (s.isDirectory()) continue;
      } catch { continue; }

      if (photoExts.has(ext)) {
        // Photo: check if it matches a specific disk
        const photoBase = f.replace(/\.[^.]+$/i, '').toLowerCase();
        let matched = false;
        for (let i = 0; i < imgBases.length; i++) {
          if (photoBase === imgBases[i] || (volBases[i] && photoBase === volBases[i])) {
            const key = imgFilenames[i];
            if (!diskPhotos.has(key)) diskPhotos.set(key, []);
            diskPhotos.get(key)!.push(f);
            matched = true;
            break;
          }
        }
        if (!matched) {
          // Named after a disk that is in the folder but not in this run -
          // that disk's photo, never the set's.
          if (folderImgBases.has(photoBase)) otherDiskPhotos.push(f);
          else setPhotos.push(f);
        }
      } else if (f.toLowerCase() === 'labels.txt') {
        transcription = f;
      } else if (docExts.has(ext)) {
        // A read log named after its own image (cob1.log next to cob1.img) is
        // that disk's file, not the folder's. Matched exactly like a photo -
        // without this every disk in the folder got a copy of every log.
        const logBase = f.replace(/\.[^.]+$/i, '').toLowerCase();
        let matchedLog = false;
        for (let i = 0; i < imgBases.length; i++) {
          if (logBase === imgBases[i] || (volBases[i] && logBase === volBases[i])) {
            const key = imgFilenames[i];
            if (!diskLogs.has(key)) diskLogs.set(key, []);
            diskLogs.get(key)!.push(f);
            matchedLog = true;
            break;
          }
        }
        if (!matchedLog) {
          // Named after a disk lying in the folder but outside this run - that
          // disk's log. Without this it counted as a log of the whole folder
          // and was copied onto an image it has nothing to do with.
          if (folderImgBases.has(logBase)) otherDiskLogs.push(f);
          else imagingLogs.push(f);
        }
      } else {
        // Not matched by any configured extension
        unmapped.push(f);
      }
    }
  } catch { /* ignore */ }

  return { diskPhotos, setPhotos, transcription, diskLogs, imagingLogs, unmapped, otherDiskPhotos, otherDiskLogs };
}

/**
 * Copy set-level artifacts flat into {targetDir}/. Deduplicates (skips if exists).
 *
 * `alreadyPlaced` is how a folder import avoids the mistake this used to make:
 * a document that belongs to the whole folder - a readme, an install note, a
 * read log whose disk was never imported - was copied into EVERY image folder of
 * the batch, so one readme became five files and one batch of read logs became
 * thousands. Such a document is copied once, for the first image of the import,
 * and the callers after it are told to leave it alone.
 *
 * Photos and the label transcription are not affected: a set photo is
 * consolidated into collections/ afterwards, and labels.txt belongs to the disk.
 */
export async function copySetArtifacts(
  rootDir: string,
  sourceDir: string,
  targetDir: string,
  artifacts: { setPhotos: string[]; transcription: string | null; imagingLogs: string[] },
  alreadyPlaced?: Set<string>,
): Promise<{ setPhotos: string[]; labelTranscription: string | null; imagingLogs: string[] }> {
  const absTargetDir = join(rootDir, targetDir);
  await mkdir(absTargetDir, { recursive: true });

  const setPhotos: string[] = [];
  for (const photo of artifacts.setPhotos) {
    const dst = join(absTargetDir, photo);
    try { await stat(dst); } catch { await copyFile(join(sourceDir, photo), dst); }
    setPhotos.push(join(targetDir, photo));
  }

  let labelTranscription: string | null = null;
  if (artifacts.transcription) {
    const fname = basename(artifacts.transcription);
    const dst = join(absTargetDir, fname);
    try { await stat(dst); } catch { await copyFile(join(sourceDir, artifacts.transcription), dst); }
    labelTranscription = join(targetDir, fname);
  }

  // Documents belonging to the folder rather than to this disk: copy each once.
  const imagingLogs: string[] = [];
  for (const logFile of artifacts.imagingLogs) {
    if (alreadyPlaced?.has(logFile)) continue;
    const dst = join(absTargetDir, logFile);
    try { await stat(dst); } catch { await copyFile(join(sourceDir, logFile), dst); }
    alreadyPlaced?.add(logFile);
    imagingLogs.push(join(targetDir, logFile));
  }

  return { setPhotos, labelTranscription, imagingLogs };
}

/**
 * Copy disk-specific photos next to the .img.gz in the target dir.
 */
export async function copyDiskPhotos(
  rootDir: string,
  sourceDir: string,
  targetDir: string,
  photoFilenames: string[]
): Promise<string[]> {
  const absTarget = join(rootDir, targetDir);
  await mkdir(absTarget, { recursive: true });
  const paths: string[] = [];
  for (const photo of photoFilenames) {
    const dst = join(absTarget, photo);
    try { await stat(dst); } catch { await copyFile(join(sourceDir, photo), dst); }
    paths.push(join(targetDir, photo));
  }
  return paths;
}

// ── Single image import ───────────────────────────────────────

export interface ImportOptions {
  contributor?: string;
  source?: string;
  sourceDir?: string;
  /** Pre-determined target directory (set by importFolder for batch imports) */
  targetDir?: string;
  /** Pre-copied set artifacts (shared across all images in a folder import) */
  setArtifacts?: { setPhotos: string[]; labelTranscription: string | null; imagingLogs: string[] };
  /** Pre-scanned disk photos for this specific image */
  diskPhotoFiles?: string[];
  /** Pre-scanned read logs belonging to this specific image (e.g. cob1.log) */
  diskLogFiles?: string[];
}

/**
 * Import a single image file into the catalog.
 */
export async function importImage(
  catalog: Catalog,
  filePath: string,
  rootDir?: string,
  options?: ImportOptions
): Promise<{ entry: CatalogEntry; isDuplicate: boolean; isVariant: boolean }> {
  const buffer = await readFile(filePath);

  const md5 = createHash('md5').update(buffer).digest('hex');

  const dupCheck = checkDuplicate(catalog, md5);
  if (dupCheck.isDuplicate && dupCheck.existingEntry) {
    return { entry: dupCheck.existingEntry, isDuplicate: true, isVariant: false };
  }

  const ndfsResult = await tryParseNdfs(buffer);

  const bootArea = readBootArea(buffer);
  const volumeName = ndfsResult?.volumeName ?? null;
  const productMatch = matchProduct(volumeName);
  const id = generateId(md5, volumeName);

  const isFloppy = buffer.length <= FLOPPY_SIZE_LIMIT;
  const storageClass: StorageClass = isFloppy ? 'floppy-in-git' : 'ia-only';

  let gitImagePath: string | null = null;
  let gitYamlPath: string | null = null;
  let gitDiskPhotos: string[] = [];
  let gitSetPhotos: string[] = [];
  let gitLabelTranscription: string | null = null;
  let gitImagingLogs: string[] = [];

  if (isFloppy && rootDir) {
    const targetDir = options?.targetDir ?? classifyTargetPath(md5);

    await mkdir(join(rootDir, targetDir), { recursive: true });

    const filename = basename(filePath);
    const resolvedName = await resolveFilename(rootDir, targetDir, filename, md5);

    if (resolvedName === null) {
      // Exact duplicate file already on disk
      return { entry: { ...buildEntry(), id }, isDuplicate: true, isVariant: false };
    }

    const gzPath = join(rootDir, targetDir, resolvedName);
    await writeFile(gzPath, gzipSync(buffer, { level: 9 }));
    gitImagePath = join(targetDir, resolvedName);

    // YAML path matches the .img.gz name
    const yamlName = resolvedName.replace(/\.img\.gz$/, '.yaml');
    gitYamlPath = join(targetDir, yamlName);

    // Handle artifacts
    if (options?.setArtifacts) {
      // Artifacts already copied by importFolder
      gitSetPhotos = options.setArtifacts.setPhotos;
      gitLabelTranscription = options.setArtifacts.labelTranscription;
      gitImagingLogs = options.setArtifacts.imagingLogs;
    } else {
      // Standalone import - scan and copy artifacts.
      //
      // Only what belongs to THIS image is taken. A document the scan could not
      // match to it - a readme for the folder, a read log of a disk that was
      // never imported, notes about other disks - belongs to the folder, and a
      // single-file import knows nothing about the rest of that folder. Copying
      // it here is how one readme ended up in five image folders: every call
      // scanned the same folder and claimed the same document.
      const sourceDir = options?.sourceDir ?? dirname(filePath);
      const artifacts = await scanFolderArtifacts(sourceDir, [filename], [volumeName]);
      const setResult = await copySetArtifacts(rootDir, sourceDir, targetDir,
        { ...artifacts, imagingLogs: [] });
      gitSetPhotos = setResult.setPhotos;
      gitLabelTranscription = setResult.labelTranscription;
      gitImagingLogs = setResult.imagingLogs;
      const myDiskPhotos = artifacts.diskPhotos.get(filename) ?? [];
      if (myDiskPhotos.length > 0) {
        gitDiskPhotos = await copyDiskPhotos(rootDir, sourceDir, targetDir, myDiskPhotos);
      }
      const myLogs = artifacts.diskLogs.get(filename) ?? [];
      if (myLogs.length > 0) {
        gitImagingLogs = gitImagingLogs.concat(await copyDiskPhotos(rootDir, sourceDir, targetDir, myLogs));
      }
    }

    // Disk photos for this specific image (from folder import)
    if (options?.diskPhotoFiles && options.diskPhotoFiles.length > 0 && !gitDiskPhotos.length) {
      const sourceDir = options?.sourceDir ?? dirname(filePath);
      gitDiskPhotos = await copyDiskPhotos(rootDir, sourceDir, targetDir, options.diskPhotoFiles);
    }

    // Read logs belonging to this image only (from folder import)
    if (options?.diskLogFiles && options.diskLogFiles.length > 0) {
      const sourceDir = options?.sourceDir ?? dirname(filePath);
      gitImagingLogs = gitImagingLogs.concat(
        await copyDiskPhotos(rootDir, sourceDir, targetDir, options.diskLogFiles)
      );
    }
  }

  function buildEntry(): CatalogEntry {
    return {
      schemaVersion: '1.0',
      id: '',
      type: 'floppy',
      md5: '',
      volumeName: null,
      productId: null,
      version: null,
      systemNumber: null,
      diskNumber: null,
      diskTotal: null,
      mediaRole: null,
      storageClass: null,
      imageSizeBytes: null,
      imageFormat: 'raw',
      controller: null,
      totalPages: null,
      pageSize: null,
      bootFormat: null,
      cpuTarget: null,
      osRequirement: null,
      ndfs: null,
      docs: null,
      provenance: null,
      storage: null,
      variants: null,
      fluxPreservation: null,
      legacyId: null,
      importedAt: null,
      tags: null,
    };
  }

  const entry: CatalogEntry = {
    schemaVersion: '1.0',
    id,
    type: 'floppy',
    md5,
    volumeName,
    // Leave productId unset so a name-matched floppy lands in the Matcher's
    // "auto" queue for the user to confirm, rather than being silently linked.
    // version/diskNumber are factual disk metadata parsed from the volume name,
    // so we keep them as hints; only the product link awaits confirmation.
    productId: null,
    version: productMatch?.version ?? null,
    systemNumber: null,
    diskNumber: productMatch?.diskNumber ?? null,
    diskTotal: null,
    mediaRole: null,
    storageClass,
    imageSizeBytes: buffer.length,
    imageFormat: 'raw',
    controller: 'floppy',
    totalPages: ndfsResult?.totalPages ?? null,
    pageSize: ndfsResult ? 2048 : null,
    // Read straight from page 0, not from the parse result: the boot area does
    // not depend on the filesystem, so a floppy whose master block or index
    // pages are damaged still says what it holds. Taking it from ndfsResult
    // lost it on every image the parser rejected.
    bootFormat: bootArea.format,
    bootProgram: bootArea.program,
    cpuTarget: null,
    osRequirement: null,
    ndfs: ndfsResult ? { users: ndfsResult.users, files: ndfsResult.files } : null,
    // Record what the image actually holds. An image the NDFS parser rejects is
    // not necessarily broken - it may be an MS-DOS floppy or a tar written
    // straight to the media.
    filesystem: detectFilesystem(buffer, !!ndfsResult),
    volumeLabel: readDosLabel(buffer),
    backupSet: readBackupSet(buffer),
    backupFiles: readBackupFiles(buffer),
    dosFiles: readDosFiles(buffer),
    docs: null,
    provenance: {
      contributor: options?.contributor ?? 'unknown',
      // Store only "<parent folder>/<filename>" -- the absolute prefix is
      // machine-specific noise (a contributor's local mount) and useless later.
      // The parent folder is kept because the Matcher groups unmatched floppies
      // by it. Dedup is MD5-based, so the path plays no role on re-import.
      // Separator-agnostic + always forward-slash so Windows and Linux match.
      originalPath: relativeSourcePath(filePath),
      dateImaged: await getFileModTime(filePath),
    },
    storage: {
      git: gitImagePath ? {
        imagePath: gitImagePath,
        yamlPath: gitYamlPath!,
        diskPhotos: gitDiskPhotos,
        setPhotos: gitSetPhotos,
        labelTranscription: gitLabelTranscription,
        imagingLogs: gitImagingLogs,
      } : null,
      internetArchive: { itemId: `norskdata-floppy-${id}`, syncStatus: 'pending' },
    },
    variants: null,
    fluxPreservation: null,
    legacyId: null,
    importedAt: new Date().toISOString(),
    tags: null,
  };

  // Write YAML file next to the image
  if (gitYamlPath && rootDir) {
    await saveFloppyYaml(rootDir, entry);
  } else if (rootDir && !isFloppy) {
    // Too large for git: the image belongs on Internet Archive, but the entry
    // still has to exist. Writing nothing lost the floppy silently and told the
    // caller it had been imported - which is how winlink/3.img vanished.
    const targetDir = options?.targetDir ?? classifyTargetPath(md5);
    await mkdir(join(rootDir, targetDir), { recursive: true });
    const yamlName = basename(filePath).replace(/\.(img|image|ima|dsk)$/i, '') + '.yaml';
    entry.storage = {
      ...(entry.storage ?? {}),
      git: { imagePath: null as any, yamlPath: join(targetDir, yamlName), labelPhotos: [], labelTranscription: null, imagingLogs: [] } as any,
    } as any;
    await saveFloppyYaml(rootDir, entry);
  }

  return { entry, isDuplicate: false, isVariant: dupCheck.isVariant ?? false };
}
