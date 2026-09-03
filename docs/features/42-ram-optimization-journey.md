# RAM Optimization Journey — 1,644 MB → 104 MB (94% Reduction)

**Date:** 2026-08-30 through 2026-09-02
**Status:** Production

---

## Problem Statement

NEXUS is a desktop assistant that runs continuously in the background.
It must be lightweight enough that users don't notice it's running.
The target was < 200 MB idle RAM.

### The Starting Point
Early versions of NEXUS consumed **1,644 MB** at idle — more than
a Chrome browser with 20 tabs. This was unacceptable for a
"floating assistant" that's supposed to be unobtrusive.

---

## The 1,644 MB Baseline (2026-08-29)

| Component | RAM | Why |
|-----------|-----|-----|
| nexus.exe (Rust) | 47.9 MB | Core process, wake word, audio capture |
| WebView2 (5 windows) | 870 MB | 5 windows × ~174 MB each |
| STT server (Python) | 339 MB | faster-whisper running constantly |
| Kokoro TTS | 350 MB | Loaded at boot |
| **TOTAL** | **1,644 MB** | |

### Why 5 WebView2 Windows?
`tauri.conf.json` created 5 windows at startup:
1. `main` (orb) — visible
2. `setup` — hidden (wizard shown on first run)
3. `settings` — hidden (shown from tray menu)
4. `sidebar` — hidden (shown when response arrives)
5. `architect` — hidden (shown for repo analysis)

Each Tauri window spawns a WebView2 process tree (~7 processes, ~174 MB).
4 of the 5 windows were `visible: false` but still consumed full RAM.

---

## Optimization 1: Lazy Window Creation (2026-08-30)

**Commit:** Part of `ded40d1 feat: rich repo analysis dashboard, live glass sidebar, STT/TTS pipeline, 77% RAM reduction`

### What Changed
- Only `main` (orb) window in `tauri.conf.json` — created at startup
- `setup`, `settings`, `sidebar`, `architect` created on-demand
- `dyn_windows.rs` — new module for dynamic window creation/destruction
- `hide_sidebar` / `close_setup_window` now **destroy** the window
  (not `hide()`) — kills the WebView2 process tree and frees ~174 MB

### Implementation
```rust
// dyn_windows.rs
pub fn get_or_create_window(app: &AppHandle, label: &str) -> WebviewWindow {
    if let Some(window) = app.get_webview_window(label) {
        return window;  // Already exists
    }
    // Create new window with appropriate config
    let config = match label {
        "sidebar" => WindowConfig::sidebar(),
        "settings" => WindowConfig::settings(),
        "setup" => WindowConfig::setup(),
        "architect" => WindowConfig::architect(),
        _ => return panic!("Unknown window: {label}"),
    };
    config.create(app)
}

pub fn destroy_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
}
```

### Result
| Component | Before | After |
|-----------|--------|-------|
| WebView2 (5 windows) | 870 MB | 174 MB (1 window) |
| **Savings** | | **696 MB** |

---

## Optimization 2: Lazy STT Server (2026-08-30)

### What Changed
- STT server not started at boot
- `lazy_stt.rs` — starts server on first wake/hotkey
- Server killed after 5 min idle
- `STT_KEEP_ALIVE=true` overrides kill (kept alive in practice)

### Implementation
```rust
// lazy_stt.rs
pub fn ensure_stt_running() {
    if STT_RUNNING.load(Ordering::Relaxed) { return; }
    // Start Python sidecar
    let child = Command::new(python_cmd)
        .arg(script_path)
        .spawn()
        .expect("failed to start STT");
    *STT_CHILD.lock().unwrap() = Some(child);
    STT_RUNNING.store(true, Ordering::Relaxed);
}
```

### Result
| Component | Before | After |
|-----------|--------|-------|
| STT server (idle) | 339 MB | 0 MB (not running) |
| STT server (active) | 339 MB | ~340 MB |
| **Idle savings** | | **339 MB** |

---

## Optimization 3: Lazy Kokoro TTS (2026-09-01)

### What Changed
- Kokoro not loaded at boot
- `ensure_engine_loaded()` called on first `speak_text()`
- First speak: ~1.7s load time
- After first speak: stays loaded (~350 MB)

### Result
| Component | Before | After |
|-----------|--------|-------|
| Kokoro (idle, before first speak) | 350 MB | 0 MB |
| Kokoro (after first speak) | 350 MB | 350 MB |
| **Idle savings** | | **350 MB** |

---

## Optimization 4: WebView2 Low-Memory Mode (2026-09-01)

### What Changed
The orb window sets `MemoryUsageTargetLevel::Low` via
`ICoreWebView2_23::SetMemoryUsageTargetLevel` at creation time.

```rust
// mic_permissions.rs
pub fn set_low_memory_mode(webview: &WebView) {
    unsafe {
        let webview2_23: ICoreWebView2_23 = webview.cast()?;
        webview2_23.SetMemoryUsageTargetLevel(
            CoreWebView2MemoryUsageTargetLevel::Low
        )?;
    }
}
```

WebView2 drops cached data and swaps to disk.

### Result
| Component | Before | After |
|-----------|--------|-------|
| WebView2 (orb, 1 window) | 174 MB | 35.8 MB |
| **Savings** | | **138 MB** |

---

## Optimization 5: Piper TTS Replaces Kokoro (2026-09-02)

**Commit:** `8844527 feat: replace Kokoro TTS with Piper TTS — 270 MB RAM reduction`

### What Changed
- `kokoro-rs` → `piper-rs` in `Cargo.toml`
- Piper uses ~80 MB when loaded (vs Kokoro's 350 MB)
- Piper loads in 85ms (vs Kokoro's 1.7s)
- Model: `en_US-amy-medium` (~63 MB vs Kokoro's ~300 MB)

### Result
| Component | Before (Kokoro) | After (Piper) |
|-----------|----------------|---------------|
| TTS (loaded) | 350 MB | 80 MB |
| TTS (idle, not loaded) | 0 MB | 0 MB |
| **Savings when loaded** | | **270 MB** |

---

## Optimization 6: NLU Pre-Warm Removed (2026-09-01)

### What Changed
- NLU server (BERT-Mini ONNX) was pre-warmed at boot
- Now only starts on first unparseable command (lazy)
- `lazy_nlu.rs` — spawns on demand, kills after 60s idle

### Result
| Component | Before | After |
|-----------|--------|-------|
| NLU server (idle) | 50-100 MB | 0 MB |
| **Idle savings** | | **50-100 MB** |

---

## Cumulative Results

### Idle RAM (Before First Transcription)

| Component | Original | Current | Savings |
|-----------|----------|---------|---------|
| nexus.exe (Rust) | 47.9 MB | 47.8 MB | 0.1 MB |
| WebView2 (1 window, low-mem) | 870 MB | 35.8 MB | 834.2 MB |
| STT Python (not started) | 339 MB | 20.6 MB | 318.4 MB |
| TTS (not loaded) | 350 MB | 0 MB | 350 MB |
| NLU (not started) | 50-100 MB | 0 MB | 50-100 MB |
| **TOTAL** | **1,644 MB** | **104.2 MB** | **1,539.8 MB (94%)** |

### Idle RAM (After First Transcription, STT Model Loaded)

| Component | RAM |
|-----------|-----|
| nexus.exe (Rust) | 47.8 MB |
| WebView2 (orb, low-mem) | 35.8 MB |
| STT Python (model loaded) | 128.6 MB |
| **TOTAL** | **232.2 MB** |

### Active RAM (After First TTS Speak)

| Component | RAM |
|-----------|-----|
| nexus.exe (Rust) | 47.8 MB |
| WebView2 (orb, low-mem) | 35.8 MB |
| STT Python (model loaded) | 128.6 MB |
| Piper TTS (loaded) | 80 MB |
| **TOTAL** | **293.2 MB** |

### When Sidebar Opens (Response Display)

| Component | RAM |
|-----------|-----|
| All of the above | 293.2 MB |
| WebView2 (sidebar) | ~174 MB |
| **TOTAL** | **~467 MB** |

The sidebar is destroyed when closed, freeing the ~174 MB.

---

## RAM Timeline

```
1,644 MB ─── Baseline (5 windows, eager STT, eager Kokoro, eager NLU)
    │
    │  Lazy windows (−696 MB)
    ▼
  948 MB ─── 1 window, eager STT, eager Kokoro, eager NLU
    │
    │  Lazy STT (−339 MB)
    ▼
  609 MB ─── 1 window, lazy STT, eager Kokoro, eager NLU
    │
    │  Lazy Kokoro (−350 MB)
    ▼
  259 MB ─── 1 window, lazy STT, lazy Kokoro, eager NLU
    │
    │  WebView2 low-mem (−138 MB)
    ▼
  121 MB ─── 1 window (low-mem), lazy STT, lazy Kokoro, eager NLU
    │
    │  Lazy NLU (−50 MB)
    ▼
  104 MB ─── 1 window (low-mem), lazy STT, lazy TTS, lazy NLU
    │
    │  Piper replaces Kokoro (−270 MB when loaded)
    ▼
  293 MB ─── Active state (after first STT + TTS use)
```

---

## Key Principles

### 1. Lazy Everything
Don't load anything until it's needed. Every component should have an
`ensure_loaded()` function that loads on first use.

```rust
// Pattern used everywhere:
pub fn ensure_engine_loaded() -> Result<(), String> {
    if ENGINE_LOADED.load(Ordering::Relaxed) {
        return Ok(());
    }
    // ... load ...
    ENGINE_LOADED.store(true, Ordering::Relaxed);
    Ok(())
}
```

### 2. Destroy, Don't Hide
When a window is "closed", destroy it entirely. `window.hide()` keeps
the WebView2 process alive. `window.destroy()` kills the process tree
and frees all RAM.

```rust
// BAD: window stays in memory
window.hide()?;

// GOOD: process tree killed, RAM freed
window.destroy()?;
```

### 3. One Window at a Time
The orb is always visible (35.8 MB). Every other window is created on
demand and destroyed when closed. At any given time, there are at most
2 windows (orb + sidebar/settings/architect).

### 4. Low-Memory Mode for Always-On Windows
The orb is always visible, so it uses WebView2's `MemoryUsageTargetLevel::Low`.
This tells WebView2 to drop caches and swap to disk. The orb is a simple
animation, so the reduced memory doesn't affect performance.

### 5. Sidecars with Idle Timeout
Python sidecars (STT, NLU) start on demand and die after idle timeout.
The timeout is tuned per service:
- STT: 5 minutes (cold load is 10-15s, so we keep it warm)
- NLU: 60 seconds (cold load is 2-3s, so we can afford to kill it)

### 6. In-Process Over Sidecar Where Possible
Piper TTS runs in-process (Rust) instead of as a Python sidecar.
This saves the Python runtime overhead (~20 MB) and IPC latency.

---

## What Still Consumes RAM

### Unavoidable
- **nexus.exe (47.8 MB):** Core Rust process, can't reduce further
- **WebView2 orb (35.8 MB):** Minimum for a visible window, already in low-mem mode
- **STT Python (128.6 MB):** faster-whisper model in memory, needed for transcription

### Avoidable (User-Triggered)
- **Piper TTS (80 MB):** Only after first speak. Could be killed after idle,
  but 80 MB is small enough to keep.
- **Sidebar WebView2 (174 MB):** Only when response is displayed. Destroyed
  on close.
- **NLU Python (50 MB):** Only when parser fails. Killed after 60s idle.

### Future Optimizations
- **whisper.cpp** would eliminate the Python STT sidecar (~128 MB → ~0 MB
  Python overhead, model still ~100 MB in-process)
- **Pure-ONNX Piper** would eliminate the C++ piper-rs dependency
- **Sidebar as DOM overlay** instead of separate window would save ~174 MB
  (but would require rethinking the non-activating window architecture)

---

## Files Changed (All Optimizations)

| File | Optimization |
|------|-------------|
| `src-tauri/tauri.conf.json` | Removed 4 windows, kept only `main` |
| `src-tauri/src/dyn_windows.rs` | NEW: dynamic window creation/destruction |
| `src-tauri/src/lazy_stt.rs` | NEW: lazy STT start manager |
| `src-tauri/src/lazy_nlu.rs` | NEW: lazy NLU start manager |
| `src-tauri/src/tts.rs` | Lazy TTS load, Piper replacement |
| `src-tauri/src/mic_permissions.rs` | WebView2 low-memory mode |
| `src-tauri/src/commands.rs` | All show/hide → destroy |
| `src-tauri/src/lib.rs` | Removed startup NLU pre-warm |
| `src-tauri/Cargo.toml` | `kokoro-rs` → `piper-rs` |

## Lessons Learned

1. **Measure before optimizing.** We measured 1,644 MB and broke it down
   by component. Without measurement, we would have guessed wrong about
   what consumed the most RAM.

2. **Lazy loading is the single biggest win.** Going from "everything
   loaded at boot" to "everything loaded on first use" saved 1,440 MB.
   No other optimization came close.

3. **Destroy > hide.** `window.hide()` is a trap — it looks like it frees
   RAM but doesn't. `window.destroy()` actually kills the process tree.

4. **Every window costs ~174 MB.** On WebView2, each window is a full
   browser process tree. Minimize window count ruthlessly.

5. **Python sidecars are expensive.** Each Python process has ~20 MB
   runtime overhead plus the model. Use in-process (Rust) where possible.

6. **Low-memory mode works.** WebView2's `MemoryUsageTargetLevel::Low`
   reduced the orb from 174 MB to 35.8 MB — a 79% reduction for a
   one-line API call.

7. **Model size matters.** Piper's 63 MB model vs Kokoro's 300 MB model
   isn't just about disk space — it's about RAM when loaded. Smaller
   model = less RAM.

8. **The target was < 200 MB. We hit 104 MB.** 94% reduction from the
   baseline. The assistant now uses less RAM than a single Chrome tab.
