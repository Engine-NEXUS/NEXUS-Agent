//! Wake-word engine.
//!
//! Default build: Porcupine (Picovoice) loaded at runtime via `libloading` to avoid the
//! GPL/compile-time FFI friction. Audio is captured with `cpal` at the device's NATIVE sample
//! rate, resampled to Porcupine's required 16 kHz mono i16, chunked into `frame_length` samples,
//! and fed to `pv_porcupine_process`.
//!
//! `mock-wake` feature: skip the native lib entirely; only the global hotkey produces wakes.
//!
//! FFI signatures target Porcupine **v4.0** (Dec 2025) `pv_porcupine.h`:
//!   pv_status_t pv_porcupine_init(
//!       const char *access_key,
//!       const char *model_path,
//!       const char *device,              // "best" | "cpu" | "gpu" | "cpu:N"
//!       int32_t num_keywords,
//!       const char *const *keyword_paths,
//!       const float *sensitivities,
//!       pv_porcupine_t **object);
//!   pv_status_t pv_porcupine_process(pv_porcupine_t *, const int16_t *, int32_t *);
//!   void pv_porcupine_delete(pv_porcupine_t *);
//!   int32_t pv_sample_rate(void);
//!   int32_t pv_porcupine_frame_length(void);

use tauri::{AppHandle, Runtime};

#[cfg(feature = "mock-wake")]
pub async fn run<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    tracing::info!("wake-word: mock mode (no native listener)");
    std::future::pending::<()>().await;
    Ok(())
}

#[cfg(not(feature = "mock-wake"))]
mod porcupine {
    use std::ffi::CString;
    use std::os::raw::c_char;
    use std::path::PathBuf;
    use libloading::Library;

    pub struct Porcupine {
        _lib: Library,
        handle: *mut std::ffi::c_void,
        frame_length: i32,
        sample_rate: i32,
        process_fn: unsafe extern "C" fn(*const std::ffi::c_void, *const i16, *mut i32) -> i32,
        delete_fn: unsafe extern "C" fn(*mut std::ffi::c_void),
    }

    unsafe impl Send for Porcupine {}
    // `process()` is the only method called from the audio thread and performs no shared
    // mutation, so the raw handle can be shared (Porcupine owns its own internal locking).
    unsafe impl Sync for Porcupine {}

    impl Porcupine {
        pub fn new(
            lib_path: PathBuf,
            access_key: &str,
            model_path: PathBuf,
            keyword_path: PathBuf,
            sensitivity: f32,
        ) -> anyhow::Result<Self> {
            unsafe {
                let lib = Library::new(&lib_path)?;

                // Load each symbol with an explicit function-pointer type (turbofish) so
                // `lib.get` infers its generic parameter. We then dereference the `Symbol`
                // to obtain a plain (Copy, Send+Sync) function pointer. The pointer stays
                // valid for as long as `lib` is loaded, and `lib` lives in this same struct
                // (`_lib`) for the full lifetime of the handle, so this is sound.
                //
                // v4.0 signature: (access_key, model_path, device, num_keywords, keyword_paths,
                //                   sensitivities, object) -> pv_status_t
                let new_fn = lib
                    .get::<unsafe extern "C" fn(
                        *const c_char,        // access_key
                        *const c_char,        // model_path
                        *const c_char,        // device
                        i32,                  // num_keywords
                        *const *const c_char, // keyword_paths
                        *const f32,           // sensitivities
                        *mut *mut std::ffi::c_void, // object (out)
                    ) -> i32>(
                        b"pv_porcupine_init",
                    )?;
                let process_fn = lib
                    .get::<unsafe extern "C" fn(*const std::ffi::c_void, *const i16, *mut i32) -> i32>(
                        b"pv_porcupine_process",
                    )?;
                let delete_fn = lib
                    .get::<unsafe extern "C" fn(*mut std::ffi::c_void)>(b"pv_porcupine_delete")?;
                let sr_fn = lib.get::<unsafe extern "C" fn() -> i32>(b"pv_sample_rate")?;
                let fl_fn = lib.get::<unsafe extern "C" fn() -> i32>(b"pv_porcupine_frame_length")?;

                let new_fn: unsafe extern "C" fn(
                    *const c_char,
                    *const c_char,
                    *const c_char,
                    i32,
                    *const *const c_char,
                    *const f32,
                    *mut *mut std::ffi::c_void,
                ) -> i32 = *new_fn;
                let process_fn: unsafe extern "C" fn(*const std::ffi::c_void, *const i16, *mut i32) -> i32 =
                    *process_fn;
                let delete_fn: unsafe extern "C" fn(*mut std::ffi::c_void) = *delete_fn;
                let sr_fn: unsafe extern "C" fn() -> i32 = *sr_fn;
                let fl_fn: unsafe extern "C" fn() -> i32 = *fl_fn;

                let access_c = CString::new(access_key)?;
                let model_c = CString::new(model_path.to_string_lossy().as_bytes())?;
                let kw_c = CString::new(keyword_path.to_string_lossy().as_bytes())?;
                // v4.0: device string. "best" lets the engine pick CPU/GPU automatically.
                let device_c = CString::new("best")?;
                let kw_ptrs = [kw_c.as_ptr()];
                let sens = [sensitivity];

                let mut handle: *mut std::ffi::c_void = std::ptr::null_mut();
                let rc = new_fn(
                    access_c.as_ptr(),
                    model_c.as_ptr(),
                    device_c.as_ptr(),
                    1, // num_keywords
                    kw_ptrs.as_ptr(),
                    sens.as_ptr(),
                    &mut handle,
                );
                if rc != 0 {
                    anyhow::bail!("pv_porcupine_init code={rc}");
                }

                Ok(Porcupine {
                    _lib: lib,
                    handle,
                    frame_length: fl_fn(),
                    sample_rate: sr_fn(),
                    process_fn,
                    delete_fn,
                })
            }
        }

        pub fn frame_length(&self) -> usize { self.frame_length as usize }
        pub fn sample_rate(&self) -> u32 { self.sample_rate as u32 }

        pub fn process(&self, frame: &[i16]) -> anyhow::Result<bool> {
            let mut idx: i32 = -1;
            let rc = unsafe { (self.process_fn)(self.handle, frame.as_ptr(), &mut idx) };
            if rc != 0 { anyhow::bail!("pv_porcupine_process rc={rc}"); }
            Ok(idx >= 0)
        }
    }

    impl Drop for Porcupine {
        fn drop(&mut self) { unsafe { (self.delete_fn)(self.handle) } }
    }
}


#[cfg(not(feature = "mock-wake"))]
use once_cell::sync::OnceCell;
#[cfg(not(feature = "mock-wake"))]
static WAKE_TX: OnceCell<tokio::sync::mpsc::UnboundedSender<()>> = OnceCell::new();

#[cfg(not(feature = "mock-wake"))]
fn native_lib_name() -> &'static str {
    #[cfg(target_os = "windows")] { "libpv_porcupine.dll" }
    #[cfg(target_os = "macos")]    { "libpv_porcupine.dylib" }
    #[cfg(target_os = "linux")]   { "libpv_porcupine.so" }
}

#[cfg(not(feature = "mock-wake"))]
pub async fn run<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri::{Emitter, Manager};

    let res = app.path().resource_dir().map_err(|e| format!("resource dir: {e}"))?;
    let lib = res.join("porcupine").join(native_lib_name());
    let model = res.join("porcupine").join("porcupine_params.pv");
    let keyword = res.join("porcupine").join("NEXUS.ppn");

    let key = keyring::Entry::new("NEXUS", "porcupine-access-key")
        .map_err(|e| format!("keyring: {e}"))?
        .get_password()
        .map_err(|e| format!("keyring get_password: {e}"))?;

    let pv = std::sync::Arc::new(
        porcupine::Porcupine::new(lib, &key, model, keyword, 0.75)
            .map_err(|e| format!("porcupine init: {e}"))?,
    );

    // Set the wake channel BEFORE starting audio capture so the very first detection is not
    // lost in the race between capture-start and channel-set.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let _ = WAKE_TX.set(tx);

    // Start the audio capture (and forget the non-Send `cpal::Stream`) entirely inside a
    // synchronous helper so the `Stream` never enters the async state machine. The spawned
    // future must be `Send`, but `cpal::Stream` is not `Send`.
    start_audio_capture(pv)?;

    while rx.recv().await.is_some() {
        let _ = app.emit("assistant:wake", ());
    }
    Ok(())
}

/// Synchronous helper: build + play the input stream, then `forget` it so it runs for the
/// process lifetime. `cpal::Stream` is `!Send`; confining it here keeps it out of the async
/// context that `run` is spawned into.
///
/// Opens the input device at its NATIVE sample rate and resamples to Porcupine's required
/// 16 kHz mono i16 via linear interpolation. Forcing a 16 kHz config via `build_input_stream_raw`
/// fails on many hosts (e.g. Windows WASAPI shared mode doesn't offer 16k natively), so we
/// capture at the device default and downsample in the callback.
#[cfg(not(feature = "mock-wake"))]
fn start_audio_capture(pv: std::sync::Arc<porcupine::Porcupine>) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use cpal::Sample;

    let host = cpal::default_host();
    let device = host.default_input_device().ok_or_else(|| "no input device".to_string())?;

    // Probe the device's DEFAULT supported input config — do NOT force 16 kHz.
    let default_config = device
        .default_input_config()
        .map_err(|e| format!("default_input_config: {e}"))?;

    let target_sr = pv.sample_rate();       // 16000
    let frame_len = pv.frame_length();      // ~512
    let native_sr = default_config.sample_rate().0;
    let native_channels = default_config.channels() as usize;

    // We capture in the device's native format and convert to i16 in the callback.
    let sample_format = default_config.sample_format();
    let stream_config = cpal::StreamConfig {
        channels: default_config.channels(),
        sample_rate: default_config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };

    // Shared resampler state captured into the callback closure.
    // `frac` is the fractional read position into the native buffer; `carry` holds leftover
    // native samples between callbacks so resampling is continuous across block boundaries.
    let state = std::sync::Arc::new(parking_lot::Mutex::new(ResampleState::new(native_sr, target_sr)));
    // 16 kHz mono i16 output buffer, accumulated until we have `frame_len` samples.
    let out_buf = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<i16>::with_capacity(frame_len * 2)));
    let pv_cb = pv;

    let err_cb = |err| tracing::error!("audio stream error: {err}");

    // Build a single callback that handles all sample formats by converting to f32 first.
    let build_result = match sample_format {
        cpal::SampleFormat::I16 => device.build_input_stream::<i16, _, _>(
            &stream_config,
            {
                let state = state.clone();
                let out_buf = out_buf.clone();
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    on_audio(data, native_channels, &state, &out_buf, &pv_cb, frame_len, |s: i16| s.to_sample::<f32>());
                }
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream::<i32, _, _>(
            &stream_config,
            {
                let state = state.clone();
                let out_buf = out_buf.clone();
                move |data: &[i32], _: &cpal::InputCallbackInfo| {
                    on_audio(data, native_channels, &state, &out_buf, &pv_cb, frame_len, |s: i32| s.to_sample::<f32>());
                }
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::F32 => device.build_input_stream::<f32, _, _>(
            &stream_config,
            {
                let state = state.clone();
                let out_buf = out_buf.clone();
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    on_audio(data, native_channels, &state, &out_buf, &pv_cb, frame_len, |s: f32| s);
                }
            },
            err_cb,
            None,
        ),
        other => return Err(format!("unsupported sample format: {other:?}")),
    };

    let stream = build_result.map_err(|e| format!("build stream: {e}"))?;
    stream.play().map_err(|e| format!("play stream: {e}"))?;
    // Keep the stream (and the audio capture) alive for the process lifetime.
    std::mem::forget(stream);
    Ok(())
}

/// Resampler state: fractional read cursor + carry buffer of native mono samples.
#[cfg(not(feature = "mock-wake"))]
struct ResampleState {
    ratio: f64,   // native_sr / target_sr  (e.g. 48000/16000 = 3.0)
    frac: f64,    // fractional read position into `carry`
    carry: Vec<f32>, // leftover native mono samples from the previous callback
}

#[cfg(not(feature = "mock-wake"))]
impl ResampleState {
    fn new(native_sr: u32, target_sr: u32) -> Self {
        Self {
            ratio: native_sr as f64 / target_sr as f64,
            frac: 0.0,
            carry: Vec::with_capacity(4096),
        }
    }
}

/// Generic audio callback: downmix to mono (f32), append to resampler carry, linearly
/// resample to 16 kHz, convert to i16, accumulate into `out_buf`, and feed `frame_len`-sample
/// frames to Porcupine.
#[cfg(not(feature = "mock-wake"))]
fn on_audio<T, F>(
    data: &[T],
    native_channels: usize,
    state: &std::sync::Arc<parking_lot::Mutex<ResampleState>>,
    out_buf: &std::sync::Arc<parking_lot::Mutex<Vec<i16>>>,
    pv: &std::sync::Arc<porcupine::Porcupine>,
    frame_len: usize,
    to_f32: F,
)
where
    F: Fn(T) -> f32,
    T: Copy,
{
    // 1. Downmix to mono f32 and append to the resampler carry buffer.
    {
        let mut st = state.lock();
        let ch = native_channels.max(1);
        let frames = data.len() / ch;
        for i in 0..frames {
            let mut sum = 0.0f32;
            for c in 0..ch {
                sum += to_f32(data[i * ch + c]);
            }
            st.carry.push(sum / ch as f32);
        }
    }

    // 2. Resample from native_sr -> 16 kHz via linear interpolation.
    let mut produced: Vec<f32> = Vec::with_capacity(frame_len);
    {
        let mut st = state.lock();
        let ratio = st.ratio;
        let mut pos = st.frac;
        while pos + ratio < st.carry.len() as f64 {
            let idx0 = pos.floor() as usize;
            let idx1 = (idx0 + 1).min(st.carry.len() - 1);
            let t = pos - idx0 as f64;
            let s = st.carry[idx0] as f64 * (1.0 - t) + st.carry[idx1] as f64 * t;
            produced.push(s as f32);
            pos += ratio;
        }
        // Drop consumed samples, keep the remainder + fractional position.
        let consumed = pos.floor() as usize;
        st.carry.drain(0..consumed);
        st.frac = pos - consumed as f64;
    }

    // 3. Convert f32 -> i16 and accumulate into the frame buffer.
    {
        let mut buf = out_buf.lock();
        for s in produced {
            let clamped = s.max(-1.0).min(1.0);
            let i = (clamped * 32767.0) as i16;
            buf.push(i);
            // 4. When we have a full frame, feed it to Porcupine.
            while buf.len() >= frame_len {
                let frame: Vec<i16> = buf.drain(0..frame_len).collect();
                if let Ok(true) = pv.process(&frame) {
                    tracing::info!("porcupine: wake detected");
                    if let Some(tx) = WAKE_TX.get() { let _ = tx.send(()); }
                }
            }
        }
    }
}
