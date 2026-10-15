# Backup and Disaster Recovery

## Backup Strategy

### Primary: Internet Archive

> **Status 15-OCT-2026: not started.** Nothing has been uploaded to Internet
> Archive. Every image lives in git under `images/{md5}/`. The `ia-sync`,
> `ia-verify` and `ia-upload` commands are stubs that print a message and do
> nothing, `catalog/SHA256SUMS.txt` is empty, and the IA Verify GitHub Action
> runs only when started by hand. Planning of the IA layout and sync starts
> when the collection is complete. The text below describes the intended
> design, not the current state.

All binary artifacts (floppy images, HDD images, ROMs, tapes, firmware) are stored on the [Internet Archive](https://archive.org/).

- IA mirrors data across multiple data centers
- Items are permanent and versioned
- Each item has stable, direct download URLs
- IA auto-generates checksums per item

### Verification

Integrity is verified automatically:

- **Weekly cron**: GitHub Actions runs `make ia-verify` every Sunday at 00:00 UTC
- **Manual check**: Run `make ia-verify` locally at any time
- Verification compares SHA256 checksums in `catalog/SHA256SUMS.txt` against IA-hosted files
- Failures are reported in the GitHub Actions logs

### Cold Backup

A complete local mirror of all original artifacts is maintained on a local NAS/drive.

- Location is documented outside of this repository (physical security)
- Updated after each bulk import/upload cycle
- Serves as a last-resort recovery source

### Git Repository

All metadata is fully version-controlled in Git:

- Complete history of every catalog change
- GitHub is the primary host; local clones provide redundancy
- Catalog JSON and text files are small enough that any clone is a full backup of all metadata
- No binary artifacts are stored in Git

## Recovery Procedures

### If Internet Archive is temporarily unavailable

- Use local cache (`~/.norskdata/cache/`) for recently accessed files
- Use cold backup for complete recovery
- Catalog metadata remains available in Git

### If GitHub is unavailable

- Any local clone contains the full metadata history
- Internet Archive items remain accessible independently

### If cold backup is lost

- All artifacts can be re-downloaded from Internet Archive
- Run `make ia-sync` to rebuild local copies
