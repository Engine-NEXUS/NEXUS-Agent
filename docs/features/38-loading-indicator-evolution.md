# Loading Indicator Evolution — Separate Window → In-Orb

**Date:** 2026-09-02 (remote refactor) integrated 2026-09-03
**Commits:**
- `1527b02 feat: loading indicator overlay — transparent click-through animation`
- `bab1b95 refactor: render loading indicator inside Orb to fix Wayland click-through bug and save RAM`
- `e2b54ab feat: integrate Piper TTS + self-learning STT + fuzzy matching with remote refactor`

**Status:** Production (in-orb rendering)

---

## Problem Statement

When NEXUS acknowledges a command with "On it sir" and starts processing,
the user needs visual feedback that the system is working. The requirements:

- Show a loading animation during Worker processing (2-40 seconds)
- Don't block the user from interacting with other windows
- Don't steal keyboard focus
- Work on all platforms (Windows, macOS, Linux/Wayland)
- Minimal RAM impact
- Smooth animation (60fps)
- Disappear instantly when the response arrives

---

## Approach 1: No Loading Indicator (Original)

The earliest versions of NEXUS had no loading feedback. After "On it sir":
- The orb disappeared
- The user stared at nothing for 2-40 seconds
- The response appeared in the sidebar

**Problem:** Users thought the app had crashed. They would say "nexus"
again, causing duplicate commands.

---

## Approach 2: Sidebar "Thinking..." Text

**Date:** ~2026-08-29

### What It Was
The sidebar showed a "Thinking..." text message while the Worker processed.

### Why It Was Insufficient
- The sidebar wasn't always open
- Opening the sidebar just to show "Thinking..." was heavy (250 MB WebView2)
- Text doesn't convey progress — users didn't know if it was 2s or 40s
- No visual indication in the orb area

---

## Approach 3: Separate Loading Window (Lottie Overlay)

**Commit:** `1527b02 feat: loading indicator overlay — transparent click-through animation`
**Date:** ~2026-08-31

### Architecture
```
┌──────────────────────────────────────────┐
│  Orb Window (main)                       │
│  ┌─────┐                                 │
│  │ Orb │                                 │
│  └─────┘                                 │
│                                          │
│  ┌──────────────────────────────────┐    │
│  │ Loading Indicator Window         │    │  ← Separate Tauri window
│  │ (transparent, click-through,     │    │     (alwaysOnTop, skipTaskbar)
│  │  alwaysOnTop, Lottie animation)  │    │
│  └──────────────────────────────────┘    │
└──────────────────────────────────────────┘
```

### Implementation

#### Rust Side
```rust
// dyn_windows.rs
pub fn WindowConfig::loading_indicator() -> WindowConfig {
    WindowConfig {
        label: "loading-indicator",
        url: "loading.html",
        transparent: true,
        always_on_top: true,
        skip_taskbar: true,
        focus: false,
        decorations: false,
        // ... position at top-right corner
    }
}

// commands.rs
#[tauri::command]
pub fn show_loading_indicator(app: AppHandle) {
    dyn_windows::get_or_create_window(&app, "loading-indicator");
}

#[tauri::command]
pub fn hide_loading_indicator(app: AppHandle) {
    dyn_windows::destroy_window(&app, "loading-indicator");
}
```

#### Frontend Side
```typescript
// loading/loadingController.ts
export function showLoadingIndicator() {
    invoke("show_loading_indicator");
}
export function hideLoadingIndicator() {
    invoke("hide_loading_indicator");
}

// loading/main.tsx — Lottie animation
<Lottie
    animationData={loadingAnimation}
    loop={true}
    style={{ width: 60, height: 60 }}
/>
```

#### Vite Config
```typescript
// vite.config.ts
rollupOptions: {
    input: {
        main: "index.html",
        // ... other windows
        loading: resolve(__dirname, "loading.html"),  // ← separate entry
    },
}
```

#### Tauri Config
```json
// tauri.conf.json
"capabilities": ["main-cap", "sidebar-cap", "architect-cap", "loading-cap"]
```

### Why It Was Problematic

#### 1. Wayland Click-Through Bug (Linux)
On Linux/Wayland, transparent click-through windows don't work properly.
The loading indicator window intercepted mouse clicks even though it was
supposed to be click-through. This meant the user couldn't click on
anything behind the loading animation.

**Root cause:** Wayland's security model doesn't allow windows to receive
no input events while being visible. X11 had `XShapeCombineRectangles`
for this, but Wayland removed it.

#### 2. Extra WebView2 Process (Windows)
Each Tauri window spawns a separate WebView2 process tree (~7 processes,
~250 MB RAM). The loading indicator window was visible for only 2-40
seconds but consumed full RAM during that time.

| Component | RAM |
|-----------|-----|
| Orb WebView2 | 35.8 MB |
| Loading WebView2 | ~40 MB |
| **Overhead** | **~40 MB wasted** |

#### 3. Synchronization Complexity
Two separate windows meant two separate React trees. Synchronizing the
loading state between them required:
- Tauri commands (`show_loading_indicator`, `hide_loading_indicator`)
- Tauri events (`loading:show`, `loading:hide`)
- Frontend controller (`loadingController.ts`)
- Timing delays (120ms sleep to let the orb hide before showing loading)

This created race conditions:
- Sometimes the loading indicator appeared before the orb hid (visual overlap)
- Sometimes the response appeared before the loading indicator hid (flicker)
- Sometimes the loading indicator stayed visible after the response (stuck state)

#### 4. macOS Vibrancy Conflict
The loading window's `transparent: true` + `alwaysOnTop: true` triggered
the same macOS vibrancy issues as the sidebar (see AGENTS.md). On macOS,
the window would render with a solid black background instead of transparent.

---

## Approach 4: In-Orb Loading Animation (Current)

**Commit:** `bab1b95 refactor: render loading indicator inside Orb to fix Wayland click-through bug and save RAM`
**Date:** 2026-09-02 (remote branch)

### Architecture
```
┌──────────────────────────────────────────┐
│  Orb Window (main) — single window       │
│  ┌─────┐                                 │
│  │ Orb │                                 │
│  │  ↓  │  ← Loading state rendered       │
│  │ ⟳  │     inside the same React tree   │
│  └─────┘                                 │
└──────────────────────────────────────────┘
```

### What Changed

#### Removed
- `frontend/loading/loadingController.ts` — deleted
- `frontend/loading/main.tsx` — deleted
- `frontend/loading.html` — deleted
- `src-tauri/src/dyn_windows.rs::WindowConfig::loading_indicator()` — removed
- `src-tauri/src/commands.rs::show_loading_indicator()` — removed
- `src-tauri/src/commands.rs::hide_loading_indicator()` — removed
- `src-tauri/capabilities/loading-cap.json` — removed
- `vite.config.ts` loading entry — removed
- `tauri.conf.json` loading-cap capability — removed

#### Added
- Loading animation rendered inside `App.tsx` (the orb's React tree)
- State-driven: `useAssistant.getState().state === "thinking"`
- CSS animation (no Lottie dependency for the orb state)

### Implementation

#### Frontend (`App.tsx`)
```tsx
function OrbContent() {
    const state = useAssistant(s => s.state);

    return (
        <div className="orb-container">
            {state === "idle" && <IdleAnimation />}
            {state === "listening" && <ListeningAnimation />}
            {state === "thinking" && <LoadingAnimation />}  {/* ← NEW */}
            {state === "speaking" && <SpeakingAnimation />}
            {state === "responding" && <ResponseAnimation />}
        </div>
    );
}
```

#### State Flow
```
1. User says command
2. STT transcribes → parser validates
3. speakCached("On it sir") → state = "speaking"
4. TTS finishes → state = "thinking"     ← Loading animation shows
5. Worker processes (2-40s)               ← Animation continues
6. Response arrives → state = "responding" ← Loading hides, response shows
7. TTS speaks response → state = "speaking"
8. TTS finishes → state = "idle"
```

### Why This Is Better

| Criterion | Separate Window | In-Orb | Improvement |
|-----------|----------------|--------|-------------|
| Wayland click-through | ❌ Broken | ✅ No separate window | Fixed |
| RAM overhead | ~40 MB | 0 MB | **40 MB saved** |
| Process count | +7 WebView2 | 0 | **7 fewer processes** |
| Synchronization | Complex (events, timing) | Trivial (React state) | **Simplified** |
| Race conditions | Multiple | None | **Eliminated** |
| macOS transparency | ❌ Black background | ✅ Works | Fixed |
| Visual overlap | Possible | Impossible | **Eliminated** |
| Code complexity | 5 files + controller | 1 state check | **Reduced** |

### Integration Notes (2026-09-03)

When we integrated the Piper TTS and self-learning STT changes with this
remote refactor, we had to:

1. **Remove all references to the old loading window:**
   - `loadingController` imports in `main.tsx`
   - `showLoadingIndicator` / `hideLoadingIndicator` calls in `recorder.ts`
   - `loading.html` entry in `vite.config.ts`
   - `loading-cap` in `tauri.conf.json` capabilities

2. **Adapt the acknowledgement flow:**
   - Old: `showLoadingIndicator()` after "On it sir"
   - New: Just set `state = "thinking"` (the orb handles the rest)

3. **Fix broken comment+code-on-same-line issues:**
   The remote refactor had accidentally merged some comments and code onto
   the same line in `recorder.ts` and `wsBridge.ts`:
   ```typescript
   // Before (broken):
   // Re-show the loading indicator for this queued command.  void sendTranscript(next).then(() => {

   // After (fixed):
   // Re-show the loading indicator for this queued command.
   void sendTranscript(next).then(() => {
   ```

---

## Files Changed

| File | Change |
|------|--------|
| `frontend/src/App.tsx` | Added "thinking" state rendering |
| `frontend/src/loading/loadingController.ts` | **Deleted** |
| `frontend/loading.html` | **Deleted** |
| `frontend/vite.config.ts` | Removed loading entry from rollupOptions |
| `frontend/src/main.tsx` | Removed loadingController import |
| `frontend/src/audio/recorder.ts` | Removed show/hide loading calls |
| `frontend/src/net/wsBridge.ts` | Removed show/hide loading calls |
| `src-tauri/src/dyn_windows.rs` | Removed `WindowConfig::loading_indicator()` |
| `src-tauri/src/commands.rs` | Removed `show_loading_indicator`, `hide_loading_indicator` |
| `src-tauri/tauri.conf.json` | Removed `loading-cap` from capabilities |
| `src-tauri/capabilities/loading-cap.json` | **Deleted** |

## Lessons Learned

1. **Fewer windows = fewer problems.** Every Tauri window is a separate
   WebView2/WKWebView process tree. Each adds RAM, synchronization complexity,
   and platform-specific bugs. Use the minimum number of windows possible.

2. **Wayland changes the rules.** What works on X11 (click-through windows)
   may not work on Wayland. Design for Wayland from the start, not as an
   afterthought.

3. **State > events for UI synchronization.** Using a single React state
   store (`useAssistant`) to drive all visual states is simpler and more
   reliable than cross-window event passing.

4. **Don't create windows for ephemeral UI.** A loading indicator that
   shows for 2-40 seconds doesn't justify a permanent window. Render it
   inside an existing window instead.

5. **Test on all platforms early.** The separate loading window worked
   fine on Windows but broke on Wayland. If we had tested on Linux earlier,
   we would have caught this before it shipped.
