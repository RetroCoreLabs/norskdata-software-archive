# Installation Guide

## Prerequisites

### Required (all platforms)

| Tool | Version | Check |
|------|---------|-------|
| Node.js | 20+ | `node --version` |
| npm | 10+ | `npm --version` |
| git | 2.30+ | `git --version` |

### Required for Internet Archive Operations

| Tool | Version | Check |
|------|---------|-------|
| Python | 3.8+ | `python3 --version` |
| internetarchive | latest | `ia --version` |

Install the IA CLI:

```bash
pip install internetarchive
ia configure
```

Credentials are stored in `~/.config/internetarchive/`.

### Offline Mode

The tools work fully offline for:

- Catalog browsing and editing
- Metadata import (without IA upload)
- NDFS parsing of local images
- Search across cached catalog

IA features (upload, download, verify) require internet access. The tools detect connectivity and disable IA features gracefully.

## Setup

```bash
# Clone the repository
git clone https://github.com/RetroCoreLabs/norskdata-software-archive.git
cd norskdata-software-archive

# Verify prerequisites
make check-deps

# Install dependencies and build tools
make setup
```

## Validate Prerequisites

Run `make check-deps` to check that all required tools are installed. The output will show what is available and what is missing, with platform-specific install instructions.

```bash
make check-deps
```

Example output:

```
[OK] node v22.0.0
[OK] npm 10.5.0
[OK] git 2.43.0
[OK] python3 3.12.0
[OK] ia 4.1.0
```

## Platform Notes

### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install nodejs npm git python3 python3-pip
pip install internetarchive
```

### macOS

```bash
brew install node git python3
pip3 install internetarchive
```

### Windows (WSL recommended)

Use Windows Subsystem for Linux (WSL) with Ubuntu, then follow the Linux instructions.
