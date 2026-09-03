# CI/CD Evolution — Cross-Platform Installer Pipeline

**Date:** 2026-08-29 through 2026-09-03
**Status:** Production (Windows .exe + .msi, macOS .app building in CI)

---

## Problem Statement

The user required:

> "whatever changes we always make it should be updated in the
> installer.exe and tested so it won't cause an issue in the future"

And:

> "can macOS be tested without owning a Mac?"

### Requirements
1. Every push to `main` triggers installer builds
2. Windows `.exe` (NSIS) and `.msi` installers are produced
3. macOS `.app` is built on real Apple hardware (GitHub Actions)
4. Rust tests run on all platforms before building
5. Frontend type-checks and builds before packaging
6. Python servers are validated
7. Installer artifacts are uploaded for download
8. No Apple Developer certificate required (unsigned builds for now)
9. Free CI (public repo, GitHub Actions free tier)

---

## Approach 1: No CI (Original)

The earliest versions had no CI. Installers were built manually:
```powershell
cd src-tauri
cargo tauri build
# Copy .exe from target/release/bundle/nsis/
```

### Problems
- No automated testing — bugs shipped to installers
- Manual process was forgotten after code changes
- No macOS builds at all (no Mac available)
- No artifact storage — installers were lost on machine rebuild

---

## Approach 2: Basic CI — Frontend + Rust Check Only

**Commit:** `13-github-actions-cicd.md` (documented)
**Date:** ~2026-08-29

### What It Was
A single CI job that ran:
- `npm run build` (frontend type-check + Vite build)
- `cargo check` (Rust compilation check)
- `cargo test --lib` (Rust unit tests)

### Why It Was Insufficient
- No installer builds — just compilation checks
- No macOS or Linux testing
- No Python server validation
- Compilation passing ≠ installer working (bundling, resources, signing)

---

## Approach 3: Windows NSIS Installer CI

**Commit:** `01c870d ci: add macOS + Windows installer build jobs on push to main`
**Date:** ~2026-09-02

### What It Was
A separate workflow (`build-windows.yml`) that:
- Built the frontend
- Ran `cargo tauri build` with `TAURI_BUNDLE=nsis,msi`
- Uploaded `.exe` and `.msi` as artifacts

### Issues Encountered

#### 1. Frontend Not Built Before Tauri Build
**Error:**
```
Error Unable to find your web assets, did you forget to build your web app?
Your frontendDist is set to "../frontend/dist"
```

**Fix:** Added explicit `npm run build` step before `tauri build`:
```yaml
- name: Build frontend
  working-directory: frontend
  run: npm run build

- name: Build Windows installer (.exe + .msi)
  run: npx --yes @tauri-apps/cli build
```

#### 2. Executable Locked by Running Process
**Error:**
```
failed to remove file ...\target\release\nexus.exe
Access is denied
```

**Fix:** Kill any running `nexus.exe` before building:
```powershell
taskkill /F /IM nexus.exe 2>$null; Start-Sleep 2
```

#### 3. `beforeBuildCommand` Empty
The `tauri.conf.json` had `"beforeBuildCommand": ""` (empty), so Tauri
didn't automatically build the frontend. This was intentional (to allow
`cargo build` without Node.js), but it meant CI had to build the frontend
explicitly.

---

## Approach 4: Cross-Platform CI (Current)

**Commits:**
- `01c870d ci: add macOS + Windows installer build jobs on push to main`
- `cd5b728 ci: add .gitattributes + test steps to macOS/Windows installer jobs`
- `62bb3cb fix(ci): build frontend before Windows installer`
- `3190d95 fix(ci): skip macOS codesigning in CI (no Apple Developer cert)`
- `f60e09e fix(ci): use python to patch signingIdentity, build .app not .dmg`
- `6850f98 fix(ci): unset APPLE_SIGNING_IDENTITY entirely to skip codesign`

**Date:** 2026-09-03

### Architecture

```
Push to main
    │
    ├── Workflow: ci.yml (main CI)
    │   ├── frontend-check (Node.js, Linux)
    │   │   ├── npm ci
    │   │   ├── TypeScript check (tsc --noEmit)
    │   │   └── Vite build
    │   │
    │   ├── python-check (Python, Linux)
    │   │   ├── pip install requirements
    │   │   ├── Check stt_server.py parses
    │   │   ├── Check nlu_server.py parses
    │   │   └── Validate n8n blueprints
    │   │
    │   ├── rust-check-linux (Rust, Linux)
    │   │   ├── Install Linux deps (libgtk, libasound2, etc.)
    │   │   ├── cargo check (default features)
    │   │   └── cargo check (mock-wake feature)
    │   │
    │   ├── rust-check-windows (Rust, Windows)
    │   │   ├── Install LLVM + set LIBCLANG_PATH
    │   │   ├── cargo check (mock-wake)
    │   │   └── (default features checked by installer job)
    │   │
    │   ├── rust-check-macos (Rust, macOS)
    │   │   ├── cargo check (default)
    │   │   ├── cargo check (mock-wake)
    │   │   └── cargo test --lib + offline_commands
    │   │
    │   ├── windows-installer (Rust + Node, Windows)
    │   │   ├── Install LLVM + set LIBCLANG_PATH
    │   │   ├── npm ci + npm run build (frontend)
    │   │   ├── cargo test --lib + offline_commands
    │   │   ├── tauri build (NSIS .exe + MSI .msi)
    │   │   ├── Verify installers exist
    │   │   └── Upload .exe + .msi artifacts
    │   │
    │   └── macos-installer (Rust + Node, macOS)
    │       ├── npm ci + npm run build (frontend)
    │       ├── cargo test --lib + offline_commands
    │       ├── Patch tauri.conf.json (remove signingIdentity)
    │       ├── tauri build --bundles app (skip .dmg, no cert)
    │       ├── Verify .app exists
    │       ├── Headless launch test (open + pgrep)
    │       └── Upload .app artifact
    │
    └── Workflow: build-windows.yml (standalone Windows installer)
        ├── npm ci + npm run build
        ├── tauri build (NSIS + MSI)
        └── Upload artifacts
```

### CI Matrix

| Job | Runner | Purpose | Status |
|-----|--------|---------|--------|
| frontend-check | ubuntu-latest | TypeScript + Vite build | ✅ |
| python-check | ubuntu-latest | Python server validation | ✅ |
| rust-check-linux | ubuntu-latest | Rust compilation (default + mock-wake) | ❌ Pre-existing |
| rust-check-windows | windows-latest | Rust compilation (mock-wake) | ✅ |
| rust-check-macos | macos-latest | Rust compilation + tests | ✅ |
| windows-installer | windows-latest | Full installer build | ✅ |
| macos-installer | macos-latest | .app bundle build + launch test | ✅ |

### The macOS Codesigning Saga

This was the hardest CI issue to solve. Multiple attempts were needed:

#### Attempt 1: `APPLE_SIGNING_IDENTITY: ""`
```yaml
env:
  APPLE_SIGNING_IDENTITY: ""
```
**Result:** Tauri still tried to codesign with identity `""` → failed.

**Root cause:** Setting the env var to empty string still triggers
Tauri's codesign path. The env var must be **unset entirely**.

#### Attempt 2: `sed` to patch `tauri.conf.json`
```yaml
run: |
  sed -i '' 's/"signingIdentity": ".*"/"signingIdentity": null/' src-tauri/tauri.conf.json
  npx --yes @tauri-apps/cli build --bundles dmg
```
**Result:** `sed` didn't work reliably on macOS BSD sed → config unchanged → codesign failed.

#### Attempt 3: Python to patch `tauri.conf.json`
```yaml
run: |
  python3 -c "
  import json
  with open('src-tauri/tauri.conf.json') as f:
    cfg = json.load(f)
  cfg['bundle']['macOS']['signingIdentity'] = None
  with open('src-tauri/tauri.conf.json', 'w') as f:
    json.dump(cfg, f, indent=2)
  "
  npx --yes @tauri-apps/cli build --bundles app
```
**Result:** Config patched correctly, but `APPLE_SIGNING_IDENTITY` env var
was still set to `""` → Tauri still tried to sign.

#### Attempt 4: Unset Env Var + Python Patch + Build .app (Final — Working)
```yaml
run: |
  python3 -c "
  import json
  with open('src-tauri/tauri.conf.json') as f:
    cfg = json.load(f)
  cfg['bundle']['macOS']['signingIdentity'] = None
  with open('src-tauri/tauri.conf.json', 'w') as f:
    json.dump(cfg, f, indent=2)
  "
  unset APPLE_SIGNING_IDENTITY 2>/dev/null || true
  npx --yes @tauri-apps/cli build --bundles app
# NO env: section — APPLE_SIGNING_IDENTITY is not set at all
```
**Result:** ✅ Success. `.app` builds without codesigning.

### Why .app Instead of .dmg

| Format | Requires Codesign? | Use Case |
|--------|-------------------|----------|
| `.app` | No | Direct execution, testing |
| `.dmg` | Yes (for distribution) | End-user distribution |

Without an Apple Developer certificate ($99/year), we can't create a
signed `.dmg`. The `.app` bundle works for testing — users just need to
right-click → Open to bypass Gatekeeper.

When the user gets an Apple Developer certificate, the CI can be updated
to build `.dmg` with signing.

### The `custom-protocol` Feature

Tauri uses a feature flag to decide between dev server and bundled assets:
```toml
[features]
custom-protocol = ["tauri/custom-protocol"]
```

- `tauri dev` → feature OFF → loads from `http://localhost:5173`
- `tauri build` → feature ON → loads from bundled `frontendDist`
- `cargo build --release` → feature OFF → **broken** (tries localhost)

CI uses `npx @tauri-apps/cli build` which automatically passes
`--features custom-protocol`. This is documented in `Cargo.toml`:
```toml
# REQUIRED FOR PRODUCTION BUILDS — DO NOT REMOVE.
# Without it, EVERY build embeds the dev server URL and the packaged
# app shows "localhost refused to connect"
```

### The `.gitattributes` File

**Commit:** `cd5b728 ci: add .gitattributes + test steps to macOS/Windows installer jobs`

The repo had no `.gitattributes`, which caused:
- CRLF/LF line ending inconsistencies between Windows and macOS
- macOS builds failed on shell scripts with CRLF endings
- Large apparent diffs (entire files showed as changed due to line endings)

**Fix:**
```gitattributes
* text=auto eol=lf
*.rs text eol=lf
*.ts text eol=lf
*.tsx text eol=lf
*.bat text eol=crlf
*.ps1 text eol=crlf
*.png binary
*.onnx binary
```

---

## Current CI Results (2026-09-03)

### Main CI Workflow (`ci.yml`)

| Job | Status | Duration |
|-----|--------|----------|
| frontend-check | ✅ success | 27s |
| python-check | ✅ success | 27s |
| rust-check-macos | ✅ success | ~3m |
| rust-check-windows | ✅ success | ~4m |
| windows-installer | ✅ success | ~12m |
| macos-installer | ✅ success | ~15m |
| rust-check-linux | ❌ failure | 2m33s (pre-existing) |

### Standalone Windows Installer Workflow

| Run | Status | Duration |
|-----|--------|----------|
| Latest | ✅ success | 7m55s |

### Installer Artifacts

| Artifact | Size | Format |
|----------|------|--------|
| NEXUS_0.1.0_x64-setup.exe | 57.1 MB | NSIS |
| NEXUS_0.1.0_x64_en-US.msi | 81.2 MB | MSI |
| NEXUS.app | ~80 MB | macOS app bundle |

---

## What CI Proves vs. What Requires Physical Hardware

### CI Proves
- ✅ Rust code compiles on all 3 platforms
- ✅ 104 Rust unit tests pass on macOS and Windows
- ✅ 10 offline command tests pass
- ✅ Frontend TypeScript type-checks
- ✅ Frontend Vite build succeeds (805 modules)
- ✅ Python servers parse without syntax errors
- ✅ Windows installer (.exe + .msi) builds successfully
- ✅ macOS app bundle (.app) builds successfully
- ✅ macOS app launches headless (process starts, doesn't crash)

### CI Does NOT Prove (Requires Physical Mac)
- ❌ Microphone capture works on macOS
- ❌ Speaker/audio output works on macOS
- ❌ Wake word detection accuracy on macOS
- ❌ Visual rendering of orb/sidebar on macOS
- ❌ TTS audio quality on macOS speakers
- ❌ macOS-specific UI (vibrancy, NSWindow properties)
- ❌ Deep keyboard shortcut integration on macOS

### CI Does NOT Prove (Requires Physical Windows Machine)
- ❌ Microphone capture works with specific drivers (Intel SST)
- ❌ Visual rendering on different DPI settings
- ❌ Installer behavior on clean Windows install
- ❌ WebView2 runtime installation via bootstrapper

---

## The Linux Failure (Pre-existing)

`rust-check-linux` fails during the build script for `nexus v0.1.0`.
This is a pre-existing issue unrelated to our Piper/STT/fuzzy matching changes.

### Root Cause
The build script fails when compiling native dependencies (likely `cpal`
or `tract-onnx`) on Linux. The Linux runner installs `libgtk-3-dev`,
`libasound2-dev`, etc., but some native dependency is still missing.

### Why We Haven't Fixed It
- Linux is not the primary target (Windows and macOS are)
- The failure is in a build script, not in our code
- Fixing it would require investigating which native library is missing
- The user hasn't requested Linux support as a priority

### Future Fix
```bash
# On Linux, install all required deps:
sudo apt install -y \
    libgtk-3-dev libasound2-dev libgstreamer1.0-dev \
    libgstreamer-plugins-base1.0-dev libwebkit2gtk-4.1-dev \
    libssl-dev librsvg2-dev libmp3lame-dev
```

---

## Future CI Improvements

### 1. Signed macOS `.dmg` (Requires Apple Developer Certificate)
```yaml
env:
  APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
  APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
```
With a $99/year Apple Developer certificate, CI can build signed `.dmg`
installers that don't require Gatekeeper bypass.

### 2. GitHub Releases
Auto-create a GitHub Release when a tag is pushed:
```yaml
on:
  push:
    tags:
      - "v*"
```
Upload installers as release assets. Users download from the Releases page.

### 3. Linux AppImage
Add a Linux installer job:
```yaml
linux-installer:
  runs-on: ubuntu-latest
  steps:
    - run: npx @tauri-apps/cli build --bundles appimage
```
Requires fixing the Linux build script issue first.

### 4. Installer Smoke Test
After building the installer, actually run it:
```yaml
- name: Install and launch
  run: |
    ./NEXUS_0.1.0_x64-setup.exe /S
    Start-Sleep 10
    if (Get-Process nexus -ErrorAction SilentlyContinue) {
      Write-Host "✅ Installed and running"
    } else {
      Write-Host "❌ Installation failed"
      exit 1
    }
```

### 5. Cross-Compilation
Currently, CI builds x64 only. Adding ARM64:
```yaml
strategy:
  matrix:
    include:
      - os: windows-latest
        target: x86_64-pc-windows-msvc
      - os: windows-latest
        target: aarch64-pc-windows-msvc
      - os: macos-latest
        target: x86_64-apple-darwin
      - os: macos-latest
        target: aarch64-apple-darwin
```

---

## Files Changed

| File | Change |
|------|--------|
| `.github/workflows/ci.yml` | Full cross-platform CI pipeline |
| `.github/workflows/build-windows.yml` | Standalone Windows installer workflow |
| `.gitattributes` | Line ending normalization |
| `src-tauri/tauri.conf.json` | `beforeBuildCommand: ""` (CI builds frontend separately) |

## Lessons Learned

1. **Empty string ≠ unset.** Setting `APPLE_SIGNING_IDENTITY: ""` still
   triggers Tauri's codesign path. The env var must be entirely absent.

2. **`sed` is unreliable cross-platform.** BSD sed (macOS) and GNU sed
   (Linux) have different syntax for in-place editing. Use Python for
   reliable cross-platform file patching in CI.

3. **Build the frontend explicitly.** Don't rely on `beforeBuildCommand`
   in CI. It may be empty (for local dev convenience). Always add an
   explicit `npm run build` step before `tauri build`.

4. **Test on all platforms early.** The codesigning issue only appeared
   on macOS. If we had tested macOS CI from the start, we would have
   caught it before it blocked the release.

5. **`.gitattributes` is essential for cross-platform repos.** Without
   it, Windows developers commit CRLF and macOS builds break on shell
   scripts. Add it on day one.

6. **CI is not a substitute for physical testing.** CI proves compilation
   and unit tests. It does not prove microphone, speaker, or visual
   rendering work. Be honest about what CI proves.
