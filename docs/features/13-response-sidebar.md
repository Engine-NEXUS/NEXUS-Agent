# Feature 13 — Response Sidebar

> **Window label:** `sidebar`
> **Size:** 280x500 (bottom-right of screen)
> **Entry point:** `frontend/sidebar.html` → `frontend/src/sidebar/main.tsx` → `SidebarApp.tsx`
> **Added in:** commit `03a34ad` (PR #16)

---

## Overview

A transparent window on the right edge of the screen that displays server responses from n8n/Ollama/Hermes. It slides in from the right edge ONLY when a request is sent to the remote server — NOT for local commands.

This is separate from the main orb window (200x200, bottom-center) which shows for all interactions.

---

## When It Appears

| Scenario | Sidebar Shows? | Orb Shows? |
|----------|---------------|------------|
| Server request (n8n/Ollama) | Yes | Yes |
| Local command (open app) | No | Yes |
| Tier 3 acoustic command | No | Yes |
| Backend unavailable | No | Yes |
| Empty transcript | No | No (hides) |
| STT failure | No | No (hides) |

---

## Visual Design

### Layout
```
┌─────────────────────────┐
│  NEXUS           ●      │  ← Header: gradient logo + status dot
├─────────────────────────┤
│                         │
│  Thinking ...           │  ← Loading state with animated dots
│  ●  ●  ●                │
│                         │
│  ── OR ──               │
│                         │
│  The weather in SF is   │  ← Response text (auto-scrolling)
│  72°F and sunny with    │
│  light winds from the   │
│  west.                  │
│                         │
└─────────────────────────┘
```

### Card
- 260px wide white card
- 16px border radius (`--nx-radius-lg`)
- Subtle shadow (`--nx-shadow-lg`)
- 1px border (`--nx-border`)
- 8px margin from right edge of screen

### Header
- "NEXUS" in gradient text (blue → purple)
- Status dot:
  - Blue pulsing dot while loading (thinking)
  - Green dot when response is complete

### Loading State
- "Thinking" text in secondary color
- Three bouncing dots animation (blue, staggered 0.2s apart)

### Response Text
- 14px font size (`--nx-text-sm`)
- 1.5 line height
- Primary text color (`--nx-text-primary`)
- Pre-wrap whitespace (preserves line breaks)
- Word-wrap break-word
- Max height 380px with auto-scroll
- Thin scrollbar (4px, border color)

---

## Animation

### Slide In (show)
```css
#sidebar-app.sidebar--visible {
  transform: translateX(0);
  opacity: 1;
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease;
}
```
Bouncy spring overshoot — fast and neat, matching the orb's slide-up animation.

### Slide Out (hide)
```css
#sidebar-app.sidebar--hidden {
  transform: translateX(100vw);
  opacity: 0;
  pointer-events: none;
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.7, 1), opacity 0.15s ease 0.25s;
}
```
Smooth gravity ease-in, opacity fades at the very end.

### Native Window Visibility
- **Show:** `invoke("show_sidebar")` called immediately when `visible` becomes true
- **Hide:** `invoke("hide_sidebar")` delayed by 400ms to let the CSS slide-out animation finish

---

## Window Configuration

```json
{
  "label": "sidebar",
  "title": "NEXUS Response",
  "width": 280,
  "height": 500,
  "resizable": false,
  "decorations": false,
  "transparent": true,
  "alwaysOnTop": true,
  "skipTaskbar": true,
  "shadow": false,
  "focus": false,
  "visible": false,
  "url": "sidebar.html"
}
```

### Key Properties
- **`transparent: true`** — only the white card is visible, the rest of the window is see-through
- **`decorations: false`** — no title bar, no borders, no system buttons
- **`alwaysOnTop: true`** — appears above other windows (like a notification)
- **`skipTaskbar: true`** — doesn't appear in the Windows taskbar
- **`focus: false`** — doesn't steal focus from the user's current window
- **`visible: false`** — hidden on startup, shown via `show_sidebar` IPC

---

## Positioning

The sidebar is positioned at the bottom-right of the screen, above the taskbar:

```rust
let sidebar_w = 280;
let sidebar_h = 500;
let x = screen.width - sidebar_w - gap;      // 12px from right edge
let y = screen.height - sidebar_h - taskbar - gap;  // 48px taskbar + 12px gap
```

### DPI Awareness
The positioning accounts for the monitor's scale factor:
```rust
let scale = monitor.scale_factor();
let phys_w = (sidebar_w as f64 * scale) as i32;
let phys_h = (sidebar_h as f64 * scale) as i32;
```

### Platform-Specific Taskbar Height
- Windows: 48px * scale
- macOS: 70px * scale (dock)

---

## Event Communication

Since each Tauri window has its own JavaScript context, the main window and sidebar window communicate via Tauri events.

### Main Window → Sidebar Window

| Event | Payload | Trigger |
|-------|---------|---------|
| `sidebar:show` | `{ query: string }` | `sendTranscript()` succeeds |
| `sidebar:response` | `{ text: string }` | Server `result` event |
| `sidebar:hide` | `{}` | Server `done` or `error` event |

### Event Flow
```
Main window                          Sidebar window
──────────                           ───────────────
sendTranscript() ──┐
                    │ emit "sidebar:show"
                    ├──────────────────────────► listen → show()
                    │                            │ → invoke("show_sidebar")
                    │                            │ → slide in from right
                    │                            │ → "Thinking..." dots
Server result ──────┤
                    │ emit "sidebar:response"
                    ├──────────────────────────► listen → setResponse()
                    │                            │ → show response text
                    │                            │ → green status dot
Server done ────────┤
                    │ emit "sidebar:hide"
                    └──────────────────────────► listen → hide()
                                                 │ → slide out to right
                                                 │ → invoke("hide_sidebar") (400ms delay)
```

---

## Zustand Store

### `frontend/src/sidebar/sidebarStore.ts`

```typescript
interface SidebarState {
  visible: boolean;      // Is the sidebar showing?
  response: string;      // Server response text
  query: string;         // User's original query
  loading: boolean;      // Waiting for server response?
  show: (query: string) => void;        // Show sidebar with query
  setResponse: (text: string) => void;  // Set the response text
  setLoading: (loading: boolean) => void;
  hide: () => void;      // Hide and reset
}
```

---

## Integration with wsBridge

### `frontend/src/net/wsBridge.ts`

Three helper functions emit events to the sidebar window:

```typescript
async function emitSidebarShow(query: string): Promise<void>
async function emitSidebarResponse(text: string): Promise<void>
async function emitSidebarHide(): Promise<void>
```

### Trigger Points

1. **`sendTranscript(text)`** — after successful send to server:
   ```typescript
   await tauriInvoke("send_transcript", { text });
   await emitSidebarShow(text);  // ← sidebar appears
   ```

2. **`handle(ev)` → `case "result"`** — when server responds:
   ```typescript
   if (ev.data) {
     store.addAssistantMessage(ev.data);
     void emitSidebarResponse(ev.data);  // ← sidebar shows response
     void speak(ev.data, ...);
   }
   ```

3. **`handle(ev)` → `case "done"`** — when server completes:
   ```typescript
   sessionOpen = false;
   stopTts();
   store.reset();
   void emitSidebarHide();  // ← sidebar hides
   ```

4. **`handle(ev)` → `case "error"`** — on server error:
   ```typescript
   void emitSidebarHide();  // ← sidebar hides on error too
   ```

---

## File Structure

```
frontend/
├── sidebar.html                      # HTML entry point
└── src/sidebar/
    ├── main.tsx                      # React entry (renders SidebarApp)
    ├── SidebarApp.tsx                # Main component (100 lines)
    ├── sidebarStore.ts               # Zustand store (34 lines)
    └── sidebar.css                   # White theme styles (173 lines)

src-tauri/src/
├── commands.rs                       # show_sidebar, hide_sidebar IPC (60 lines)
└── lib.rs                            # Command registration
```

---

## Rust IPC Commands

### `show_sidebar`
Positions the sidebar at bottom-right of the screen and shows it.

```rust
#[tauri::command]
pub fn show_sidebar<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let win = app.get_webview_window("sidebar")?;
    // Position at bottom-right
    if let Ok(Some(monitor)) = win.current_monitor() {
        let scale = monitor.scale_factor();
        let screen = monitor.size();
        let x = screen.width as i32 - (280 * scale) as i32 - (12 * scale) as i32;
        let y = screen.height as i32 - (500 * scale) as i32 - (48 * scale) as i32 - (12 * scale) as i32;
        win.set_position(PhysicalPosition::new(x, y));
    }
    win.show()?;
    Ok(())
}
```

### `hide_sidebar`
Hides the sidebar window.

```rust
#[tauri::command]
pub fn hide_sidebar<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let win = app.get_webview_window("sidebar")?;
    win.hide()?;
    Ok(())
}
```

Both are registered in `lib.rs`:
```rust
.invoke_handler(tauri::generate_handler![
    // ... existing commands ...
    commands::show_sidebar,
    commands::hide_sidebar,
])
```

---

## Design Decisions

### Why a separate window?
The orb is at bottom-center (200x200). The sidebar is at bottom-right (280x500). They're in different positions and have different sizes. A separate Tauri window allows independent positioning, animation, and lifecycle.

### Why Tauri events instead of shared state?
Zustand stores are per-window — they don't cross window boundaries. Tauri's event system (`@tauri-apps/api/event`) is the official way to communicate between windows.

### Why only for server responses?
Local commands (open app, search) are instant (~200ms) and don't need a visual response panel. Server responses take longer (2-30s) and contain rich text that benefits from a dedicated display area. The sidebar acts like a notification panel for AI responses.

### Why `alwaysOnTop`?
The sidebar should be visible above other windows when a server response arrives, similar to a notification toast. The user might be working in another app when NEXUS responds.

### Why `focus: false`?
The sidebar shouldn't steal keyboard focus from whatever the user is doing. It appears passively as a visual notification.

### Why 280x500?
- 280px wide: enough to display response text comfortably without wrapping every 3 words
- 500px tall: enough for multi-paragraph responses, with auto-scroll for longer ones
- Positioned at bottom-right: doesn't obstruct the main work area (usually center/left)

---

## Performance

The sidebar window is created at startup but hidden (`visible: false`). It uses minimal resources:
- No CPU when hidden (the webview is paused)
- No network activity (events are local IPC)
- ~5-10 MB additional RAM for the webview context
