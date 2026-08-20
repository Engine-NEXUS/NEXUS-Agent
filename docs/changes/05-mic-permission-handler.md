# Change: Microphone Permission Handler

**Commit:** `3cfa5ef` ("fix: mic prompt every restart + terminal window on every boot")
**Date:** 2026-08-19

---

## Problem

After every Windows restart, the microphone permission dialog re-appeared when NEXUS tried to use the mic. The user had to click "Allow" every single time.

## Root Cause

wry (Tauri's webview layer) only registers a `PermissionRequested` handler for the **clipboard**. For microphone and camera, WebView2 falls back to its built-in permission dialog.

In standalone WebView2 apps, the dialog's decisions are **not reliably persisted** across sessions — so the prompt re-appears after every restart.

## Fix

Added a custom `PermissionRequested` handler in `src-tauri/src/mic_permissions.rs` that:
1. Intercepts `MICROPHONE` and `CAMERA` permission requests.
2. Checks the requesting origin.
3. If the origin is one of NEXUS's own → auto-allow (`SetState(ALLOW)`).
4. If the origin is foreign → fall through to WebView2's default dialog.

## Allowed Origins

```rust
const ALLOWED_ORIGIN_PREFIXES: &[&str] = &[
    "http://tauri.localhost",   // production (embedded frontend)
    "https://tauri.localhost",
    "http://localhost",         // dev mode (Vite)
    "https://localhost",
    "ipc://localhost",          // Tauri IPC origin
];
```

**Foreign origins are never silently granted mic/camera access.** This prevents third-party content from accessing the mic without a dialog.

## Implementation

```rust
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
    COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW,
};
use webview2_com::{take_pwstr, PermissionRequestedEventHandler};

core.add_PermissionRequested(
    &PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
        args.PermissionKind(&mut kind)?;
        let is_media = kind == MICROPHONE || kind == CAMERA;
        if !is_media { return Ok(()); }
        let origin = take_pwstr(args.Uri()?);
        if ALLOWED_ORIGIN_PREFIXES.iter().any(|p| origin.starts_with(p)) {
            args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
        }
        Ok(())
    })),
    &mut token,
)?;
```

## Windows Get the Handler

Both the `main` window and the `setup` window:
- `main` — the orb (mic for wake word + recording).
- `setup` — the voice enrollment page (mic for enrollment clips).

## Compile Fixes

The initial compile failed with:
1. **Missing `PermissionRequestedEventHandler`** — fixed by importing from `webview2_com`.
2. **Type inference error** — fixed by explicitly typing the closure.
3. **Borrow-after-move for the window label** — fixed by cloning the label before moving it into the WebView closure.

## Files Changed

- `src-tauri/src/mic_permissions.rs` — new file (the handler).
- `src-tauri/src/lib.rs` — added `mod mic_permissions;` and `mic_permissions::init(app);` in setup.
- `src-tauri/Cargo.toml` — added `webview2-com` dependency.

## Result

- No permission dialog, ever, regardless of user-profile state.
- The grant is programmatic and instant.
- Foreign origins still get the default dialog (security preserved).
- Works on both `main` and `setup` windows.

**Platform note:** This handler is Windows-only. macOS and Linux use the OS-level permission system (TCC / PipeWire), which persists decisions reliably.
