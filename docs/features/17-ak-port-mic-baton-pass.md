# 17 — AK Port: Microphone Baton Pass

**Date:** 2026-08-29
**Source:** `Engine-NEXUS/AK` repo analysis (commit `25d1f6c`)
**Status:** Implemented and tested

## Problem

After the first voice command, the wake-word engine goes permanently deaf.
The root cause (diagnosed in AK's `WAKEWORD_BUG.md`):

1. The frontend's `track.enabled = false` doesn't release the OS mic lock
2. Rust's `pause_stream()`/`resume_stream()` were dummy functions (no-op)
3. Windows Intel Smart Sound Technology (SST) drivers don't allow two
   processes to capture the mic simultaneously — cpal gets silence when
   WebView2 is also holding the mic

## Solution: Baton Pass Architecture

Only one microphone owner at a time:

```
Wake-word engine (cpal) owns mic
  ↓ user says "NEXUS"
Frontend asks Rust to PAUSE cpal stream
  ↓ Rust releases OS mic lock
Frontend acquires mic via getUserMedia()
  ↓ user speaks command
Frontend releases mic (track.stop / track.enabled=false)
  ↓ Frontend asks Rust to RESUME cpal stream
Wake-word engine re-acquires mic
```

## Implementation

### Rust side (`src-tauri/src/wakeword_oww.rs`)

Added a global cpal stream handle stored in a `RwLock`:

```rust
struct SendStream(cpal::Stream);
unsafe impl Send for SendStream {}
unsafe impl Sync for SendStream {}

static CPAL_STREAM: once_cell::sync::Lazy<
    parking_lot::RwLock<Option<SendStream>>
> = once_cell::sync::Lazy::new(|| parking_lot::RwLock::new(None));
```

`cpal::Stream` is not `Send`/`Sync` on all platforms (contains `*mut ()`),
so we wrap it in a newtype with manual unsafe impls. This is safe because:
- Only `pause()` and `play()` are called (from the Tauri IPC thread)
- The stream is never moved or cloned after being stored
- The audio callback runs independently

Two public functions:

```rust
pub fn pause_stream() {
    use cpal::traits::StreamTrait;
    let guard = CPAL_STREAM.read();
    if let Some(ref stream) = *guard {
        match stream.0.pause() {
            Ok(()) => tracing::info!("wake: cpal stream paused (mic baton pass)"),
            Err(e) => tracing::warn!("wake: cpal stream pause failed: {e}"),
        }
    }
}

pub fn resume_stream() {
    use cpal::traits::StreamTrait;
    let guard = CPAL_STREAM.read();
    if let Some(ref stream) = *guard {
        match stream.0.play() {
            Ok(()) => tracing::info!("wake: cpal stream resumed (mic baton pass)"),
            Err(e) => tracing::warn!("wake: cpal stream resume failed: {e}"),
        }
    }
}
```

The stream is stored instead of `std::mem::forget()`-ed:

```rust
// Before (leaked, no handle to pause/resume):
std::mem::forget(stream);

// After (stored in global for baton pass):
*CPAL_STREAM.write() = Some(SendStream(stream));
```

### IPC commands (`src-tauri/src/commands.rs`)

```rust
#[tauri::command]
pub fn pause_wakeword() -> Result<(), String> {
    crate::wakeword_oww::pause_stream();
    Ok(())
}

#[tauri::command]
pub fn resume_wakeword() -> Result<(), String> {
    crate::wakeword_oww::resume_stream();
    Ok(())
}
```

Registered in `src-tauri/src/lib.rs`:

```rust
commands::pause_wakeword,
commands::resume_wakeword,
```

### Frontend (`frontend/src/main.tsx`)

Before `getUserMedia()`:

```typescript
await invoke("pause_wakeword");
console.log("[NEXUS] baton pass: Rust wakeword paused");
```

After releasing the mic (`__NEXUS_RELEASE_MIC__`):

```typescript
invoke("resume_wakeword");
console.log("[NEXUS] baton pass: Rust wakeword resumed");
```

## Key difference from AK

AK implemented the baton pass in `wakeword.rs` (the sherpa-based engine),
which **we deleted in prem224k** because we use `wakeword_oww.rs`
(openWakeWord/tract-onnx) as the default feature.

We re-implemented the fix for the OWW engine instead of cherry-picking
AK's commit. The architecture is the same; the implementation is different
because the OWW engine uses a different cpal stream setup.

## Verification

Tested live on 2026-08-29. Rust logs confirm:

```
11:07:03 wake: cpal stream paused (mic baton pass — frontend acquiring mic)
11:07:08 wake: cpal stream resumed (mic baton pass — frontend released mic)
11:08:36 wake-word: NEXUS detected → triggering wake    ← WORKS AFTER BATON PASS
11:08:44 wake: cpal stream resumed
11:08:50 wake-word: NEXUS detected → triggering wake    ← WORKS AGAIN
```

Before this fix, the wake word would go deaf after the first voice command
and never recover until the app was restarted.
