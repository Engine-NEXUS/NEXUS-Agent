# Feature: Window Overlay & Click-Through

> The NEXUS orb is a transparent, frameless, always-on-top overlay that sits at the bottom-center of the screen. Transparent pixels pass clicks through; the avatar catches them.

**Source files:**
- `src-tauri/src/window_manager.rs` — window config + click-through IPC
- `src-tauri/src/lib.rs` — orb positioning (bottom-center, above taskbar)
- `frontend/src/overlay/clickThrough.ts` — region-aware click-through
- `frontend/src/App.tsx` — visibility + slide animation
- `src-tauri/tauri.conf.json` — window properties

---

## Window Properties

```json
{
  "label": "main",
  "transparent": true,
  "decorations": false,
  "alwaysOnTop": true,
  "skipTaskbar": true,
  "resizable": false,
  "width": 200,
  "height": 200
}
```

- **Transparent:** the window background is alpha-blended with the desktop.
- **No decorations:** no title bar, no border.
- **Always on top:** floats above all other windows.
- **Skip taskbar:** doesn't appear in the taskbar/dock.
- **200×200 px:** just big enough for the orb avatar.

## Positioning

The orb is positioned at **bottom-center**, just above the taskbar/dock:

```rust
let x = (screen.width - orb_width) / 2;  // horizontal center
let y = screen.height - orb_height - taskbar - gap;  // above taskbar
```

- Windows taskbar: ~48 px
- macOS dock: ~70 px
- Gap above taskbar: ~12 px

Positioning accounts for the monitor's scale factor (DPI scaling).

## Click-Through Strategy

Tauri's `set_ignore_cursor_events(ignore: bool)` is **whole-window** — either the entire window catches clicks or the entire window passes them through. We need **region-aware** click-through: transparent pixels pass through, the avatar catches.

### Strategy A — Hit-Test Polling (Chosen)

```
Frontend listens to pointermove:
  1. element = document.elementFromPoint(x, y)
  2. If element is the transparent root (no avatar underneath):
       setIgnoreCursorEvents(true)  → clicks pass through to desktop
  3. If element is the avatar:
       setIgnoreCursorEvents(false) → clicks hit the orb
```

This toggles per mouse-move only when crossing the avatar boundary (debounced) to avoid thrash.

### Strategy B — Forward Region to Rust (Fallback)

The frontend sends the avatar bounding box via IPC; Rust computes a layered region. OS-specific; only used if Strategy A shows jank.

## Show / Hide Animation

```
Show:
  1. setVisible(true) → CSS class app--visible
  2. invoke("show_overlay") → native window shown immediately
  3. CSS slide-up transition plays (0.5s)

Hide:
  1. setVisible(false) → CSS class app--hidden
  2. CSS slide-down transition plays (0.5s)
  3. After 600ms: invoke("hide_overlay") → native window hidden
     (600ms = 500ms transition + 100ms buffer)
```

**Why defer native hide?** If we called `hide_overlay` immediately, the window would vanish "in the air" before the slide-down animation completes. Deferring lets the CSS animation finish first.

**Rapid re-wake during slide-down:** the pending hide timer is cleared, the window stays shown, and the orb reverses direction (slides back up).

## Auto-Hide

If the user wakes NEXUS but doesn't speak within 8 seconds:
1. Stop VAD + recording + mic stream.
2. `setVisible(false)` → slide-down.
3. `reset()` after 550 ms.

This prevents the orb from hanging open indefinitely if the user accidentally pressed the hotkey.

## Idle Fade

After 4 seconds idle (state = `idle`, visible = `false`), the window opacity fades to 0.08 — still catchable by the hotkey but visually unobtrusive.

## macOS: Accessory App

```rust
#[cfg(target_os = "macos")]
app.set_activation_policy(tauri::ActivationPolicy::Accessory);
```

This hides NEXUS from the Dock and Cmd+Tab switcher — it's a background accessory app, not a regular app.

## Linux: Compositor Required

`transparent: true` requires a compositor (Mutter, KWin, wlroots, etc.). On bare WMs (e.g. i3 without compositor), the overlay degrades to an opaque rounded rectangle.
