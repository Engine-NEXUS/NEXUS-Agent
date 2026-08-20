# Feature: Microphone Permission Handler

> Auto-approves microphone and camera permissions for NEXUS's own pages, so the permission dialog never re-appears after restart.

**Source files:**
- `src-tauri/src/mic_permissions.rs` — the handler
- `src-tauri/src/lib.rs` — `mic_permissions::init(app)` call in setup

---

## The Problem

Without a custom permission handler:
1. NEXUS calls `navigator.mediaDevices.getUserMedia()` for the mic.
2. WebView2 shows its built-in permission dialog.
3. The user clicks "Allow".
4. The decision is **not reliably persisted** across sessions in standalone WebView2 apps.
5. After every restart, the dialog re-appears.

**Root cause:** wry (Tauri's webview layer) only registers a `PermissionRequested` handler for the clipboard. For mic/camera, WebView2 falls back to its built-in dialog.

## The Solution

Register our own `PermissionRequested` handler on each WebView2 instance that:
1. Intercepts `MICROPHONE` and `CAMERA` permission requests.
2. Checks the requesting origin.
3. If the origin is one of NEXUS's own → auto-allow (set state to `ALLOW`).
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

**Foreign origins are never silently granted mic/camera access.** This prevents third-party content (if any ever loads in the webview) from accessing the mic without a dialog.

## Which Windows Get the Handler?

Both the `main` window and the `setup` window:
- `main` — the orb, which captures mic for wake word + recording.
- `setup` — the voice enrollment page, which captures mic for enrollment clips.

## How It's Implemented

```rust
unsafe fn register_media_permission_handler(webview: &PlatformWebview, label: &str) {
    let core = webview.controller().CoreWebView2()?;
    core.add_PermissionRequested(
        &PermissionRequestedEventHandler::create(Box::new(|_sender, args| {
            let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
            args.PermissionKind(&mut kind)?;
            let is_media = kind == MICROPHONE || kind == CAMERA;
            if !is_media { return Ok(()); }  // Not ours — let WebView2 decide
            let origin = take_pwstr(args.Uri()?);
            if ALLOWED_ORIGIN_PREFIXES.iter().any(|p| origin.starts_with(p)) {
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
            }
            Ok(())
        })),
        &mut token,
    )?;
}
```

The COM event subscription holds a reference to the handler for the lifetime of the webview — no need to store the token.

## Result

- No permission dialog, ever, regardless of user-profile state.
- The grant is programmatic and instant.
- Foreign origins still get the default dialog (security preserved).
- Works on both `main` and `setup` windows.

**Platform note:** This handler is Windows-only (`#[cfg(target_os = "windows")]`). macOS and Linux use the OS-level permission system (TCC / PipeWire), which persists decisions reliably.
