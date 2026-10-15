# Contributing to the Norsk Data Software Archive

Thank you for helping preserve Norsk Data software history.

## How to Contribute Floppy Images

### Option 1: Open a GitHub Issue (recommended for new contributors)

1. **Open a GitHub Issue** with:
   - Description of the media (what software, what version, what machine)
   - Provenance: where you obtained it, how it was imaged (e.g., Kryoflux, Catweasel, USB floppy drive)
   - Link to the file (hosted temporarily on Google Drive, Dropbox, personal server, etc.)
   - Photos of the floppy labels (if available)
   - Any additional context (known condition, history)

2. **Maintainer reviews** the submission:
   - Verifies provenance
   - Checks for duplicates (MD5 + SHA256)
   - Runs the import tool to extract NDFS metadata and assign an ID

3. **Import and catalog**:
   - The maintainer imports the image using `make import`
   - The tool parses the NDFS filesystem, matches products, compresses and stores the image
   - A commit is created with the catalog update
   - The image is permanently preserved in the repository and (eventually) on Internet Archive

### Option 2: Direct PR (for trusted contributors)

If you have contributor access:

```bash
# Clone and setup
git clone https://github.com/RetroCoreLabs/norskdata-software-archive.git
cd norskdata-software-archive

# Start the web UI (primary import + product mapping) at http://localhost:3000
make import

# Or use the interactive console wizard instead:
make import-cli

# The console wizard will prompt you for:
#   - Path to image file or folder
#   - Your name (contributor)
#   - Source description
#   - Whether to commit and push
```

For batch imports without prompts:

```bash
# Import a folder of images recursively
make import-folder SRC=/path/to/floppies CONTRIBUTOR="Your Name" SOURCE="description" RECURSIVE=1

# Import a single file
make import-file FILE=/path/to/disk.img CONTRIBUTOR="Your Name" SOURCE="description"
```

## What We Accept

- **Floppy disk images** (.img, raw sector dumps) -- stored compressed in git
- **Hard disk images** (SMD, Winchester, SCSI) -- metadata in git, binary on Internet Archive
- **ROM dumps** (.bin, .rom)
- **Tape images** (.tap, .raw)
- **Firmware binaries**
- **Raw flux captures** (.scp, .hfe) -- the gold standard for preservation
- **Label photos** (.JPG) -- stored alongside the image
- **Label transcriptions** (labels.txt) -- text transcription of floppy labels

## What the Import Tool Does Automatically

When you run `make import`, the tool:

1. Reads the image file and computes MD5 + SHA256 checksums
2. Parses the NDFS filesystem using [norskdata-ndfs](https://github.com/RetroCoreLabs/norskdata-ndfs):
   - Extracts volume name, boot format, user listings, file listings
3. Matches the volume name against known ND product number patterns
4. Checks for duplicates against the existing catalog (1010+ entries)
5. Compresses the image with gzip and stores it in `images/`
6. Copies any label photos and transcriptions found in the same folder
7. Adds the entry to `catalog/floppies.json` with all parsed metadata
8. Optionally rebuilds the GitHub Pages site and creates a git commit

## Duplicate Policy

- **Exact MD5+SHA256 match**: Rejected as duplicate (skipped)
- **Same volume name, different checksum**: Flagged as a potential variant. You will be asked whether it is a different imaging of the same disk (variant) or a different disk entirely (new entry).
- **Raw flux of an already-cataloged disk**: Stored as a rendition alongside the decoded image.

Note: Some volume names like `PACK-ONE` appear on many different disks. The tool uses content-derived IDs (based on checksums), not volume names, to avoid collisions.

## Folder Organization Tips

When submitting a collection, organize your images by product or source:

```
my-collection/
  ND-10022T/
    ND-10022T.img         # The floppy image
    DSC_0123.JPG          # Photo of the label
  NOTIS-WP-M07/
    10079M07-NO-01S.img
    10079M07-NO-02S.img   # Multi-disk set
    10079M07-NO-03S.img
    labels.txt            # Transcribed label text
```

The import tool will:
- Scan each subfolder for `.img` files
- Pick up `.JPG` files as label photos
- Pick up `labels.txt` as label transcriptions
- Apply the contributor name and source description to all images in the batch

## Metadata Quality

Please provide as much provenance information as possible:

- Who imaged the disk
- What hardware was used (drive model, interface -- Kryoflux, Catweasel, USB)
- When it was imaged
- Physical condition of the original media
- Any labels or markings on the disk (photos preferred)

## Code of Conduct

Be respectful. This is a historical preservation effort. All contributions are valued.
