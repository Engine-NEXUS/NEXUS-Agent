# Feature 21 — Liquid Glass Sidebar (Screenshot-Capture Blur)

> **Window label:** `sidebar`
> **Files:** `src-tauri/src/sidebar_backdrop.rs`, `src-tauri/src/dwm_corners.rs`, `src-tauri/src/dyn_windows.rs`, `src-tauri/src/commands.rs`, `frontend/src/sidebar/sidebar.css`, `frontend/src/sidebar/SidebarApp.tsx`
> **Added in:** 2026-08-30
> **Status:** Working, verified at runtime

---

## TL;DR

The sidebar window is a **non-activating, frameless, transparent** Tauri window.
On Windows 11, native DWM Acrylic/Mica **cannot render translucently** on a
non-activating window (DWM only shows the live blurred material for the
OS-active/foreground window). CSS `backdrop-filter` is also a **no-op** in a
fully transparent WebView2 host — Chromium reports support but has no backdrop
texture to sample.

The solution is a **"fake blur"**: right before the window becomes visible,
Rust captures the desktop region behind it via GDI `BitBlt`, blurs the
screenshot in-process, encodes it as a PNG data URI, and hands it to the
frontend as a CSS `background-image`. The result is a genuine frosted-glass
look that does not depend on window activation state or WebView2 backdrop
compositing.

This document describes the full technique so it can be reused for other
NEXUS windows that need the same liquid-glass treatment.

---

## Why Native Blur Doesn't Work Here

### Windows 11 DWM Acrylic/Mica

`window-vibrancy::apply_acrylic` / `apply_mica` set
`DWMWA_SYSTEMBACKDROP_TYPE` on the window's HWND. DWM renders the live blurred
material **only when the window is the OS-active/foreground window**. When the
window deactivates (or was never active), DWM falls back to a **solid color**.

The NEXUS sidebar is deliberately **non-activating** (`focus: false`,
`alwaysOnTop: true`, `skipTaskbar: true`) — it must never steal focus from the
app the user is working in. So it is never the OS-active window, and DWM
materials render as an opaque solid instead of translucent blur.

Worse: calling these material APIs **overrides** tao's own transparency setup
(`DwmEnableBlurBehindWindow` with an empty blur region, which is how
`transparent: true` makes a Tauri window see-through). When the material then
fails to render, DWM falls back to a solid color instead of the original
see-through state — producing the "opaque grey/black" panel we initially saw.

### CSS `backdrop-filter` in transparent WebView2

Chromium/WebView2 reports `backdrop-filter` as supported
(`CSS.supports('backdrop-filter', 'blur(10px)')` returns `true`), but in a
**fully transparent** Tauri window the browser has no backdrop texture to
sample — the host surface is transparent, so there's nothing to blur. The
filter is a silent no-op. This is tracked as
MicrosoftEdge/WebView2Feedback #4945.

SVG `feDisplacementMap` refraction via `backdrop-filter: url(#filter)` has the
same problem — no captured backdrop texture means no refraction.

### macOS

`NSVisualEffectMaterial::Sidebar` with `NSVisualEffectState::Active` works
correctly on macOS and is applied at window creation time. The screenshot
capture is Windows-only; macOS uses native vibrancy.

### Linux

No standardized native blur API. WebKitGTK `backdrop-filter` support is
inconsistent across compositors. A solid dark fallback is used.

---

## The Solution: Screenshot-Capture Blur

### Architecture

```
show_sidebar_with_content (async Tauri command)
  │
  ├─ 1. get_or_create_window("sidebar")     ← dyn_windows.rs
  │     └─ WebviewWindowBuilder::build()    ← creates hidden window
  │     └─ dwm_corners::round_corners()     ← DWM corner rounding (Win11)
  │
  ├─ 2. capture_backdrop()                  ← sidebar_backdrop.rs (Win only)
  │     └─ GDI BitBlt → BGRA pixels
  │     └─ bgra_to_rgba()
  │     └─ image::imageops::fast_blur(sigma=32)
  │     └─ PNG encode → base64 → data:image/png;base64,...
  │
  ├─ 3. Store { query, text, backdrop } in PENDING_SIDEBAR static
  │
  ├─ 4. show_sidebar_inner()
  │     └─ Position window at bottom-right
  │     └─ win.show()                        ← window becomes visible
  │     └─ dwm_corners::round_corners()      ← re-assert corners
  │
  └─ 5. (If window already existed) emit sidebar:show + sidebar:backdrop events
        └─ Fast path for already-loaded React app

Frontend (SidebarApp.tsx):
  └─ On mount: invoke("get_pending_sidebar_content")
     └─ Returns { query, text, backdrop } | null
     └─ Sets --sidebar-backdrop-image CSS var on <html>
     └─ Calls store.show(query, text)
```

### Why "Pending Content" Instead of Events?

When the sidebar window is **created on-demand** (not at startup), the WebView2
needs time to load `sidebar.html` and mount the React app. If Rust emits
`sidebar:show` / `sidebar:backdrop` Tauri events immediately after creating the
window, **those events are lost** because no listener exists yet.

Instead, Rust stores the content + backdrop in a `static Mutex<Option<...>>`.
The frontend calls `get_pending_sidebar_content` on mount, which returns and
clears the pending data. This is **race-free** regardless of how long the
WebView takes to load.

If the window already exists (React already loaded), Rust also emits the events
as a **fast path** — the listener handles them immediately without polling.

---

## Rust Implementation

### `sidebar_backdrop.rs` — GDI Capture + Blur

**Platform:** Windows only. No-op on macOS/Linux (returns `None`).

```rust
pub fn capture_and_blur(x: i32, y: i32, w: i32, h: i32, sigma: f32) -> Option<String>
```

1. **Capture:** `GetDC(HWND(0))` → `CreateCompatibleDC` → `CreateDIBSection`
   (32-bit BGRA, top-down) → `BitBlt` with `SRCCOPY | CAPTUREBLT`.
   - `CAPTUREBLT` includes layered windows in the capture.
   - No capture indicator, no permission prompt (GDI, not `BitBlt` via DXVA).
   - Works since Windows 95.

2. **Convert:** BGRA → RGBA (swap R/B channels, force alpha=255).

3. **Blur:** `image::imageops::fast_blur(&img, sigma)`.
   - `sigma = 32.0` gives a strong frosted-glass look.
   - `fast_blur` is a box-blur approximation — O(w×h), independent of sigma.

4. **Encode:** `DynamicImage::write_to(..., Png)` → `base64::encode` →
   `data:image/png;base64,{b64}`.

**Critical:** Must be called **before `win.show()`** so the capture doesn't
include the sidebar window itself.

### `dwm_corners.rs` — DWM Window Corner Rounding

**Platform:** Windows 11 22000+ only. No-op on earlier versions.

Frameless (`decorations: false`) Tauri windows are plain rectangles at the OS
level. WebView2 cannot clip its surface to match CSS `border-radius`. Without
this, DWM paints a sharp-cornered rectangle behind the rounded CSS card,
producing a "double panel" mismatch.

```rust
DwmSetWindowAttribute(
    hwnd,
    DWMWA_WINDOW_CORNER_PREFERENCE, // 33
    &DWMWCP_ROUND,                 // 2
    ...
);
```

Called at window creation (`dyn_windows::get_or_create_window`) and re-asserted
on every `show_sidebar_inner` (in case it was lost).

### `dyn_windows.rs` — Dynamic Window Creation

Windows are created on-demand (not at startup) to save ~250 MB RAM per window.
Only `main` (orb) is in `tauri.conf.json`.

```rust
pub fn get_or_create_window(app, config: WindowConfig) -> Result<WebviewWindow, String>
pub fn destroy_window(app, label: &str) -> Result<(), String>
```

Platform effects applied at creation time:
- **Windows:** `dwm_corners::round_corners()` for sidebar
- **macOS:** `apply_vibrancy(Sidebar, Active, 20.0)` for sidebar

### `commands.rs` — Show/Hide Commands

**All sidebar commands MUST be `async`.** `WebviewWindowBuilder::build()`
dispatches to the main thread. A synchronous Tauri command runs on a blocking
thread that can't yield, causing a **deadlock** — the command hangs forever
waiting for the main thread to create the window, but the main thread can't
run because the blocking thread holds the IPC channel.

```rust
#[tauri::command]
pub async fn show_sidebar_with_content<R: Runtime>(
    app: tauri::AppHandle<R>,
    query: String,
    text: String,
) -> Result<(), String> { ... }

#[tauri::command]
pub async fn show_sidebar<R: Runtime>(...) -> Result<(), String> { ... }
```

`hide_sidebar` calls `dyn_windows::destroy_window("sidebar")` — this **kills**
the WebView2 process tree (not just `hide()`), freeing ~250 MB.

### Pending Content Static

```rust
#[derive(Clone)]
struct PendingSidebar {
    query: String,
    text: String,
    backdrop: Option<String>, // data:image/png;base64,... URI
}

static PENDING_SIDEBAR: Mutex<Option<PendingSidebar>> = Mutex::new(None);

#[tauri::command]
pub fn get_pending_sidebar_content() -> Result<Option<serde_json::Value>, String> {
    let mut pending = PENDING_SIDEBAR.lock().unwrap();
    let data = pending.take(); // Returns and clears
    Ok(data.map(|p| json!({ "query": p.query, "text": p.text, "backdrop": p.backdrop })))
}
```

### Backdrop Self-Capture Prevention

If the window is already visible and `show_sidebar` is called again (e.g. from
the frontend's visibility `useEffect`), the capture would photograph the
sidebar itself instead of the desktop behind it.

```rust
let already_visible = win.is_visible().unwrap_or(false);
show_sidebar_inner(&app, &win, already_visible)?; // skip capture if visible
```

The frontend's `useEffect` was also changed to **not** call
`invoke("show_sidebar")` when `visible` becomes true — the window is already
shown by Rust before the React app loads.

---

## CSS Implementation

### `sidebar.css` — Liquid Glass Card

The card uses the captured bitmap as a background layer, combined with a subtle
white glass tint and edge highlights. No CSS `backdrop-filter` (it's a no-op in
transparent WebView2).

```css
.sidebar-card {
  /* --sidebar-backdrop-image is set on <html> from JS.
     DO NOT redeclare it here — that would shadow the inherited value. */
  background-image:
    var(--sidebar-backdrop-image, none),
    linear-gradient(180deg, rgba(255,255,255,0.08) 0%, transparent 40%);
  background-size: cover, auto;
  background-color: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-top: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 18px;
  box-shadow:
    0 24px 64px rgba(0, 0, 0, 0.6),           /* drop shadow */
    inset 0 0 0 1px rgba(255, 255, 255, 0.06), /* inner rim */
    inset 0 0 6px 0 rgba(255, 255, 255, 0.04), /* soft inner glow */
    inset 0 2px 4px -2px rgba(255, 255, 255, 0.28), /* lit top bezel */
    inset 0 -2px 4px -2px rgba(0, 0, 0, 0.25);     /* bottom shadow */
}
```

### Specular Edge Sheen (`::before`)

A gradient border via `::before`, masked to show only the rim — simulates light
catching the edge of glass:

```css
.sidebar-card::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 18px;
  padding: var(--lg-rim-width); /* 1.5px */
  background: linear-gradient(135deg,
    rgba(255,255,255, var(--lg-sheen-opacity)) 0%,  /* 0.35 */
    rgba(255,255,255, 0.04) 25%,
    rgba(255,255,255, 0) 50%,
    rgba(255,255,255, 0.04) 75%,
    rgba(255,255,255, calc(var(--lg-sheen-opacity) * 0.7)) 100%
  );
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
```

### Linux Fallback

```css
@supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
  .sidebar-card { background: #1a1a1c; }
  .sidebar-card::before { display: none; }
}
```

### CSS Variable Inheritance Pitfall

The Rust event sets `--sidebar-backdrop-image` on `document.documentElement`
(`<html>`). If `.sidebar-card` declares `--sidebar-backdrop-image: none;`
locally, **that local declaration shadows the inherited value** and the dynamic
image never appears. The fix: do NOT declare the variable on `.sidebar-card` —
let it inherit from `<html>`. Use `var(--sidebar-backdrop-image, none)` as
fallback only.

---

## Frontend Implementation

### `SidebarApp.tsx` — Event + Pending Content

```tsx
useEffect(() => {
  // 1. Fetch pending content on mount (handles fresh-window case)
  invoke<{ query: string; text: string; backdrop: string | null } | null>(
    "get_pending_sidebar_content"
  ).then((pending) => {
    if (pending) {
      if (pending.backdrop) {
        document.documentElement.style.setProperty(
          "--sidebar-backdrop-image",
          `url(${pending.backdrop})`
        );
      }
      show(pending.query, pending.text);
    }
  });

  // 2. Event listeners (fast path for already-loaded windows)
  listen<{ query: string; text: string }>("sidebar:show", (event) => {
    show(event.payload.query, event.payload.text);
  });

  listen<string>("sidebar:backdrop", (event) => {
    document.documentElement.style.setProperty(
      "--sidebar-backdrop-image",
      `url(${event.payload})`
    );
  });

  listen("sidebar:hide", () => { stopTts(); hide(); });
}, [show, hide]);
```

### Visibility `useEffect` — No Redundant Show

```tsx
// The window is shown by Rust before React loads — do NOT call
// invoke("show_sidebar") here. Only call hide_sidebar on dismiss.
useEffect(() => {
  if (!visible) {
    stopTts();
    const t = setTimeout(() => invoke("hide_sidebar").catch(() => {}), 400);
    return () => clearTimeout(t);
  }
}, [visible]);
```

---

## Window Configuration

### `dyn_windows::WindowConfig::sidebar()`

| Property | Value | Reason |
|----------|-------|--------|
| `width` / `height` | 600 × 1000 | Fixed size |
| `resizable` | false | No resize handle |
| `decorations` | false | Frameless (CSS provides border) |
| `transparent` | true | See-through to desktop |
| `always_on_top` | true | Above other windows |
| `skip_taskbar` | true | No taskbar entry |
| `shadow` | false | No DWM shadow (CSS provides box-shadow) |
| `focus` | false | **Non-activating** — never steal focus |
| `hidden_title` | true | No title bar artifact |

### Capabilities (`sidebar-cap.json`)

The sidebar window needs its own capability file because Tauri capabilities
are **per-window-label**, not global. Without this, `listen()` calls in the
sidebar's React app silently fail.

```json
{
  "identifier": "sidebar-cap",
  "windows": ["sidebar"],
  "permissions": [
    "core:event:allow-listen",
    "core:event:allow-unlisten"
  ]
}
```

`tauri.conf.json` must include it:
```json
"capabilities": ["main-cap", "sidebar-cap"]
```

---

## How to Reuse This Pattern for Other Windows

To add liquid-glass blur to a new NEXUS window (e.g. a "notes" panel):

### 1. Add a `WindowConfig` in `dyn_windows.rs`

```rust
pub fn notes() -> Self {
    Self {
        label: "notes", title: "NEXUS Notes", url: "notes.html",
        width: 400., height: 600., min_width: None, min_height: None,
        resizable: false, decorations: false, transparent: true,
        always_on_top: true, skip_taskbar: true, shadow: false,
        focus: false, center: false, hidden_title: true,
    }
}
```

### 2. Add a pending content static in `commands.rs`

```rust
static PENDING_NOTES: Mutex<Option<PendingNotes>> = Mutex::new(None);

#[tauri::command]
pub fn get_pending_notes_content() -> Result<Option<serde_json::Value>, String> {
    let mut pending = PENDING_NOTES.lock().unwrap();
    Ok(pending.take().map(|p| json!({ "content": p.content, "backdrop": p.backdrop })))
}
```

### 3. Write the show command (MUST be `async`)

```rust
#[tauri::command]
pub async fn show_notes<R: Runtime>(app: tauri::AppHandle<R>, content: String) -> Result<(), String> {
    let window_existed = app.get_webview_window("notes").is_some();
    let win = crate::dyn_windows::get_or_create_window(&app, crate::dyn_windows::WindowConfig::notes())?;

    let backdrop = if window_existed && win.is_visible().unwrap_or(false) {
        None
    } else {
        capture_backdrop(&app, &win)
    };

    PENDING_NOTES.lock().unwrap().replace(PendingNotes { content: content.clone(), backdrop: backdrop.clone() });

    show_sidebar_inner(&app, &win, backdrop.is_some())?; // reuse the positioning + show logic

    if window_existed {
        let _ = app.emit("notes:show", json!({ "content": content }));
        if let Some(uri) = backdrop { let _ = app.emit("notes:backdrop", uri); }
    }
    Ok(())
}
```

### 4. Add a capability file (`notes-cap.json`)

```json
{
  "identifier": "notes-cap",
  "windows": ["notes"],
  "permissions": ["core:event:allow-listen", "core:event:allow-unlisten"]
}
```

Add `"notes-cap"` to `tauri.conf.json` capabilities array.

### 5. Add Vite input (`frontend/vite.config.ts`)

```ts
input: {
    main: resolve(__dirname, "index.html"),
    // ...
    notes: resolve(__dirname, "notes.html"),
}
```

### 6. Frontend: fetch pending content on mount

```tsx
useEffect(() => {
    invoke<{ content: string; backdrop: string | null } | null>("get_pending_notes_content")
      .then((pending) => {
        if (pending) {
          if (pending.backdrop) {
            document.documentElement.style.setProperty("--notes-backdrop-image", `url(${pending.backdrop})`);
          }
          setContent(pending.content);
        }
      });
    listen<string>("notes:backdrop", (e) => {
        document.documentElement.style.setProperty("--notes-backdrop-image", `url(${e.payload})`);
    });
}, []);
```

### 7. CSS: use the inherited backdrop variable

```css
.notes-card {
    background-image: var(--notes-backdrop-image, none), linear-gradient(...);
    /* DO NOT declare --notes-backdrop-image here — let it inherit from <html> */
    border-radius: 18px;
    /* ... same box-shadow + ::before sheen as .sidebar-card ... */
}
```

### 8. Register commands in `lib.rs`

```rust
.invoke_handler(tauri::generate_handler![
    // ...
    commands::show_notes,
    commands::get_pending_notes_content,
])
```

---

## Cargo Dependencies

```toml
[dependencies]
image = "0.25"          # fast_blur + PNG encode
base64 = "0.22"         # data URI encoding

[target.'cfg(windows')'.dependencies]
windows = { version = "0.36", features = [
    "Win32_Foundation",
    "Win32_Graphics_Gdi",
] }
```

`dwm_corners.rs` uses a minimal FFI binding to `DwmSetWindowAttribute`
(`#[link(name = "dwmapi")]`) to avoid `windows`-crate version type mismatches.

---

## Verification Checklist

When verifying liquid glass on any window:

- [ ] **Window is genuinely transparent** — desktop behind it is visible
- [ ] **Blur appears in the captured backdrop** — not a flat solid color
- [ ] **Only one panel shape is visible** — no double-panel / mismatched corners
- [ ] **Corners align** — CSS `border-radius` matches DWM corner rounding
- [ ] **Panel is translucent, not grey** — the white tint is subtle (~5% alpha)
- [ ] **Content is readable** — text contrast against the blurred backdrop
- [ ] **Re-show after destroy works** — fresh capture on each new window
- [ ] **No self-capture** — backdrop doesn't show the window itself
- [ ] **Rust logs confirm**: `backdrop captured (N bytes)` + `pending content fetched`
- [ ] **CDP check**: `--sidebar-backdrop-image` is set on `<html>` with a data URI
- [ ] **CDP check**: `appClass` is `sidebar--visible` (not `sidebar--hidden`)

### CDP Verification Commands

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
Start-Process .\src-tauri\target\release\nexus.exe
Start-Sleep 15
# Trigger sidebar via CDP:
#   window.__TAURI__.core.invoke("show_sidebar_with_content", { query: "test", text: "# Hello" })
# Then check sidebar target:
#   document.documentElement.style.getPropertyValue("--sidebar-backdrop-image")
#   document.getElementById("sidebar-app").className  → "sidebar--visible"
```

---

## Known Limitations

1. **Snapshot, not live:** The backdrop is a one-time capture. If the desktop
   behind the window changes while the sidebar is open, the blur doesn't
   update. Acceptable for a response panel shown once per query.

2. **Windows-only capture:** macOS uses native vibrancy (better — it's live).
   Linux uses a solid dark fallback.

3. **DPI scaling:** The capture uses physical pixels
   (`phys_w = 600 * scale_factor`), so it's correct on HiDPI displays.

4. **Multi-monitor:** Captures from the monitor the window is positioned on
   (`win.current_monitor()`), so it works correctly on multi-monitor setups.

5. **Capture before show:** The capture MUST happen before `win.show()`.
   If the window is already visible, capture is skipped to avoid
   self-capture.

---

## File Reference

| File | Role |
|------|------|
| `src-tauri/src/sidebar_backdrop.rs` | GDI capture + blur + PNG/base64 encode |
| `src-tauri/src/dwm_corners.rs` | DWM window corner rounding (Win11) |
| `src-tauri/src/dyn_windows.rs` | Dynamic window create/destroy + platform effects |
| `src-tauri/src/commands.rs` | `show_sidebar` / `show_sidebar_with_content` / `get_pending_sidebar_content` / `hide_sidebar` |
| `src-tauri/capabilities/sidebar-cap.json` | Sidebar event permissions |
| `src-tauri/tauri.conf.json` | Capabilities list (must include `sidebar-cap`) |
| `frontend/src/sidebar/sidebar.css` | Liquid glass CSS (backdrop image + sheen + tint) |
| `frontend/src/sidebar/SidebarApp.tsx` | Pending content fetch + event listeners |
| `frontend/vite.config.ts` | `sidebar` rollup input |
