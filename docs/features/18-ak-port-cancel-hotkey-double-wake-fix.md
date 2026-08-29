# 18 — AK Port: Cancel Hotkey + Double Wake Fix

**Date:** 2026-08-29
**Source:** `Engine-NEXUS/AK` repo (cancel hotkey) + bug discovered during testing
**Status:** Implemented and tested

## Part 1: Cancel Hotkey (Ctrl+Space)

### Problem

If the user accidentally wakes NEXUS (hotkey or wake word), the orb sits
there for 8 seconds (no-speech timeout) before sliding down. There was no
way to instantly cancel.

### Solution

Added `Ctrl+Space` as a dedicated cancel hotkey, separate from the wake
hotkeys. This is a contribution from the AK repo.

### Implementation (`src-tauri/src/hotkey.rs`)

```rust
const HOTKEY_CANCEL: &str = "CommandOrControl+Space";
```

Registered after the wake hotkey loop:

```rust
let sc_cancel: Shortcut = HOTKEY_CANCEL.parse()?;
let handle_cancel = app.clone();
app.global_shortcut().on_shortcut(sc_cancel, move |_app, _shortcut, event| {
    if event.state() == ShortcutState::Pressed {
        tracing::info!("hotkey (cancel) → cancelling current turn");
        if let Some(win) = handle_cancel.get_webview_window("main") {
            let _ = win.eval("window.__NEXUS_CANCEL__ && window.__NEXUS_CANCEL__()");
        }
    }
})?;
```

The frontend's `__NEXUS_CANCEL__` handler (already in `main.tsx`) stops VAD,
aborts recording, releases the mic, and hides the orb.

### Hotkey summary after this change

| Hotkey | Action |
|---|---|
| `Ctrl+Shift+Space` | State-dependent: close sidebar OR wake NEXUS |
| `Ctrl+Alt+Space` | State-dependent: close sidebar OR wake NEXUS |
| `Alt+Space` | State-dependent: close sidebar OR wake NEXUS |
| `Ctrl+Space` | Cancel current recording/session + hide orb |

### Why not use AK's exact hotkey layout

AK uses:
- `Ctrl+Shift+Space` → wake + dismiss sidebar (always both)
- `Ctrl+Space` → cancel

We keep our state-dependent approach (close sidebar OR wake, not both)
because it's more intuitive — pressing the hotkey twice with the sidebar
visible first closes the sidebar, then wakes NEXUS. AK's approach always
emits `sidebar:hide` even when the sidebar isn't visible, which is wasteful.

We also keep `Ctrl+Alt+Space` and `Alt+Space` for Linux compatibility
(GNOME Wayland hijacks some combinations).

---

## Part 2: Double "On It Sir" Fix

### Problem

When waking NEXUS, the greeting "on it sir" was spoken **twice**. The
console logs showed:

```
[NEXUS] assistant:wake event received       ← Tauri event #1
[NEXUS] nexus://wake event received         ← Tauri event #2
[NEXUS] __NEXUS_WAKE__ invoked              ← Direct eval #3
```

`wakeWithGreeting()` was called 3 times, causing the TTS to speak the
greeting twice (the third call was ignored because the state was already
"listening").

### Root cause

The Rust wake-word engine (`wakeword_oww.rs`) emitted BOTH Tauri events
AND called `window.__NEXUS_WAKE__()` via eval:

```rust
// Before (triple wake):
let _ = app.emit("assistant:wake", ());
let _ = app.emit("nexus://wake", ());
let _ = win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
```

The frontend listened to all three:

```typescript
// Before (triple listener):
window.__NEXUS_WAKE__ = () => wakeWithGreeting();
listen("assistant:wake", () => wakeWithGreeting());
listen("nexus://wake", () => wakeWithGreeting());
```

### Fix

**Rust side** — only use direct eval (most reliable for repeated rapid
events, per Tauri docs):

```rust
// After (single wake):
let _ = win.eval("window.__NEXUS_WAKE__ && window.__NEXUS_WAKE__()");
```

**Frontend side** — removed the Tauri event listeners:

```typescript
// After: __NEXUS_WAKE__ is the canonical handler.
// No more listen("assistant:wake") or listen("nexus://wake").
```

Also fixed `tray.rs` which had the same triple-emission pattern.

### Verification

Tested live on 2026-08-29. Console logs now show a single wake:

```
[NEXUS] __NEXUS_WAKE__ invoked
[NEXUS] wake → idle
[NEXUS] baton pass: Rust wakeword paused
```

"on it sir" is spoken once.
