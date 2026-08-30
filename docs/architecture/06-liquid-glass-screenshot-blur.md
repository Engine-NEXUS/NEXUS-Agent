# ADR-05 — Liquid Glass via Screenshot-Capture Blur

> **Date:** 2026-08-30
> **Status:** Accepted, implemented, verified
> **Supersedes:** Native DWM Acrylic/Mica (rejected for non-activating windows)

## Context

The NEXUS response sidebar needs a frosted-glass / liquid-glass appearance —
a translucent panel that blurs the desktop behind it. The sidebar window is:

- **Frameless** (`decorations: false`) — CSS provides the border
- **Transparent** (`transparent: true`) — desktop shows through
- **Non-activating** (`focus: false`) — never steals focus from the user's app
- **Always-on-top** — floats above other windows
- **Dynamic** — created on-demand, destroyed on close (saves ~250 MB RAM)

## Decision Drivers

1. **Visual quality:** Must look like real frosted glass, not a flat grey panel
2. **Focus preservation:** Must never steal window focus
3. **Cross-platform:** Must work on Windows, macOS, and Linux
4. **RAM efficiency:** Must work with dynamic (on-demand) window creation
5. **Race-free content delivery:** Must not lose content when the window is
   freshly created and the React app hasn't loaded yet

## Considered Options

### Option A: Native DWM Acrylic/Mica (`window-vibrancy::apply_acrylic`)

**Rejected.** DWM materials only render the live blurred material for the
OS-active/foreground window. The sidebar is non-activating, so DWM falls back
to a solid color. Calling the material API also overrides tao's transparency
setup, making the window opaque instead of see-through.

### Option B: CSS `backdrop-filter: blur()`

**Rejected.** Chromium/WebView2 reports `backdrop-filter` as supported, but in
a fully transparent Tauri window there's no backdrop texture to sample — the
filter is a silent no-op. This is a known WebView2 limitation
(MicrosoftEdge/WebView2Feedback #4945).

### Option C: SVG `feDisplacementMap` refraction via `backdrop-filter: url(#filter)`

**Rejected.** Same underlying problem as Option B — no captured backdrop
texture means no refraction. The SVG filter syntax is supported but produces
no visible effect.

### Option D: Screenshot-capture blur (GDI `BitBlt` + Rust blur) ✅

**Accepted.** Right before the window becomes visible, Rust captures the
desktop region behind it via GDI `BitBlt`, blurs the screenshot in-process
using `image::imageops::fast_blur`, encodes it as a PNG data URI, and hands
it to the frontend as a CSS `background-image`.

**Pros:**
- Genuine frosted-glass look (real blur of real desktop content)
- Does not depend on window activation state
- Does not depend on WebView2 backdrop compositing
- Works with dynamic (on-demand) window creation
- No external dependencies beyond `image` + `base64` crates

**Cons:**
- Snapshot, not live (doesn't update if desktop changes while open)
- Windows-only (macOS uses native vibrancy, Linux uses solid fallback)
- Requires capture before `win.show()` to avoid self-capture

## Decision

**Use Option D (screenshot-capture blur) on Windows.**
**Use native `NSVisualEffectMaterial::Sidebar` on macOS.**
**Use solid dark fallback on Linux.**

## Consequences

### Positive
- Liquid glass works on non-activating windows (the core requirement)
- No dependency on DWM material APIs that change between Windows versions
- Pattern is reusable for any future NEXUS window that needs glass

### Negative
- Snapshot is not live-reactive (acceptable for a response panel)
- Adds `image` + `base64` crate dependencies (~2 MB binary size)
- GDI capture is Windows-only (platform-specific code path)

### Mitigations
- Re-capture on every window show (fresh backdrop each time)
- Skip capture if window is already visible (prevents self-capture)
- macOS/Linux have their own code paths (not affected by GDI)

## Related ADRs

- **ADR-04:** Non-activating overlay windows (the reason native blur fails)
- **ADR-06:** Dynamic window creation (the reason pending content is needed)

## References

- `docs/features/21-liquid-glass-sidebar.md` — Full implementation guide
- `src-tauri/src/sidebar_backdrop.rs` — GDI capture + blur
- `src-tauri/src/dwm_corners.rs` — DWM corner rounding
- MicrosoftEdge/WebView2Feedback #4945 — backdrop-filter in transparent windows
