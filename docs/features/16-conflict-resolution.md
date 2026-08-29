# 16 — Conflict Resolution Strategy

**Branches:** prem224k + prem22k → main
**Status:** Resolved
**Date:** 2026-08-29

---

## Overview

Both `prem224k` and `prem22k` branch from `main` and modify 3 overlapping
files. This document describes how each conflict is resolved in the merge.

## Conflicting Files

| File | prem22k approach | prem224k approach | Lines changed |
|---|---|---|---|
| `src-tauri/src/hotkey.rs` | Multi-hotkey + non-activating overlay | State-dependent (sidebar-aware) | Both rewrite the `on_shortcut` handler |
| `src-tauri/src/wakeword_oww.rs` | `MIN_POSITIVE_DETECTIONS = 1.0` | `SINGLE_FRAME_HIGH_CONFIDENCE = 0.5` | Both modify `calculate_average()` |
| `src-tauri/tauri.conf.json` | `visible: true` (Linux fix) | CSP for Silero VAD CDN | Different lines, same file |

---

## Resolution 1: `hotkey.rs`

### prem22k changes
- Registers 3 hotkeys: `Ctrl+Shift+Space`, `Ctrl+Alt+Space`, `Alt+Space`
- Uses `configure_non_activating_overlay()` instead of `set_focus()`
- Loop over hotkeys with per-hotkey error handling

### prem224k changes
- Checks sidebar visibility before acting
- If sidebar visible → close sidebar only
- If sidebar hidden → wake NEXUS

### Merged approach
**Both features combined:**
- Register all 3 hotkeys (prem22k)
- Each hotkey has state-dependent behavior (prem224k)
- Use `configure_non_activating_overlay()` (prem22k)

```rust
for &hk in HOTKEYS {
    let sc: Shortcut = hk.parse()?;
    let handle = app.clone();
    app.global_shortcut().on_shortcut(sc, move |_app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            let sidebar_visible = handle
                .get_webview_window("sidebar")
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);

            if sidebar_visible {
                tracing::info!("hotkey ({}) → closing sidebar", hk);
                let _ = handle.emit("sidebar:hide", ());
            } else {
                tracing::info!("hotkey ({}) → waking NEXUS", hk);
                if let Some(win) = handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = crate::window_manager::configure_non_activating_overlay(&win);
                    let _ = win.set_ignore_cursor_events(false);
                    let _ = win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
                }
            }
        }
    })?;
}
```

---

## Resolution 2: `wakeword_oww.rs`

### prem22k changes
- `MIN_POSITIVE_DETECTIONS = 1.0` (lowered from 2.0)
- Any single frame above 0.45 threshold triggers

### prem224k changes
- Keeps `MIN_POSITIVE_DETECTIONS = 2.0`
- Adds `SINGLE_FRAME_HIGH_CONFIDENCE = 0.5`
- Two-path `calculate_average()`:
  - Path 1: Single 0.5+ frame → return immediately
  - Path 2: 2+ frames above 0.45 → return average

### Merged approach
**Take prem224k's approach entirely.** It's more precise:
- High-confidence detections (0.5+) trigger instantly — covers the 58.2%
  recall problem
- Borderline detections (0.45-0.5) still need 2 frames — filters noise
- prem22k's `MIN_POSITIVE_DETECTIONS = 1.0` would let ANY 0.46 frame
  trigger, increasing false positives

---

## Resolution 3: `tauri.conf.json`

### prem22k changes
- `"visible": true` for main window (Linux WebKitGTK DOM suspension fix)

### prem224k changes
- CSP: Added `'unsafe-eval' https://cdn.jsdelivr.net` to `script-src`
- CSP: Added `worker-src 'self' blob:` for VAD Web Worker

### Merged approach
**Take both changes** — they touch different lines:
- `visible: true` in the window config section
- CSP changes in the security section

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "visible": true
      }
    ]
  },
  "app": {
    "security": {
      "csp": "...script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; ... worker-src 'self' blob:;"
    }
  }
}
```

---

## Merge Order

1. Start from `main`
2. Merge `prem224k` first (smaller, fewer conflicts)
3. Merge `prem22k` second, resolving conflicts as described above
4. Build with `custom-protocol` feature
5. Test wake word, hotkey, PR analysis, sidebar
