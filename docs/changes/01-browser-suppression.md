# Change: Browser Suppression on Boot

**Commit:** `f4e6ac6` (part of: "feat: boot/wake greeting + non-blocking sidecar + no browser on boot")
**Date:** 2026-08-19

---

## Problem

After a Windows restart, Brave browser automatically reopened the previous session — including a Google Colab tab that showed an expired Drive authorization page. Microsoft Edge also auto-launched in the background.

This was annoying and made it look like NEXUS was causing browser popups.

## Root Cause

Two Windows features were responsible:

### 1. Windows Restartable Apps
Windows 10/11 has a feature that automatically reopens apps that were running before a restart. It's controlled by:
```
HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced\RestartApps
```
Default value: `1` (enabled).

### 2. Edge Auto-Launch / Startup Boost
Microsoft Edge registers an auto-launch entry in the registry:
```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run\MicrosoftEdgeAutoLaunch_DF416C10C87681B95CD5DC5F30E3E17A
```
This makes Edge start in the background at login (for startup boost).

## Fix

### Disable Restartable Apps
Set `RestartApps = 0`:
```powershell
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" -Name "RestartApps" -Value 0 -Type DWord
```

### Remove Edge Auto-Launch
Delete the Edge auto-launch registry value:
```powershell
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "MicrosoftEdgeAutoLaunch_DF416C10C87681B95CD5DC5F30E3E17A" -ErrorAction SilentlyContinue
```

## Verification

After the fix:
- `RestartApps` = `0` (verified via `Get-ItemProperty`).
- Edge auto-launch value does not exist (verified via `Get-ItemProperty`).
- After restart: no browser opens, no Colab tab, no Edge background process.

## What This Does NOT Affect

- **Brave's own session restore** is separate — if the user manually opens Brave, it may still restore the previous session. This fix only prevents *automatic* reopening after restart.
- **NEXUS autostart** is unaffected — it uses `tauri-plugin-autostart`, not the browser restart mechanism.
- **Colab training** is unaffected — models checkpoint to Google Drive regardless of browser state.
