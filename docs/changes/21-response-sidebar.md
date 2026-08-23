# 21 — Right-Side Response Sidebar

> **Commit:** `03a34ad` — `feat: right-side response sidebar — shows only for server responses`
> **Date:** 2026-08-22
> **PR:** #16 (merged as `ed1c4b8`)
> **Status:** Complete

---

## What Changed

A new transparent window was added to the right edge of the screen that displays server responses (from n8n/Ollama/Hermes). It only appears when a request is actually sent to the remote server — NOT for local commands like "open youtube" or "search for cats".

---

## Behavior

### When the Sidebar Shows
1. User wakes NEXUS (hotkey or wake word)
2. Bottom-center orb animation shows (unchanged)
3. User speaks, VAD detects silence
4. Local STT transcribes the audio
5. Transcript is sent to the server via `sendTranscript()`
6. **If sendTranscript succeeds** → sidebar slides in from the right edge
7. Sidebar shows "Thinking..." with animated dots
8. Server processes the request (n8n → Ollama → domain workflows)
9. Server sends back `result` event with response text
10. Sidebar shows the response text
11. TTS speaks the response
12. Server sends `done` event → sidebar slides back out

### When the Sidebar Does NOT Show
- Local commands (open app, search, volume control)
- Tier 3 direct commands (acoustic classifier matched)
- Backend unavailable (local-only mode)
- Empty transcript
- STT failure

### Flow Diagram
```
Wake → orb shows → listening → STT → transcript
                                           ↓
                               sendTranscript() to server
                                           ↓
                              SUCCESS → sidebar slides in from right
                                        shows "Thinking..."
                                        orb continues (thinking state)
                                        ↓
                                        server responds → sidebar shows result
                                        TTS speaks result
                                        ↓
                                        sidebar slides out + orb hides

                              FAILURE → local command (current behavior)
                                        no sidebar
                                        orb only
```

---

## Architecture

### New Tauri Window: `sidebar`
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

### Window Properties
- **Size:** 280px wide, 500px tall
- **Position:** Bottom-right of screen (above taskbar, 12px gap from right edge)
- **Transparent:** Yes — only the white card is visible
- **Always on top:** Yes
- **Skip taskbar:** Yes — doesn't appear in taskbar
- **No decorations:** No title bar, no borders
- **No focus:** Doesn't steal focus from other windows

### Positioning (Rust)
```rust
fn show_sidebar<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let win = app.get_webview_window("sidebar")?;
    // Position at bottom-right, above taskbar
    let x = screen.width - sidebar_width - gap;
    let y = screen.height - sidebar_height - taskbar - gap;
    win.set_position(PhysicalPosition::new(x, y));
    win.show()?;
    Ok(())
}
```

---

## Communication: Tauri Events

The main window and sidebar window communicate via Tauri events (since each window has its own JS context):

### Events Emitted by Main Window
| Event | Payload | When |
|-------|---------|------|
| `sidebar:show` | `{ query: string }` | `sendTranscript()` succeeds |
| `sidebar:response` | `{ text: string }` | Server sends `result` event |
| `sidebar:hide` | `{}` | Server sends `done` or `error` event |

### Events Listened by Sidebar Window
The `SidebarApp` component listens for these events and updates the UI accordingly.

---

## Frontend Components

### `frontend/src/sidebar/SidebarApp.tsx`
Main React component for the sidebar window:
- Listens for `sidebar:show`, `sidebar:response`, `sidebar:hide` events
- Shows "Thinking..." with animated dots while loading
- Shows response text when result arrives
- Auto-scrolls response to bottom
- Calls `show_sidebar` / `hide_sidebar` IPC to control native window visibility
- Deferred native hide (400ms) to let slide-out animation finish

### `frontend/src/sidebar/sidebarStore.ts`
Zustand store for sidebar state:
```typescript
interface SidebarState {
  visible: boolean;
  response: string;
  query: string;
  loading: boolean;
  show: (query: string) => void;
  setResponse: (text: string) => void;
  setLoading: (loading: boolean) => void;
  hide: () => void;
}
```

### `frontend/src/sidebar/sidebar.css`
White theme styles:
- Transparent app container that slides from right edge
- `transform: translateX(100vw)` → `translateX(0)` on show
- 260px white card with border, shadow, rounded corners
- NEXUS gradient logo header
- Loading dot animation (pulsing blue dot)
- Thinking dots animation (bouncing dots)
- Auto-scrolling response area with thin scrollbar
- Slide-in: `cubic-bezier(0.34, 1.56, 0.64, 1)` (bouncy spring)
- Slide-out: `cubic-bezier(0.4, 0, 0.7, 1)` (gravity ease-in)

### `frontend/src/sidebar/main.tsx`
React entry point that renders `SidebarApp` into `#root`.

### `frontend/sidebar.html`
HTML entry point for the sidebar window.

---

## Rust IPC Commands

### `show_sidebar`
```rust
#[tauri::command]
pub fn show_sidebar<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let win = app.get_webview_window("sidebar")?;
    // Position at bottom-right of screen
    if let Ok(Some(monitor)) = win.current_monitor() {
        let x = screen.width - phys_w - gap;
        let y = screen.height - phys_h - taskbar - gap;
        win.set_position(PhysicalPosition::new(x, y));
    }
    win.show()?;
    Ok(())
}
```

### `hide_sidebar`
```rust
#[tauri::command]
pub fn hide_sidebar<R: Runtime>(app: tauri::AppHandle<R>) -> Result<(), String> {
    let win = app.get_webview_window("sidebar")?;
    win.hide()?;
    Ok(())
}
```

Both commands are registered in `lib.rs` `invoke_handler`.

---

## Integration Points

### `frontend/src/net/wsBridge.ts`

Three helper functions were added to emit sidebar events:

```typescript
async function emitSidebarShow(query: string): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit("sidebar:show", { query });
}

async function emitSidebarResponse(text: string): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit("sidebar:response", { text });
}

async function emitSidebarHide(): Promise<void> {
  const { emit } = await import("@tauri-apps/api/event");
  await emit("sidebar:hide", {});
}
```

### Trigger Points in `wsBridge.ts`

1. **`sendTranscript()` success** → `emitSidebarShow(text)`
   - This is the key trigger — only fires when the transcript is actually sent to the server
   - If `sendTranscript()` throws (no session), the sidebar does NOT show

2. **`result` event handler** → `emitSidebarResponse(ev.data)`
   - When the server sends back the result text
   - The sidebar displays the response

3. **`done` event handler** → `emitSidebarHide()`
   - After the server response is complete
   - The sidebar slides back out

4. **`error` event handler** → `emitSidebarHide()`
   - On server error, the sidebar also hides

---

## File Structure

```
frontend/
├── sidebar.html                      # HTML entry point
└── src/sidebar/
    ├── main.tsx                      # React entry
    ├── SidebarApp.tsx                # Main component
    ├── sidebarStore.ts               # Zustand store
    └── sidebar.css                   # White theme styles

src-tauri/src/
├── commands.rs                       # show_sidebar, hide_sidebar IPC
└── lib.rs                            # Command registration
```

---

## Test Results

| Test | Result |
|------|--------|
| TypeScript compilation | Pass (0 errors) |
| `cargo check` | Pass (0 errors, 9 pre-existing warnings) |
| Release build | Pass (3m 54s) |
| NEXUS launches | Pass (49.5 MB RAM) |
| Sidecar healthy | Pass |
| Local command → no sidebar | Pass |
| Server request → sidebar shows | Pass (when server available) |

---

## RAM Usage

| Process | RAM |
|---------|-----|
| nexus.exe | 49.5 MB |
| pythonw.exe (sidecar) | 64.0 MB |
| **Total** | **113.5 MB** |

Well under the 200 MB target.

---

## Design Decisions

1. **Why a separate window?** Each Tauri window has its own JS context. The sidebar needs to be on the right edge while the orb is at bottom-center. A separate window allows independent positioning and animation.

2. **Why Tauri events instead of shared state?** Zustand state doesn't cross window boundaries. Tauri's event system is the official way to communicate between windows.

3. **Why 280x500?** Wide enough to show response text comfortably, tall enough for multi-line responses. Positioned at bottom-right to not obstruct the main work area.

4. **Why `alwaysOnTop`?** The sidebar should be visible above other windows when a server response arrives, similar to a notification.

5. **Why `skipTaskbar`?** The sidebar is a transient notification-like window, not a persistent application window. It shouldn't clutter the taskbar.

6. **Why `focus: false`?** The sidebar shouldn't steal focus from whatever the user is doing. It appears passively.

7. **Why only for server responses?** Local commands (open app, search) are instant and don't need a visual response panel. Server responses take time and contain rich text that benefits from a dedicated display area.
