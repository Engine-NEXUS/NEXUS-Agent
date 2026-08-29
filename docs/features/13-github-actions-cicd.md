# 13 — GitHub Actions CI/CD

**Branch:** prem22k
**Status:** Implemented
**Date:** 2026-08-29

---

## Problem

Building the Windows NSIS installer required manual execution of
`build.ps1`. There was no automated CI/CD pipeline to produce installers
on every push.

## Implementation (`.github/workflows/build-windows.yml`)

### Trigger
```yaml
on:
  push:
    branches: [ prem22k, main ]
  workflow_dispatch:
```

### Job
```yaml
jobs:
  build-windows:
    name: Build Windows NSIS Installer (.exe)
    runs-on: windows-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Cache Rust Cargo Dependencies
        uses: swatinem/rust-cache@v2
        with:
          workspaces: "./src-tauri -> target"

      - name: Install Frontend Dependencies
        working-directory: ./frontend
        run: npm install

      - name: Build Frontend Bundle
        working-directory: ./frontend
        run: npm run build

      - name: Build Windows Executable (.exe) Installer via Tauri
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          projectPath: './src-tauri'
          args: '--bundles nsis --features custom-protocol'

      - name: Upload Windows Setup Executable (.exe) Artifact
        uses: actions/upload-artifact@v4
        with:
          name: NEXUS-Windows-Installer-exe
          path: src-tauri/target/release/bundle/nsis/*.exe
```

### Key decisions

| Decision | Reason |
|---|---|
| `--bundles nsis` | Skip WiX download hang — NSIS is faster |
| `--features custom-protocol` | Required for release builds (loads embedded assets, not Vite dev URL) |
| `swatinem/rust-cache@v2` | Cache Cargo deps for fast subsequent builds |
| `working-directory: ./frontend` | Windows PowerShell compatibility |

### NSIS Installer auto-launch (`src-tauri/installer/nexus-installer.nsi`)

Updated NSIS finish page to execute `$INSTDIR\nexus.exe --setup` automatically
upon installation completion — the setup wizard launches on first install.

## Output

- `NEXUS_0.1.0_x64-setup.exe` — Windows installer artifact
- Uploaded to GitHub Actions artifacts for download

## Files Changed

- `.github/workflows/build-windows.yml` — New file (50 lines)
- `src-tauri/installer/nexus-installer.nsi` — Auto-launch setup wizard
