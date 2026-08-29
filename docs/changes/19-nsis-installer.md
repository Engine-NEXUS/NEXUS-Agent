# 19 — White-Themed NSIS Installer

> **Commit:** `6663e57` — `feat: white-themed NSIS installer + setup wizard (orb untouched)`
> **Date:** 2026-08-20
> **PR:** #16 (merged as `ed1c4b8`)
> **Status:** Complete — installer builds successfully (40.1 MB)

---

## What Changed

Built a custom white-themed NSIS installer for NEXUS with branded images, custom colors, and no desktop shortcut option. The orb was completely untouched.

---

## Custom NSIS Template

### File: `src-tauri/installer/nexus-installer.nsi`

The default Tauri NSIS template was downloaded from:
`https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi`

Then customized with:

### White Background
```nsis
Function OnGuiInit
  ; Set all controls to white background with black text
  SetCtlColors $HWNDPARENT "" "FFFFFF"
  SetCtlColors $HWNDPARENT 000000 FFFFFF
  ; ... iterate through all child controls
FunctionEnd
```

The `MUI_PAGE_CUSTOMFUNCTION_GUIINIT` hook calls `OnGuiInit` which sets `SetCtlColors` for every control in the installer dialog to white background (`FFFFFF`) with black text (`000000`).

### Welcome Page Text
```nsis
!define MUI_WELCOMEPAGE_TEXT "NEXUS is a cross-platform, Siri-like floating desktop assistant.$\r$\n$\r$\nClick Next to continue with the installation."
```

### Desktop Shortcut Removed (later change in `03a34ad`)
The `MUI_FINISHPAGE_SHOWREADME` define (which repurposed the "Show Readme" checkbox as "Create Desktop Shortcut") was removed. The `CreateOrUpdateDesktopShortcut` function was also removed. The installer now creates only a Start Menu shortcut.

See [22-installer-desktop-shortcut-removal.md](./22-installer-desktop-shortcut-removal.md) for details.

---

## Custom Installer Images

### Sidebar Image (`sidebar.bmp`)
- **Size:** 220x500 pixels (larger than standard 164x314 for a bigger installer window)
- **Format:** 24-bit BMP
- **Content:**
  - White background with subtle gradient
  - Gradient orb (blue → purple) with glow effect in center-top
  - Inner highlight on orb for 3D effect
  - "NEXUS" text in gradient (blue → purple) below the orb
  - "AI Desktop Assistant" subtitle in gray
  - Divider line
  - Feature list with blue dots:
    - Voice-controlled
    - Local & private
    - Cross-platform
  - "Version 0.1.0" at the bottom in light gray
- **Generated with:** PowerShell + System.Drawing.Bitmap

### Header Image (`header.bmp`)
- **Size:** 180x68 pixels (larger than standard 150x57)
- **Format:** 24-bit BMP
- **Content:**
  - White background
  - "NEXUS" text in gradient (blue → purple)
  - Gradient bar at the bottom (blue → purple)
- **Generated with:** PowerShell + System.Drawing.Bitmap

### Image Generation Script
```powershell
Add-Type -AssemblyName System.Drawing
$sideBmp = New-Object System.Drawing.Bitmap(220, 500)
# ... draw gradient orb, text, features
$sideBmp.Save("sidebar.bmp", [System.Drawing.Imaging.ImageFormat]::Bmp)
```

---

## Tauri Configuration

### `tauri.conf.json` — NSIS section
```json
{
  "bundle": {
    "windows": {
      "nsis": {
        "template": "installer/nexus-installer.nsi",
        "installerIcon": "icons/installer.ico",
        "headerImage": "installer/header.bmp",
        "sidebarImage": "installer/sidebar.bmp",
        "compression": "lzma",
        "installMode": "currentUser",
        "languages": ["English"],
        "displayLanguageSelector": false
      }
    }
  }
}
```

### Configuration Fields
| Field | Value | Description |
|-------|-------|-------------|
| `template` | `installer/nexus-installer.nsi` | Custom NSIS template |
| `installerIcon` | `icons/installer.ico` | Icon for the installer .exe |
| `headerImage` | `installer/header.bmp` | 180x68 header bitmap |
| `sidebarImage` | `installer/sidebar.bmp` | 220x500 sidebar bitmap |
| `compression` | `lzma` | Best compression ratio |
| `installMode` | `currentUser` | No admin required |
| `languages` | `["English"]` | English only |

---

## Build Output

```
NEXUS_0.1.0_x64-setup.exe
Size: 40.1 MB
Location: src-tauri/target/release/bundle/nsis/
```

### Installer Pages
1. **Welcome** — sidebar image with NEXUS branding, welcome text
2. **License** — (if license file configured)
3. **Install Options** — Start Menu folder selection
4. **Installation** — progress bar with file extraction
5. **Finish** — "Run NEXUS" option (no desktop shortcut checkbox)

### Uninstaller
- Removes all installed files
- Cleans up registry entries
- Removes Start Menu shortcuts
- Removes any existing desktop shortcuts (cleanup from previous versions)
- Option to delete app data

---

## File Structure
```
src-tauri/
├── tauri.conf.json
├── installer/
│   ├── nexus-installer.nsi    # Custom NSIS template (~1000 lines)
│   ├── header.bmp             # 180x68 header image
│   └── sidebar.bmp            # 220x500 sidebar image
└── icons/
    └── installer.ico          # Installer executable icon
```

---

## Test Results

| Test | Result |
|------|--------|
| NSIS build | Pass (40.1 MB) |
| Installer runs | Pass |
| White background | Pass |
| Custom images show | Pass |
| No desktop shortcut | Pass |
| Start Menu shortcut | Pass |
| Uninstaller works | Pass |

---

## NSIS Customization Research

The following research was performed before building the installer:

### Tauri v2 NSIS Config Options
- `template` — path to custom .nsi template (Handlebars syntax)
- `headerImage` — 150x57 BMP (we used 180x68 for bigger window)
- `sidebarImage` — 164x314 BMP (we used 220x500 for bigger window)
- `installerIcon` — .ico file for installer executable
- `installMode` — `currentUser`, `perMachine`, or `both`
- `compression` — `lzma` (best), `zlib`, `bzip2`, or `none`
- `languages` — array of NSIS language names
- `installerHooks` — path to .nsh file with custom hooks

### Handlebars Variables in Template
```nsis
!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define INSTALLMODE "{{install_mode}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
```

### Key URLs
- Official docs: https://v2.tauri.app/distribute/windows-installer/
- Default template: https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
- Config schema: https://schema.tauri.app/config/2
