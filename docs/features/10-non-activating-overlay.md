# 10 — Non-Activating Floating Overlay

**Branch:** prem22k
**Status:** Implemented
**Date:** 2026-08-29

---

## Problem

When NEXUS woke up, the orb window would steal keyboard focus from the
active application (IDE, terminal, browser). This was disruptive — the user
would be typing in VS Code, say "NEXUS", and their cursor focus would jump
to the NEXUS orb.

## Implementation (`src-tauri/src/window_manager.rs`)

### `configure_non_activating_overlay()`

```rust
pub fn configure_non_activating_overlay<R: Runtime>(win: &WebviewWindow<R>) -> Result<(), String> {
    let _ = position_orb(win);
    win.set_always_on_top(true).map_err(|e| e.to_string())?;
    let _ = win.set_focusable(false);  // Key: don't steal keyboard focus
    Ok(())
}
```

### `position_orb()`

Positions the orb at bottom-center, just above the taskbar/dock:

```rust
pub fn position_orb<R: Runtime>(win: &WebviewWindow<R>) -> Result<(), String> {
    if let Ok(Some(monitor)) = win.current_monitor() {
        let scale = monitor.scale_factor();
        let screen = monitor.size();
        let orb = 200i32;
        let phys_orb = (orb as f64 * scale) as i32;

        let x = (screen.width as i32 - phys_orb) / 2;

        // Platform-specific dock offsets
        #[cfg(target_os = "macos")]
        let dock_offset = (70.0 * scale) as i32;
        #[cfg(target_os = "windows")]
        let dock_offset = (48.0 * scale) as i32;
        #[cfg(target_os = "linux")]
        let dock_offset = (36.0 * scale) as i32;

        let gap = (12.0 * scale) as i32;
        let y = screen.height as i32 - phys_orb - dock_offset - gap;

        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
    Ok(())
}
```

### Usage

Called from:
- `window_manager::init()` — at startup
- `hotkey.rs` — on hotkey press (re-apply overlay state)
- `commands.rs` — after closing setup window

## Impact

NEXUS now wakes without stealing keyboard focus. The user can continue
typing in their IDE while NEXUS listens and responds.

## Files Changed

- `src-tauri/src/window_manager.rs` — position_orb(), configure_non_activating_overlay()
- `src-tauri/src/hotkey.rs` — Uses configure_non_activating_overlay()
- `src-tauri/src/commands.rs` — Uses configure_non_activating_overlay() after setup close
