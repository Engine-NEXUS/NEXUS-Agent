//! WSS network bridge.
//!
//! Holds a single WebSocket session to the server. The frontend drives it via IPC:
//!   - `open_session`  → connect, send the "start" control frame, start reader task that
//!                        forwards server events to the frontend.
//!   - `send_audio_chunk` → push an Opus/PCM chunk upstream.
//!   - `end_audio`     → send {type:"end_audio"} so the sidecar flushes to STT + n8n.
//!   - `cancel_session`→ send {type:"cancel"} then tear down.
//!   - `close_session` → graceful close.
//!
//! Server events are JSON frames like `{ "type": "state", "state": "thinking" }`,
//! `{ "type": "tts_chunk", "seq": 1, "data": "<base64>" }`, `{ "type": "done" }`.
//!
//! The sessionId is generated client-side (UUID v4) so the server can key the response
//! stream back to this socket via the sidecar's session map.

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Runtime};
use parking_lot::Mutex;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::connect_async;

// `split()` and `next()` come from StreamExt; `send()` from SinkExt.
use futures_util::{SinkExt, StreamExt};

#[derive(serde::Serialize, Clone)]
pub struct ServerEvent {
    pub kind: String,        // "state" | "tts_chunk" | "transcript" | "done" | "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

struct Session {
    tx: mpsc::UnboundedSender<Message>,
    #[allow(dead_code)]
    session_id: String,
}

static SESSION: once_cell::sync::Lazy<Arc<Mutex<Option<Session>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// Generate a RFC 4122 v4 UUID string without pulling a uuid crate.
/// Entropy: nanosecond clock ^ process id ^ a global counter (good enough for session IDs).
fn uuid_v4() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    let ctr = COUNTER.fetch_add(1, Ordering::Relaxed);

    // Mix the three sources into 16 bytes.
    let mut bytes = [0u8; 16];
    let a = nanos.wrapping_mul(0x2545F4914F6CDD1D).wrapping_add(ctr);
    let b = pid.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(nanos ^ ctr);
    bytes[0..8].copy_from_slice(&a.to_le_bytes());
    bytes[8..16].copy_from_slice(&b.to_le_bytes());

    // Set version (4) and variant (10xx) bits.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

/// IPC: open a WSS session to the configured backend and send the "start" frame.
#[tauri::command]
pub async fn open_session<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    token: String,
    user_id: String,
    device_id: String,
) -> Result<String, String> {
    close_session_inner().await;

    let req = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Sec-WebSocket-Protocol", "NEXUS.v1")
        .header("User-Agent", "NEXUS/0.1");
    let request = req
        .body(())
        .map_err(|e| format!("build request: {e}"))?;

    let (ws_stream, _resp) = connect_async(request)
        .await
        .map_err(|e| format!("ws connect: {e}"))?;

    let (mut write, mut read) = ws_stream.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let session_id = uuid_v4();

    // Send the "start" control frame immediately so the sidecar registers the session
    // before any audio chunks arrive.
    let start_frame = serde_json::json!({
        "type": "start",
        "sessionId": session_id,
        "userId": user_id,
        "deviceId": device_id,
    });
    if write
        .send(Message::Text(start_frame.to_string()))
        .await
        .is_err()
    {
        return Err("failed to send start frame".into());
    }

    // Writer: pump outgoing messages from the channel.
    tokio::spawn(async move {
        use futures_util::SinkExt;
        while let Some(msg) = rx.recv().await {
            if write.send(msg).await.is_err() { break; }
        }
        let _ = write.send(Message::Close(None)).await;
    });

    // Reader: forward server frames to the frontend as `assistant:server` events.
    let app2 = app.clone();
    tokio::spawn(async move {
        use futures_util::StreamExt;
        while let Some(frame) = read.next().await {
            let event = match frame {
                Ok(Message::Text(t)) => parse_server_json(&t),
                Ok(Message::Binary(b)) => ServerEvent {
                    kind: "tts_chunk".into(),
                    data: Some(base64_encode(&b)),
                    seq: None, state: None, message: None,
                },
                Ok(Message::Close(_)) => {
                    let _ = app2.emit("assistant:server", ServerEvent { kind: "done".into(), state: None, seq: None, data: None, message: None });
                    break;
                }
                _ => continue,
            };
            let _ = app2.emit("assistant:server", event);
        }
    });

    *SESSION.lock() = Some(Session { tx, session_id: session_id.clone() });
    Ok(session_id)
}

/// IPC: push an audio chunk (base64 Opus/PCM) upstream.
#[tauri::command]
pub async fn send_audio_chunk(payload: String) -> Result<(), String> {
    let bytes = base64_decode(&payload).map_err(|e| format!("b64: {e}"))?;
    if let Some(s) = SESSION.lock().as_ref() {
        let _ = s.tx.send(Message::Binary(bytes));
    }
    Ok(())
}

/// IPC: signal end-of-audio (VAD silence) so the sidecar flushes to STT + n8n.
#[tauri::command]
pub async fn end_audio() -> Result<(), String> {
    if let Some(s) = SESSION.lock().as_ref() {
        let frame = serde_json::json!({ "type": "end_audio" }).to_string();
        let _ = s.tx.send(Message::Text(frame));
    }
    Ok(())
}

/// IPC: cancel the current turn and tear down.
#[tauri::command]
pub async fn cancel_session() -> Result<(), String> {
    if let Some(s) = SESSION.lock().as_ref() {
        let frame = serde_json::json!({ "type": "cancel" }).to_string();
        let _ = s.tx.send(Message::Text(frame));
    }
    close_session_inner().await;
    Ok(())
}

/// IPC: graceful close (no cancel signal).
#[tauri::command]
pub async fn close_session() -> Result<(), String> {
    close_session_inner().await;
    Ok(())
}

async fn close_session_inner() {
    if let Some(s) = SESSION.lock().take() {
        let _ = s.tx.send(Message::Close(None));
    }
}

/// Background monitor (keeps the module's `run` task alive; real sessions are demand-driven).
pub async fn run<R: Runtime>(_app: AppHandle<R>) -> Result<(), String> {
    std::future::pending::<()>().await;
    Ok(())
}

fn parse_server_json(text: &str) -> ServerEvent {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
        ServerEvent {
            kind: v["type"].as_str().unwrap_or("unknown").to_string(),
            state: v["state"].as_str().map(String::from),
            seq: v["seq"].as_u64().map(|n| n as u32),
            data: v["data"].as_str().map(String::from),
            message: v["message"].as_str().map(String::from),
        }
    } else {
        ServerEvent { kind: "raw".into(), data: Some(text.into()), state: None, seq: None, message: None }
    }
}

fn base64_encode(b: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(b)
}
fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.decode(s).map_err(|e| e.to_string())
}
