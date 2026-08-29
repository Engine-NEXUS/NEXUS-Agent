# Rust Integration

> How the openWakeWord KWS engine is integrated into the Rust/Tauri backend.

---

## 1. Overview

The openWakeWord KWS engine is integrated into the Rust backend using **tract-onnx** — a pure Rust ONNX inference engine. No native ONNX Runtime dependency is needed for the KWS pipeline.

The integration uses Cargo feature flags to select between three wake word engines:
- `wakeword-oww` (default): openWakeWord KWS via tract-onnx
- `wakeword-sherpa`: Old VAD+ASR via sherpa-onnx (fallback)
- `mock-wake`: No audio capture, hotkey only (for CI)

---

## 2. Dependencies

### 2.1 tract-onnx

```toml
tract-onnx = "0.23"
```

- **Purpose:** Pure Rust ONNX inference engine
- **No native C/C++ dependencies** — fully portable
- **Used for:** All 3 ONNX models (melspectrogram, embedding, classifier)
- **Provides:** `Tensor`, `TVec`, `TypedFact`, `TypedOp`, `SimplePlan`, `InferenceModelExt`

### 2.2 circular-buffer

```toml
circular-buffer = "1.2"
```

- **Purpose:** Fixed-size circular buffers with `push_back` and `to_vec`
- **Used for:**
  - Mel spectrogram buffer (10 frames)
  - Feature buffer (16 frames)
  - Detection buffer (12 floats)

### 2.3 cpal (existing)

```toml
cpal = "0.15"
```

- **Purpose:** Microphone audio capture
- **Shared with old approach** — same audio pipeline

### 2.4 sherpa-onnx (existing)

```toml
sherpa-onnx = "1.13.4"
```

- **Purpose:** Speaker verification (speaker embedding extraction)
- **Still used** even with `wakeword-oww` feature
- **Not used** for wake word detection anymore (with `wakeword-oww`)

### 2.5 Other Dependencies

```toml
parking_lot = "0.12"   # Fast mutexes for thread safety
once_cell = "1"         # OnceCell for global wake channel
anyhow = "1"            # Error handling
tracing = "0.1"         # Logging
```

---

## 3. Cargo Features

```toml
[features]
default = ["wakeword-oww"]
wakeword-porcupine = []   # legacy: bundle libpv_porcupine + .ppn at runtime
wakeword-sherpa = []      # sherpa-onnx VAD + ASR + speaker verification (old)
wakeword-oww = []         # openWakeWord KWS + speaker verification (new, default)
mock-wake = []            # CI: skip native lib, emit fake wake on hotkey only
opus-encode = ["dep:opus"] # enable Opus upstream compression (needs CMake)
```

### Feature Selection Logic

| Feature | Wake Engine | Audio Capture | Speaker Verification | Use Case |
|---------|------------|---------------|---------------------|----------|
| `wakeword-oww` (default) | openWakeWord KWS | Yes | Yes (sherpa-onnx) | Production |
| `wakeword-sherpa` | VAD+ASR | Yes | Yes (sherpa-onnx) | Fallback |
| `wakeword-porcupine` | Porcupine | Yes | N/A | Legacy |
| `mock-wake` | None | No | No | CI testing |

---

## 4. Module Wiring (lib.rs)

```rust
#[cfg(feature = "wakeword-oww")]
mod wakeword_oww;

#[cfg(feature = "wakeword-oww")]
mod wakeword {
    pub use crate::wakeword_oww::*;
}

#[cfg(not(feature = "wakeword-oww"))]
mod wakeword;
```

### How It Works

1. When `wakeword-oww` is enabled:
   - `wakeword_oww` module is compiled
   - `wakeword` module is a re-export of `wakeword_oww::*`
   - The rest of the codebase uses `wakeword::run()` which calls `wakeword_oww::run()`

2. When `wakeword-oww` is NOT enabled:
   - `wakeword_oww` module is NOT compiled
   - `wakeword` module is the old VAD+ASR implementation
   - The rest of the codebase uses `wakeword::run()` which calls the old engine

This pattern allows the rest of the codebase to always use `wakeword::run()` regardless of which engine is active.

---

## 5. Model Loading

### 5.1 ModelType

```rust
type ModelType = Arc<TypedSimplePlan>;
```

`into_runnable()` returns `Arc<SimplePlan<...>>`, so we store it directly as `ModelType`.

### 5.2 load_onnx_model

```rust
fn load_onnx_model(path: &Path) -> anyhow::Result<ModelType> {
    let data = std::fs::read(path)?;
    let mut rdr = Cursor::new(data);
    let model = tract_onnx::onnx().model_for_read(&mut rdr)?;
    let model = model.into_optimized()?;
    let model = model.into_runnable()?;
    Ok(model)  // Already Arc<SimplePlan>
}
```

**Steps:**
1. Read file bytes
2. Create `Cursor` from bytes (implements `Read`)
3. Parse ONNX: `tract_onnx::onnx().model_for_read(&mut rdr)`
4. Optimize: `model.into_optimized()`
5. Make runnable: `model.into_runnable()`
6. Return `Arc<SimplePlan>`

### 5.3 Model Inference

```rust
// Clone the Arc (cheap — just increments ref count)
let outputs: TVec<TValue> = self.mel.clone().run(tvec!(tensor.into()))?;
```

- `run` method requires `&Arc<Self>` (not `&self`)
- So we clone the Arc before calling `run`
- Arc clone is cheap (just increments ref count, no allocation)

### 5.4 Single-Threaded Executor

```rust
tract_onnx::prelude::multithread::set_default_executor(
    tract_onnx::prelude::multithread::Executor::SingleThread,
);
```

- Set to single-threaded for low latency
- Models are small enough that single-thread is faster (no thread spawn overhead)
- Set once during `AudioFeatures::new()`

---

## 6. Resource Resolution

### 6.1 OWW Model Directory

```rust
pub fn resolve_oww_dir(app_resource_dir: &Path) -> Option<PathBuf> {
    // 1. Production: resource_dir/oww
    let prod = app_resource_dir.join("oww");
    if prod.join("melspectrogram.onnx").exists() {
        return Some(prod);
    }
    // 2. Dev mode: CARGO_MANIFEST_DIR/resources/oww
    if let Ok(manifest) = std::env::var("CARGO_MANIFEST_DIR") {
        let dev = PathBuf::from(manifest).join("resources").join("oww");
        if dev.join("melspectrogram.onnx").exists() {
            return Some(dev);
        }
    }
    // 3. Dev mode fallback: exe_dir/../resources/oww
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let dev = dir.join("..").join("..").join("resources").join("oww");
            if dev.join("melspectrogram.onnx").exists() {
                return Some(dev.canonicalize().unwrap_or(dev));
            }
        }
    }
    None
}
```

### Resolution Order

| Priority | Location | When Used |
|----------|----------|-----------|
| 1 | `{resource_dir}/oww/` | Production (bundled with app) |
| 2 | `{CARGO_MANIFEST_DIR}/resources/oww/` | Dev mode (cargo tauri dev) |
| 3 | `{exe_dir}/../../resources/oww/` | Dev mode fallback |

The check is `melspectrogram.onnx` exists — if the mel model is there, the directory is valid.

### 6.2 Speaker Model Resolution

```rust
let speaker_model = oww_dir.join("speaker_model.onnx");
let speaker_model = if speaker_model.exists() {
    speaker_model
} else {
    let sherpa_dir = resource_dir.join("sherpa");
    let alt = sherpa_dir.join("speaker_model.onnx");
    if alt.exists() { alt } else { speaker_model }
};
```

| Priority | Location | When Used |
|----------|----------|-----------|
| 1 | `{oww_dir}/speaker_model.onnx` | New location (with OWW models) |
| 2 | `{resource_dir}/sherpa/speaker_model.onnx` | Old location (with sherpa models) |

This allows the speaker model to be shared between old and new engines.

---

## 7. Error Handling

| Error | Handling | User Impact |
|-------|----------|-------------|
| OWW model files not found | `anyhow::anyhow!` with helpful message | App fails to start, message tells user where to place files |
| `nexus.onnx` not found | `anyhow::bail!` with training instructions | App fails to start, message tells user to run Colab notebook |
| ONNX parse error | `anyhow::anyhow!` with path and error | App fails to start, indicates corrupt model |
| ONNX optimization error | `anyhow::anyhow!` with path and error | App fails to start, indicates incompatible model |
| Inference error | `tracing::warn!` and return (false, 0.0) | Skip this chunk, continue processing |
| Feature extraction error | `tracing::warn!` and return (false, 0.0) | Skip this chunk, continue processing |

### Missing nexus.onnx Error

```rust
anyhow::bail!(
    "nexus.onnx not found at: {}\n\
     You need to train a custom model first.\n\
     Run the Google Colab notebook: train_nexus_oww.ipynb\n\
     Then place the downloaded nexus.onnx in: {}",
    nexus_model_path.display(),
    oww_dir.display()
);
```

---

## 8. Thread Safety

### 8.1 WakeEngine Protection

```rust
let engine = std::sync::Arc::new(parking_lot::Mutex::new(
    engine::WakeEngine::new(res, data_dir)?
));
```

- `WakeEngine` is wrapped in `Arc<parking_lot::Mutex<WakeEngine>>`
- Audio callback locks the mutex for each chunk
- Lock is held only during `process()` (~11-22ms)
- No other thread accesses the engine

### 8.2 Global Wake Channel

```rust
static WAKE_TX: OnceCell<tokio::sync::mpsc::UnboundedSender<()>> = OnceCell::new();
```

- `OnceCell` ensures the channel sender is set once
- Audio callback sends `()` when a wake is detected
- The `run()` async function receives and handles wake events

### 8.3 No Shared Mutable State

- All state is inside `WakeEngine` (protected by mutex)
- Audio callback is the only writer
- `run()` is the only reader (via channel)
- No data races possible

---

## 9. Build Verification

### 9.1 Compile Tests

```bash
# Default features (wakeword-oww)
cd src-tauri && cargo check

# Mock wake (for CI)
cd src-tauri && cargo check --features mock-wake --no-default-features

# Old engine (wakeword-sherpa)
cd src-tauri && cargo check --features wakeword-sherpa --no-default-features
```

All three must compile without errors.

### 9.2 Release Build

```toml
[profile.release]
opt-level = "z"    # Optimize for size
lto = true          # Link-time optimization
codegen-units = 1   # Single codegen unit (better optimization)
strip = true        # Strip debug symbols
panic = "abort"     # No unwinding (smaller binary)
```

---

## 10. Files

| File | Role |
|------|------|
| `src-tauri/Cargo.toml` | Dependencies and feature flags |
| `src-tauri/src/lib.rs` | Module wiring (feature flag selection) |
| `src-tauri/src/wakeword_oww.rs` | KWS engine implementation |
| `src-tauri/src/wakeword.rs` | Old VAD+ASR engine (fallback) |
| `src-tauri/src/voice_profile.rs` | Speaker verification (shared) |
| `src-tauri/resources/oww/melspectrogram.onnx` | Mel spectrogram model |
| `src-tauri/resources/oww/embedding_model.onnx` | Speech embedding model |
| `src-tauri/resources/oww/nexus.onnx` | Custom NEXUS classifier (trained via Colab) |
| `src-tauri/resources/oww/speaker_model.onnx` | Speaker embedding model (optional) |
