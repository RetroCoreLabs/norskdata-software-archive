/**
 * Type definitions for the Norsk Data Software Archive catalog.
 */

/** Legacy floppy entry from ndfloppy floppies.json */
export interface LegacyFloppyEntry {
  Id: number;
  Name: string;
  Description: string;
  Reference: string;
  FilePath: string;
  Md5: string;
  Url: string | null;
  DirectoryContent: string | null;
  ProductId: number | null;
  CategoryId: number | null;
  PisheetUrl: string | null;
  ManualId: number | null;
  ArticleUrl: string | null;
  ProgramDescriptionId: number | null;
  Status: number;
  FloppyFiles: unknown[];
  Manual: unknown | null;
  Product: unknown | null;
  ProductNavigation: unknown | null;
  ProgramDescription: unknown | null;
}

/** Product match result from volume name parsing */
export interface ProductMatch {
  productId: string;
  version: string | null;
  diskNumber: number | null;
  language: string | null;
}

/** Duplicate check result */
export interface DuplicateCheckResult {
  isDuplicate: boolean;
  existingEntry?: CatalogEntry;
  isVariant?: boolean;
}

/** NDFS user entry */
export interface NdfsUser {
  name: string;
  pagesUsed: number;
}

/** NDFS file entry */
export interface NdfsFile {
  name: string;      // fullName like "DMAC-1915E:BPUN"
  type: string;      // "BPUN", "DATA", etc.
  pages: number;
  bytes: number;
  userName: string;
  dateCreated: number | null;     // Raw ND-100 packed 32-bit date (0 = unknown)
  lastDateRead: number | null;
  lastDateWritten: number | null;
  dateCreatedStr?: string | null;   // Human-readable "YYYY-MM-DD HH:MM:SS"
  lastDateReadStr?: string | null;
  lastDateWrittenStr?: string | null;
  bpunValid?: boolean | null;       // BPUN checksum validation (null = not a BPUN file)
}

/** Provenance information */
export interface Provenance {
  contributor: string;
  method?: string;
  dateImaged?: string | null;
  originalPath?: string | null;
  notes?: string | null;
}

/** Git storage info for in-repo images */
export interface GitStorageInfo {
  imagePath: string;
  /** Relative path to the .yaml metadata file */
  yamlPath: string;
  /** Photos specific to this individual disk (filename matches volume name or .img filename) */
  diskPhotos: string[];
  /** Photos of the set/group shared across all disks from the same import folder */
  setPhotos: string[];
  labelTranscription?: string | null;
  /** Text files from imaging process (Greaseweazle read logs, SCP conversion output, etc.) */
  imagingLogs: string[];
}

/** IA sync status */
export type IaSyncStatus = 'pending' | 'uploaded' | 'modified' | 'not-applicable';

/** Storage locations */
export interface StorageInfo {
  git?: GitStorageInfo | null;
  internetArchive: {
    itemId: string;
    files?: Record<string, string>;
    uploaded?: string | null;
    verified?: string | null;
    syncStatus?: IaSyncStatus;
  } | null;
}

/** Storage class for an entry */
export type StorageClass = 'floppy-in-git' | 'ia-only' | 'both';

/** Legacy references preserved from the old system */
export interface LegacyRefs {
  pisheetUrl?: string | null;
  articleUrl?: string | null;
  manualId?: number | null;
  programDescriptionId?: number | null;
}

/** A single catalog entry matching floppy.schema.json */
export interface CatalogEntry {
  schemaVersion: string;
  id: string;
  type: string;
  md5: string;
  volumeName: string | null;
  volumeNameRaw?: string | null;
  productId: string | null;
  version: string | null;
  /**
   * ND "system number" from the OS distribution floppy naming N-<system no>-I..IV
   * (documented in ND-10174-10-EN). Only the early SINTRAN III OS sets carry one;
   * null for every other floppy.
   */
  systemNumber: string | null;
  diskNumber: number | null;
  diskTotal: number | null;
  mediaRole: string | null;
  storageClass: StorageClass | null;
  imageSizeBytes: number | null;
  imageFormat: string;
  controller: string | null;
  totalPages: number | null;
  pageSize: number | null;
  /**
   * What the boot area of page 0 IS: 'bpun' when it holds a checksum-valid
   * BPUN block, 'binary' when something is there that is not one, 'none' when
   * it is empty or one repeated fill value.
   */
  bootFormat: string | null;
  /**
   * Which program the boot area carries, when that can be told from the image
   * itself: 'flomon' for the ND floppy monitor, recognised by its own command
   * names in page 0. BPUN is the container, FLO-MON is a program shipped in
   * one, so the two are recorded separately. See docs/boot-formats.md.
   */
  bootProgram?: string | null;
  cpuTarget: string[] | null;
  osRequirement: string | null;
  ndfs: { users: NdfsUser[]; files: NdfsFile[] } | null;
  /**
   * Which filesystem the image holds: 'ndfs', 'dos', 'tar', or 'none' for an
   * empty disk or a failed read. Detected from the bytes at import and
   * re-runnable afterwards; null means it has never been looked at.
   */
  filesystem?: 'ndfs' | 'dos' | 'tar' | 'backup' | 'winch' | 'none' | null;
  /**
   * Volume label of a non-NDFS filesystem - the FAT label on an MS-DOS disk.
   * These carry ND part numbers (30002EN1A00, 30022XX2N06), so the Matcher can
   * match on it exactly as it matches an NDFS volume name.
   */
  volumeLabel?: string | null;
  /**
   * Which backup set this image is one volume of, read from the volume header.
   *
   * A WINCH-TO-FLOPP backup spreads one ND directory over a set of floppies:
   * the header names the directory, gives this volume's number and how many
   * volumes the set has, and lists which pages of the original directory are
   * stored here. Recording it makes the set visible without opening every
   * image: which volumes are held, which are missing, and which images are
   * repeat reads of the same volume.
   */
  backupSet?: {
    /** the format the set belongs to */
    kind: 'winch' | 'backup';
    /** WINCH: the directory that was backed up (PACK-ONE). BACKUP-SYSTEM: the VOL1 volume id. */
    name: string;
    /** WINCH: the free text label (90-03-04). BACKUP-SYSTEM: the VOL1 owner. */
    label: string;
    /** WINCH only: this volume's number in the set, 1-based */
    volumeNumber?: number;
    /** WINCH only: how many volumes the set has */
    totalVolumes?: number;
    /** WINCH only: pages of the original directory stored on this volume */
    pageCount?: number;
    /** WINCH only: pages the header names; more than pageCount means an incomplete read */
    listedPages?: number;
    /** WINCH only: lowest and highest page number stored here */
    pageFirst?: number | null;
    pageLast?: number | null;
    /** BACKUP-SYSTEM: the run that wrote this volume */
    runDate?: string | null;
    system?: string | null;
    /** BACKUP-SYSTEM: files named by the labels, leftovers from an older backup excluded */
    fileCount?: number;
    staleCount?: number;
    firstFile?: string | null;
    lastFile?: string | null;
    /** BACKUP-SYSTEM: the last file has no EOF1, so it continues on the next volume */
    endsMidFile?: boolean;
    /** BACKUP-SYSTEM: fingerprint of the file names, so repeat reads can be told from distinct volumes */
    fileListHash?: string;
    /** size of the raw image */
    imageBytes: number;
  } | null;
  /**
   * Files named by the ANSI labels of a SINTRAN III BACKUP-SYSTEM volume. The
   * labels are the only listing this format has - there is no directory - so
   * they are recorded here to be listed, searched, and compared between images.
   */
  backupFiles?: {
    name: string;
    bytes: number;
    created: string | null;
    system: string | null;
    continued: boolean;
    stale: boolean;
  }[] | null;
  /**
   * What state the media is in, when that is not simply "readable".
   *
   * `damaged` means the image holds ND material - SINTRAN file names are
   * plainly present in the bytes - but the filesystem structures cannot be
   * read, so no file list can be produced. Such a floppy is still an ND floppy
   * and is recorded as one; this block says how far it can be trusted.
   */
  condition?: {
    status: 'damaged';
    /** which parser failed, and with what */
    parser: 'ndfs';
    parserError: string;
    /** distinct ND-style file names found in the raw bytes */
    ndNamesFound: number;
    /** a few of them, as evidence */
    ndNameSamples: string[];
    /**
     * Set when the file list was recovered by reconstructing the master block
     * pointers from what healthy floppies of the same geometry use. The list in
     * `ndfs` then exists, but it was not read from an intact filesystem: it is
     * only as good as `namesConfirmedInBytes` says, which counts how many of
     * the recovered names occur in the image's own bytes.
     */
    recovery?: {
      status: 'recovered';
      /** page numbers the reconstruction used */
      layout: { object: number; user: number; bit: number };
      filesRecovered: number;
      namesConfirmedInBytes: number;
      /** namesConfirmedInBytes / filesRecovered, 0..1 */
      confirmRatio: number;
      /**
       * Which evidence carried it: the image's own bytes, or another read of the
       * same physical floppy listing the same files. A read that lost part of
       * its text cannot confirm much on its own, and two reads that failed
       * differently agreeing is evidence in its own right.
       */
      acceptedBy?: 'own-bytes' | 'sibling-listing';
      /** names also present in that sibling listing */
      corroboratedBySibling?: number;
    } | null;
  } | null;
  /**
   * Directory tree of an MS-DOS floppy, root and subdirectories, recorded so
   * the catalog can list and search it without opening the image.
   */
  dosFiles?: { path: string; bytes: number; modified: string | null; directory: boolean }[] | null;
  directoryContentRaw?: string | null;
  /** References to related documentation */
  docs: {
    /** PI (Product Information) sheet - ND doc number */
    piDocId: string | null;
    /** PD (Program Description) sheet - ND doc number */
    pdDocId: string | null;
    /** Related manual/documentation ND doc numbers */
    relatedDocIds: string[];
    /** URLs to external documentation (ndwiki, etc.) */
    externalUrls: Array<{ url: string; title: string }>;
  } | null;
  provenance: Provenance | null;
  storage: StorageInfo | null;
  variants: null;
  fluxPreservation: null;
  legacyId: number | null;
  legacyRefs?: LegacyRefs | null;
  importedAt: string | null;
  tags: string[] | null;
}

/** The full catalog structure */
export interface Catalog {
  entries: CatalogEntry[];
}

/** Product definition */
export interface Product {
  id: string;
  name: string;
  description?: string | null;
  siblingId?: string | null;
  categories?: string[];
  platform?: string[];  // '100' | '500' | 'PC'
  /**
   * ND documents describing this product, by document id (the file name in
   * docs/nd/<collection>/<id>.md, which is the ND document number).
   * One document can cover several products - e.g. ND-10174-10-EN covers
   * ND-10174, ND-10575 and ND-10576 - so it is stored once and referenced.
   */
  docs?: ProductDocs;
}

/** ND documentation attached to a product */
export interface ProductDocs {
  /** Product Information sheets -> docs/nd/product-info/<id>.md */
  productInfo?: string[];
  /** Program / Installation Descriptions -> docs/nd/installation-description/<id>.md */
  installationDescription?: string[];
}

/** Collection definition */
export interface Collection {
  name: string;
  description: string;
  items: Array<{
    productId?: string;
    version?: string;
    path?: string;
    role: string;
  }>;
}

/** Search index entry */
export interface IndexEntry {
  id: string;
  volumeName: string | null;
  /** the name the imaging gave the disk, e.g. ND-disk-00283 */
  imageName: string | null;
  /** FAT label of an MS-DOS disk, which on these carries an ND part number */
  volumeLabel: string | null;
  productId: string | null;
  tags: string[] | null;
  directoryContentRaw: string | null;
}

/** Dependency check result */
export interface DepCheckResult {
  name: string;
  found: boolean;
  version: string | null;
}
