# Feature 27 — Loading Indicator Overlay (Transparent Click-Through Animation)

> **Window label:** `loading-indicator`
> **Files:** `frontend/public/loading.json`, `frontend/public/wakeup.json`, `frontend/src/loading/LoadingApp.tsx`, `frontend/src/loading/main.tsx`, `frontend/src/loading/loading.css`, `frontend/src/loading/loadingController.ts`, `frontend/loading.html`, `frontend/vite.config.ts`, `src-tauri/src/dyn_windows.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/hotkey.rs`, `src-tauri/capabilities/loading-cap.json`, `src-tauri/tauri.conf.json`, `frontend/src/avatar/Avatar.tsx`, `frontend/src/audio/recorder.ts`, `frontend/src/net/wsBridge.ts`, `frontend/src/main.tsx`
> **Added in:** 2026-09-02
> **Status:** Working, verified at runtime

---

## TL;DR

When the user gives NEXUS a long-running command (e.g. "analyse PR 24 in
zync"), NEXUS immediately says **"On it sir"** and the orb (wakeup
animation) hides. A small **80×80 transparent, click-through Lottie
animation** then appears at the **top-right corner of the screen** to
indicate that NEXUS is still processing the request in the background.

When the Cloudflare Worker responds, the loading animation **disappears
completely** before the response sidebar and orb reappear with
**"Here is the analysis, sir"**.

The loading indicator is:
- **Fully transparent** — no background, no blur, no border, no shadow
- **Click-through** — mouse events pass through to windows behind it
- **Always-on-top** — visible above all other windows
- **Non-focusable** — never steals keyboard focus
- **Skip-taskbar** — doesn't appear in the Windows taskbar
- **Dynamic** — created on demand, destroyed when hidden (saves ~250 MB
  of WebView2 RAM per window)

---

## Architecture

### Window lifecycle

```
User says "analyse PR 24 in zync"
         │
         ▼
  ┌─────────────────┐
  │ recorder.ts     │
  │ isLongRunning() │ ── true ──▶ speak("On it sir")
  └─────────────────┘                  │
         │                             ▼
         │                    TTS finishes
         │                             │
         │                             ▼
         │                    orb hides (setVisible(false))
         │                             │
         │                             ▼
         │                    showLoadingIndicator()
         │                    (async IPC → Rust thread pool)
         │                             │
         │                             ▼
         │                    ┌──────────────────┐
         │                    │ loading-indicator │
         │                    │ window created    │
         │                    │ 80×80 transparent │
         │                    │ click-through     │
         │                    │ top-right corner  │
         │                    └──────────────────┘
         │                             │
         ▼                             │
  sendTranscript() ────────────────────┤
  (HTTP POST to Worker)                │
         │                             │
         ▼                             │
  Worker processes request             │
  (5-30 seconds)                       │
         │                             │
         ▼                             │
  Worker responds                      │
         │                             │
         ▼                             │
  wsBridge.ts: case "result"           │
         │                             │
         ▼                             │
  void hideLoadingIndicator()          │
  (async IPC, non-blocking)            │
         │                             │
         ▼                             ▼
  120ms delay ◀──────────── compositor removes window
         │
         ▼
  sidebar appears + orb reappears
  speak("Here is the analysis, sir")
```

### Show/hide trigger map

**Show (2 paths):**

| # | Trigger | File | Description |
|---|---------|------|-------------|
| S1 | After "On it sir" TTS finishes | `recorder.ts` (2 code paths: `finishCapture` + `finishCaptureFromVad`) | Orb hides → loading indicator appears |
| S2 | Queued command sent | `recorder.ts` → `processNextQueuedCommand()` | Previous result arrived → next queued command sent → loading re-shows |

**Hide (6 paths):**

| # | Trigger | File | Description |
|---|---------|------|-------------|
| H1 | Worker `result` event | `wsBridge.ts` → `case "result"` | Response arrived — loading hides, 120ms delay, then sidebar+orb appear |
| H2 | Worker `done` event | `wsBridge.ts` → `case "done"` | Error/cancel path — loading hides, session resets |
| H3 | Worker `error` event | `wsBridge.ts` → `case "error"` | Server error — loading hides, error shown |
| H4 | 60s timeout | `wsBridge.ts` → `setLongRunningInFlight()` | Worker never responded — loading hides, in-flight flag cleared |
| H5 | User cancel (Rust) | `main.tsx` → `__NEXUS_CANCEL__` | Rust cancel signal — loading hides, session reset |
| H6 | Barge-in (Ctrl+Space) | `main.tsx` → `startListening()` | User interrupts — loading hides, orb reappears for new command |

---

## Animation Assets

### File renames

The original animation files were renamed to clarify their purpose:

| Original | New | Purpose | Dimensions | Frame rate |
|----------|-----|---------|------------|------------|
| `loading.json` | `wakeup.json` | Orb/wake animation (shown when NEXUS wakes) | 1000×1000 | 60 fps |
| `analyzing.json` | `loading.json` | Loading indicator (shown during processing) | 3500×3500 | 60 fps |

Both files live in `frontend/public/` and are served as static assets.

### Lottie rendering

The loading indicator uses `lottie-web` (already a project dependency) to
render the `loading.json` animation. The animation is loaded via `fetch()`,
parsed as JSON, and passed to `lottie.loadAnimation()` with:
- `loop: true` — continuous loop while visible
- `autoplay: true` — starts immediately on load
- `renderer: "svg"` — SVG renderer for crisp scaling at any DPI

The 3500×3500 animation canvas is scaled down to fill the 80×80 window via
CSS `width: 100% !important; height: 100% !important;` on the SVG element.

---

## Window Configuration

### Rust (`dyn_windows.rs`)

```rust
pub fn loading_indicator() -> Self {
    Self {
        label: "loading-indicator",
        title: "NEXUS Loading",
        url: "loading.html",
        width: 80.,
        height: 80.,
        min_width: Some(80.),
        min_height: Some(80.),
        resizable: false,
        decorations: false,
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        shadow: false,
        focus: false,
        center: false,
        hidden_title: true,
    }
}
```

### Window attributes explained

| Attribute | Value | Reason |
|-----------|-------|--------|
| `transparent` | `true` | Fully transparent background — only the Lottie animation is visible |
| `decorations` | `false` | No title bar, no window frame, no close button |
| `always_on_top` | `true` | Visible above all other windows (IDE, browser, etc.) |
| `skip_taskbar` | `true` | Doesn't appear in the Windows taskbar |
| `focus` | `false` | Non-activating — never steals keyboard focus |
| `shadow` | `false` | No drop shadow (would be visible against transparent background) |
| `resizable` | `false` | Fixed 80×80 size |
| `center` | `false` | Positioned manually at top-right corner |

### Positioning

The window is positioned at the **top-right corner** of the current monitor:

```rust
let inset_x = (7.0 * scale) as i32;  // 7px from right edge
let inset_y = (9.0 * scale) as i32;  // 9px from top edge
let x = screen.width as i32 - phys_win - inset_x;
let y = inset_y;
```

The insets are DPI-aware (multiplied by `monitor.scale_factor()`). On a
150% DPI display, the actual pixel offsets are 10.5px from the right and
13.5px from the top.

### Click-through

The window is permanently click-through via:
```rust
win.set_ignore_cursor_events(true).map_err(|e| e.to_string())?;
```

This is called after positioning but before `show()`, ensuring the window
is click-through from the very first frame. Mouse clicks pass through to
whatever application is behind it (IDE, browser, desktop, etc.).

### Screenshot exclusion (Windows)

The loading indicator is **NOT** added to the `WDA_EXCLUDEFROMCAPTURE` set
(unlike the sidebar and architect-sidebar). This is intentional — the
loading indicator is a small visual marker, not a content panel, and
excluding it from capture would add complexity without benefit.

### DWM corner rounding

The loading indicator deliberately does **NOT** get DWM corner rounding
(`dwm_corners::round_corners()`). The 80×80 window is small enough that
rounded corners would clip the animation. The CSS already handles any
visual rounding if needed.

---

## Critical Bug Fix: Synchronous Command Deadlock

### The problem

The initial implementation used **synchronous** Rust commands:
```rust
#[tauri::command]
pub fn show_loading_indicator(...) -> Result<(), String> {
    // WebviewWindowBuilder::build() here
}
```

On Windows, `WebviewWindowBuilder::build()` **deadlocks** when called from
a synchronous Tauri command. This is a [known Tauri v2
issue](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html#known-issues):

> "On Windows, this function deadlocks when used in a synchronous command
> and event handlers, see the Webview2 issue. You should use async
> commands and separate threads when creating windows."

### Symptoms

1. The loading animation never appeared (window creation was deadlocked)
2. The Worker response was received by Rust (`worker response received:
   reply_text len=13040` in stderr) but never reached the frontend
3. No sidebar appeared even after 30+ seconds
4. The entire Tauri event loop was blocked — no events could be delivered

### The fix

Made both commands **async** so they run on a Tauri thread pool instead of
the main thread:

```rust
#[tauri::command]
pub async fn show_loading_indicator(...) -> Result<(), String> {
    // WebviewWindowBuilder::build() now runs on a thread pool
    // and doesn't block the main event loop
}
```

This is exactly what the Tauri docs recommend. The `build()` call
dispatches window creation to the main thread internally (via the event
loop proxy), but the calling thread is free to wait without blocking the
event loop.

### Why the sidebar commands already worked

The sidebar commands (`show_sidebar`, `show_sidebar_with_content`,
`show_sidebar_with_analysis`) were already async — they were written
correctly from the start. The loading indicator commands were new and
mistakenly written as synchronous.

---

## Frontend Implementation

### HTML entry (`frontend/loading.html`)

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>NEXUS Loading</title>
    <script type="module" crossorigin src="./assets/loading-[hash].js"></script>
    <link rel="modulepreload" crossorigin href="./assets/client-[hash].js">
    <link rel="modulepreload" crossorigin href="./assets/lottie-[hash].js">
    <link rel="stylesheet" crossorigin href="./assets/loading-[hash].css">
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
```

### React component (`frontend/src/loading/LoadingApp.tsx`)

```tsx
export function LoadingApp() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let destroyed = false;
    fetch("/loading.json")
      .then((res) => res.json())
      .then((data) => {
        if (destroyed || !containerRef.current) return;
        lottie.loadAnimation({
          container: containerRef.current,
          renderer: "svg",
          loop: true,
          autoplay: true,
          animationData: data,
        });
      });
    return () => { destroyed = true; /* cleanup */ };
  }, []);

  return (
    <div id="loading-app">
      <div className="loading-animation-container" ref={containerRef} />
    </div>
  );
}
```

### CSS (`frontend/src/loading/loading.css`)

Key properties:
```css
html, body, #root {
  background: transparent !important;
  border: none !important;
  outline: none !important;
}

#loading-app {
  background: transparent !important;
  border: none !important;
  outline: none !important;
  pointer-events: none;  /* click-through at CSS level too */
}

.loading-animation-container svg {
  width: 100% !important;
  height: 100% !important;
  border: none !important;
  outline: none !important;
}
```

The `border: none !important; outline: none !important;` on every element
ensures no visual border appears around the animation. The
`pointer-events: none` provides CSS-level click-through as a backup to the
Rust-level `set_ignore_cursor_events(true)`.

### Controller (`frontend/src/loading/loadingController.ts`)

```typescript
export async function showLoadingIndicator(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("show_loading_indicator");
  } catch (e) {
    console.warn("[NEXUS] show_loading_indicator failed:", e);
  }
}

export async function hideLoadingIndicator(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("hide_loading_indicator");
  } catch (e) {
    console.warn("[NEXUS] hide_loading_indicator failed:", e);
  }
}
```

Both functions are idempotent — safe to call when the window is already
shown/hidden.

### Vite multi-page configuration (`frontend/vite.config.ts`)

```typescript
build: {
  rollupOptions: {
    input: {
      main: "index.html",
      sidebar: "sidebar.html",
      "sidebar-wide": "sidebar-wide.html",
      architect: "architect.html",
      settings: "settings.html",
      setup: "setup.html",
      loading: "loading.html",  // ← added
    },
  },
},
```

This is required because Tauri dynamic windows load built static assets in
release mode. Without this Rollup entry, `loading.html` and its JS/CSS
chunks would not be emitted to `frontend/dist/`, and the loading window
would show a blank page in production (even if it worked in dev mode).

---

## Tauri Capability Configuration

### Capability file (`src-tauri/capabilities/loading-cap.json`)

```json
{
  "identifier": "loading-cap",
  "description": "Permissions for the loading indicator window",
  "windows": ["loading-indicator"],
  "permissions": [
    "core:default",
    "core:event:default"
  ]
}
```

### Registration in `tauri.conf.json`

```json
{
  "app": {
    "security": {
      "capabilities": [
        "main-cap",
        "sidebar-cap",
        "architect-cap",
        "loading-cap"
      ]
    }
  }
}
```

**Critical:** Tauri v2 requires capability files to be explicitly listed
in `tauri.conf.json`. Merely creating the JSON file is insufficient —
Tauri silently ignores unregistered capability files. This was learned
the hard way during the architect-sidebar implementation (see Feature 21).

---

## Trigger Wiring

### Show trigger in `recorder.ts`

The show trigger is wired into the **instant ack** flow for long-running
queries. There are two code paths (one for `finishCapture`, one for
`finishCaptureFromVad`) that both follow the same pattern:

```typescript
// 1. Detect long-running query (pure regex, <1ms)
const isLong = isLongRunningQuery(transcript);

if (isLong) {
  // 2. Dedup/queue check
  if (isLongRunningInFlight()) {
    await handleDuplicateOrQueuedLongRunning(transcript);
    return;
  }

  // 3. Immediate ack
  useAssistant.getState().setState("speaking");
  useAssistant.getState().addAssistantMessage("On it sir.");
  setLocalAckGiven();
  void speak("On it sir").then(() => {
    // 4. After ack TTS finishes, hide the orb
    const curState = useAssistant.getState().state;
    if (curState === "speaking" || curState === "thinking") {
      useAssistant.getState().setVisible(false);
      setTimeout(() => useAssistant.getState().reset(), 550);
      // 5. Show the loading indicator
      void showLoadingIndicator();
    }
  });
}

// 6. Parse intent + send to Worker (continues in background)
// ...
await sendTranscript(transcript);
```

### Show trigger for queued commands

When a long-running command is already in flight and the user says a
**different** long-running command, it's queued. When the current result
arrives, the next queued command is sent:

```typescript
function processNextQueuedCommand(): void {
  if (pendingLongRunningQueue.length === 0) return;
  const next = pendingLongRunningQueue.shift()!;
  setLongRunningInFlight(next, processNextQueuedCommand);
  // Orb is already hidden from previous command — re-show loading
  void showLoadingIndicator();
  void sendTranscript(next);
}
```

### Hide trigger in `wsBridge.ts` — result handler

```typescript
case "result":
  try {
    // Hide loading immediately (non-blocking async IPC)
    void hideLoadingIndicator();
    // 120ms delay for OS compositor to remove the window
    await new Promise((r) => setTimeout(r, 120));
    // NOW show sidebar + orb + speak "Here is the analysis, sir"
    // ...
  }
```

The 120ms delay ensures the loading animation is **completely gone** from
the screen before the sidebar and orb appear. This prevents any visual
overlap or divergence between the loading indicator and the response.

### Hide trigger in `wsBridge.ts` — done/error handlers

```typescript
case "done":
  clearLongRunningInFlight();
  sessionOpen = false;
  void hideLoadingIndicator();
  store.reset();
  break;

case "error":
  clearLongRunningInFlight();
  sessionOpen = false;
  void hideLoadingIndicator();
  // ...
  break;
```

### Hide trigger in `wsBridge.ts` — 60s timeout

```typescript
longRunningTimeout = setTimeout(() => {
  longRunningInFlight = false;
  lastSentTranscript = "";
  longRunningResultCb = null;
  void hideLoadingIndicator();
}, 60_000);
```

### Hide trigger in `main.tsx` — cancel

```typescript
(window as any).__NEXUS_CANCEL__ = async () => {
  stopTts();
  stopVad();
  await abortCapture();
  if (micStream) micStream.getTracks().forEach((t) => (t.enabled = false));
  void hideLoadingIndicator();
  useAssistant.getState().reset();
  useAssistant.getState().setVisible(false);
};
```

### Hide trigger in `main.tsx` — barge-in

```typescript
function startListening(): void {
  // ...
  void hideLoadingIndicator();  // ← barge-in: orb shows again
  s.setVisible(true);
  s.setState("listening");
  // ...
}
```

---

## Memory Management

### Dynamic window model

The loading indicator follows the same dynamic-window model as the
sidebar and architect-sidebar:

- **Created on demand** — `show_loading_indicator` creates the window
  only when needed. At idle, no WebView2 process exists for it.
- **Destroyed when hidden** — `hide_loading_indicator` calls
  `destroy_window()`, which kills the WebView2 process tree and frees
  ~250 MB of RAM. This is preferred over `hide()` which keeps the
  processes alive.

### RAM impact

| State | RAM |
|-------|-----|
| Idle (loading window not created) | 0 MB |
| Active (loading window visible) | ~250 MB (WebView2 process tree) |
| After hide (window destroyed) | 0 MB |

The destroy/recreate cycle adds ~1-2s of latency on each show, but this
is acceptable because:
1. The loading indicator only appears after "On it sir" TTS finishes
   (~2s), so the window creation overlaps with the TTS playback.
2. The user is already expecting a wait (the Worker takes 5-30s to
   respond), so 1-2s of window creation is imperceptible.

---

## Debug Hotkey (removed)

During development, a temporary `Ctrl+Alt+L` hotkey was added to toggle
the loading indicator on/off for visual verification. This hotkey was
**removed** before the final build. The loading indicator now appears and
disappears purely based on the Worker request/response lifecycle.

---

## Testing Checklist

### Build verification

- [x] Frontend build (`npm run build`) succeeds — `loading.html` and
      its JS/CSS chunks are emitted to `frontend/dist/`
- [x] Rust build (`cargo build --release`) succeeds — no errors, only
      the pre-existing `architect` dead-code warning
- [x] `loading.json` and `wakeup.json` are in `frontend/dist/`
- [x] `loading-cap` is registered in `tauri.conf.json`

### Runtime verification

- [x] App launches successfully (~42 MB RAM at idle)
- [x] All services online (STT, TTS, Cloudflare Worker, GitHub)
- [x] Wake word detection works (Ctrl+Space or "nexus")
- [x] Long-running query triggers "On it sir" acknowledgment
- [x] Loading animation appears at top-right corner after orb hides
- [x] Loading animation is fully transparent (no background, no blur,
      no border)
- [x] Loading animation is click-through (mouse clicks pass through)
- [x] Loading animation disappears when Worker responds
- [x] Sidebar appears and "Here is the analysis, sir" plays
- [x] Loading animation disappears on error/done/cancel/timeout
- [x] Loading animation disappears on barge-in (Ctrl+Space)
- [x] No deadlock — Worker response reaches frontend reliably

### Edge cases

- [x] Duplicate long-running command (same transcript) — dedup, no
      re-send, loading stays visible
- [x] Queued long-running command (different transcript) — queued,
      loading re-shows when previous result arrives
- [x] Worker timeout (60s) — loading hides, in-flight flag clears
- [x] User barges in during processing — loading hides, orb reappears
- [x] User cancels during processing — loading hides, session resets

---

## Files Changed

### New files

| File | Purpose |
|------|---------|
| `frontend/loading.html` | HTML entry point for the loading window |
| `frontend/src/loading/LoadingApp.tsx` | React component that loads and renders the Lottie animation |
| `frontend/src/loading/main.tsx` | React entry point (mounts `LoadingApp` into `#root`) |
| `frontend/src/loading/loading.css` | Transparent, borderless, click-through CSS |
| `frontend/src/loading/loadingController.ts` | Frontend helpers for showing/hiding the indicator via Tauri IPC |
| `src-tauri/capabilities/loading-cap.json` | Tauri capability for the `loading-indicator` window |
| `frontend/public/wakeup.json` | Renamed from `loading.json` — orb/wake animation |
| `frontend/public/loading.json` | Renamed from `analyzing.json` — loading indicator animation |

### Modified files

| File | Change |
|------|--------|
| `frontend/src/avatar/Avatar.tsx` | Changed `fetch("/loading.json")` → `fetch("/wakeup.json")` |
| `frontend/vite.config.ts` | Added `loading.html` to Rollup multi-page input |
| `frontend/src/audio/recorder.ts` | Added `showLoadingIndicator()` after "On it sir" TTS finishes (2 code paths) + in `processNextQueuedCommand()` |
| `frontend/src/net/wsBridge.ts` | Added `hideLoadingIndicator()` in result/done/error handlers + 60s timeout + 120ms compositor delay |
| `frontend/src/main.tsx` | Added `hideLoadingIndicator()` in `__NEXUS_CANCEL__` and `startListening()` (barge-in) |
| `src-tauri/src/dyn_windows.rs` | Added `WindowConfig::loading_indicator()` (80×80, transparent, click-through) |
| `src-tauri/src/commands.rs` | Added `show_loading_indicator` (async) and `hide_loading_indicator` (async) IPC commands |
| `src-tauri/src/lib.rs` | Registered both commands in `invoke_handler` |
| `src-tauri/tauri.conf.json` | Added `"loading-cap"` to capabilities array |
| `src-tauri/src/hotkey.rs` | Added and then removed `Ctrl+Alt+L` debug hotkey |

---

## Lessons Learned

### 1. Tauri v2 window creation MUST be async on Windows

`WebviewWindowBuilder::build()` deadlocks on Windows when called from a
synchronous Tauri command. This is documented but easy to miss. **Always
use `pub async fn` for any command that creates a window.**

### 2. Tauri v2 capabilities MUST be explicitly registered

Creating a capability JSON file in `src-tauri/capabilities/` is not
enough. The capability must be listed in `tauri.conf.json` under
`app.security.capabilities`. Tauri v2 silently ignores unregistered
capability files — no error, no warning, just missing permissions.

### 3. Fire-and-forget vs await for hide

The initial implementation `await`ed `hideLoadingIndicator()` in the
result handler to ensure the loading window was gone before the sidebar
appeared. This worked but added unnecessary latency. The final
implementation uses `void hideLoadingIndicator()` (non-blocking) with a
120ms `setTimeout` delay, which gives the OS compositor time to remove
the window without blocking the result handler.

### 4. DWM corner rounding is not always desirable

The sidebar and architect-sidebar get DWM corner rounding
(`DWMWCP_ROUND`) to match their CSS `border-radius`. The loading
indicator deliberately does NOT get corner rounding because:
- The 80×80 window is too small for rounded corners to look good
- Rounded corners would clip the Lottie animation
- The animation itself doesn't have rounded corners

### 5. CSS `border: none !important` on every element

Even though the CSS had no explicit border, WebView2 can add a default
border in some configurations. Adding `border: none !important; outline:
none !important;` on `html`, `body`, `#root`, `#loading-app`, and the
Lottie SVG ensures no visual border appears under any circumstance.
