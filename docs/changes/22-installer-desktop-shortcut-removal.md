# 22 — Installer Desktop Shortcut Removal

> **Commit:** `03a34ad` — `feat: right-side response sidebar — shows only for server responses`
> **Date:** 2026-08-22
> **PR:** #16 (merged as `ed1c4b8`)
> **Status:** Complete

---

## What Changed

The "Create Desktop Shortcut" checkbox was removed from the NSIS installer finish page. NEXUS now creates only a Start Menu shortcut during installation.

---

## What Was Removed

### 1. MUI_FINISHPAGE_SHOWREADME Defines (line 435)
```nsis
; REMOVED:
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
```

The NSIS Modern UI repurposes the "Show Readme" checkbox on the finish page as a "Create Desktop Shortcut" checkbox. This is a common Tauri installer pattern. Removing these three defines removes the checkbox entirely.

### 2. Passive/Silent Mode Desktop Shortcut Creation (line 748)
```nsis
; REMOVED:
; Create desktop shortcut for silent and passive installers
; because finish page will be skipped
${If} $PassiveMode = 1
${OrIf} ${Silent}
  Call CreateOrUpdateDesktopShortcut
${EndIf}
```

In silent/passive install mode, the finish page is skipped, so the checkbox never appears. The original template auto-created a desktop shortcut in these modes. This was removed so silent installs also don't create desktop shortcuts.

### 3. CreateOrUpdateDesktopShortcut Function (line 973)
```nsis
; REMOVED:
Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
```

The entire function that creates the desktop shortcut was removed.

---

## What Was Kept

### Uninstaller Desktop Shortcut Cleanup (line 859)
The uninstaller still removes any existing desktop shortcuts:
```nsis
; Remove desktop shortcuts
!insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
${If} $0 = 1
  !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
  Delete "$DESKTOP\${PRODUCTNAME}.lnk"
${EndIf}
```

This is important for users who have NEXUS installed from a previous version that did create a desktop shortcut. When they upgrade, the old desktop shortcut is cleaned up.

### NoShortcutMode Variable (line 75)
The `$NoShortcutMode` variable is still used for the Start Menu shortcut:
```nsis
${If} $NoShortcutMode = 1
  Return
${EndIf}
```

This allows users to pass `/NS` on the command line to skip all shortcuts if desired.

---

## User Request

> "removing the desktop shortcut option from the installer"

The user specifically wanted the desktop shortcut option removed from the installer. NEXUS is a background assistant that runs in the system tray — it doesn't need a desktop shortcut. The Start Menu shortcut is sufficient for users who want to manually launch it.

---

## Verification

| Check | Result |
|-------|--------|
| No "Create Desktop Shortcut" checkbox on finish page | Pass |
| No desktop shortcut created in normal install | Pass |
| No desktop shortcut created in silent install | Pass |
| No desktop shortcut created in passive install | Pass |
| Start Menu shortcut still created | Pass |
| Uninstaller still cleans up old desktop shortcuts | Pass |
| `/NS` flag still skips all shortcuts | Pass |
