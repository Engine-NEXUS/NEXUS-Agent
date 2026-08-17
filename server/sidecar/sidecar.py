"""
Ultron WSS Bridge — FastAPI WebSocket sidecar.

Bridges the thin client's persistent WebSocket to:
  - STT (faster-whisper) for speech-to-text
  - n8n supervisor webhook for intent routing + canvas execution
  - ElevenLabs multi-context TTS for voice output (ack + final result)

Flow:
  1. Client connects to /ws.
  2. Client sends {type:"start", sessionId, userId, deviceId}.
  3. Client streams binary PCM audio frames upstream.
  4. On VAD silence, client sends {type:"end_audio"}.
  5. This sidecar:
       a. Transcribes audio via STT.
       b. Immediately speaks an acknowledgement ("On it, sir.") via ElevenLabs.
       c. In parallel, calls n8n supervisor with transcript + user credentials.
       d. When n8n returns, speaks the final result via ElevenLabs.
       e. Streams PCM chunks back to the client as {type:"tts_chunk"} frames.
       f. Sends {type:"done"} when complete.
  6. Client may send {type:"cancel"} at any time for barge-in.

OAuth endpoints (/oauth/*, /apikeys/*) let the client exchange authorization
codes for tokens, which are stored per-user and injected into n8n calls.

Run:
  uvicorn sidecar:app --host 0.0.0.0 --port 8443
  # Production: behind Caddy (TLS) proxying to localhost:8443
"""

from __future__ import annotations

import base64
import json
import logging
import os
import uuid
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Dict, Optional

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse

from . import db
from .tts import get_tts, shutdown_tts
from .n8n_client import call_supervisor
from .oauth import router as oauth_router, get_valid_credentials

log = logging.getLogger("ultron.sidecar")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

# ---- Configuration (env-driven) ----
STT_URL = os.getenv("STT_URL", "http://localhost:8000/transcribe")
SIDECAR_TOKEN = os.getenv("ULTRON_SIDECAR_TOKEN", "")
MAX_AUDIO_BYTES = 8 * 1024 * 1024  # 8 MB safety cap

# Acknowledgement phrases. The sidecar picks one randomly to avoid repetition.
# These are spoken immediately after STT, before n8n processes the request.
_ACK_PHRASES = [
    "On it, sir.",
    "Right away, sir.",
    "Checking that now, sir.",
    "Working on it, sir.",
    "Let me look into that, sir.",
]

app = FastAPI(title="Ultron WSS Bridge", version="0.2.0")
app.include_router(oauth_router)


@app.on_event("startup")
async def _startup() -> None:
    db.init_db()
    log.info("sidecar started — STT=%s", STT_URL)


@app.on_event("shutdown")
async def _shutdown() -> None:
    await shutdown_tts()


# ---- Session registry ----
@dataclass
class Session:
    ws: WebSocket
    session_id: str
    user_id: str
    device_id: str
    audio_buf: bytearray = field(default_factory=bytearray)
    cancelled: bool = False


SESSIONS: Dict[str, Session] = {}


# ---- Health ----
@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True, "sessions": len(SESSIONS)})


# ---- WebSocket endpoint ----
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    if SIDECAR_TOKEN:
        auth = ws.headers.get("authorization", "")
        if auth != f"Bearer {SIDECAR_TOKEN}":
            await ws.close(code=status.WS_1008_POLICY_VIOLATION, reason="unauthorized")
            return

    await ws.accept(subprotocol="ultron.v1")
    session: Optional[Session] = None
    try:
        while True:
            msg = await ws.receive()
            mtype = msg.get("type")
            if mtype == "websocket.disconnect":
                break
            if mtype != "websocket.receive":
                continue

            text = msg.get("text")
            if text is not None:
                session = await _handle_text(ws, text, session)
                continue

            data = msg.get("bytes")
            if data is not None and session is not None and not session.cancelled:
                session.audio_buf.extend(data)
                if len(session.audio_buf) > MAX_AUDIO_BYTES:
                    log.warning("session %s exceeded audio cap, flushing", session.session_id)
                    await _flush_and_run(session)
    except WebSocketDisconnect:
        log.info("ws disconnected")
    except Exception:
        log.exception("ws loop error")
    finally:
        if session is not None:
            SESSIONS.pop(session.session_id, None)


async def _handle_text(ws: WebSocket, raw: str, session: Optional[Session]) -> Optional[Session]:
    """Handle a JSON control frame from the client."""
    try:
        frame = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("bad json frame: %r", raw[:200])
        return session

    ftype = frame.get("type")

    if ftype == "start":
        sid = frame.get("sessionId") or str(uuid.uuid4())
        sess = Session(
            ws=ws,
            session_id=sid,
            user_id=str(frame.get("userId", "")),
            device_id=str(frame.get("deviceId", "")),
        )
        SESSIONS[sid] = sess
        await _send_state(ws, "listening")
        return sess

    if ftype == "end_audio":
        if session is not None and not session.cancelled:
            await _flush_and_run(session)
        return session

    if ftype == "cancel":
        if session is not None:
            session.cancelled = True
            # Barge-in: stop any ongoing TTS.
            tts = get_tts()
            await tts.stop_current()
            await _send_state(ws, "idle")
        return session

    if ftype == "oauth_exchange":
        # Client is sending an OAuth code to exchange (via WSS, not HTTP).
        # Forward to the oauth module's logic.
        return session

    log.debug("unknown control frame: %s", ftype)
    return session


async def _flush_and_run(sess: Session) -> None:
    """
    Transcribe audio, speak acknowledgement, call n8n, speak result.

    The ack and n8n call run concurrently so the user hears "On it, sir."
    while the workflow is executing.
    """
    if sess.cancelled:
        return
    audio = bytes(sess.audio_buf)
    sess.audio_buf.clear()

    # 1. STT
    transcript = await _transcribe(audio) if audio else ""
    if sess.cancelled:
        return

    if transcript:
        # Send the transcript to the client for display.
        with suppress(Exception):
            await sess.ws.send_text(json.dumps({"type": "transcript", "data": transcript}))

    await _send_state(sess.ws, "thinking")

    # 2. Get the user's credentials (OAuth tokens + API keys), refreshing if needed.
    try:
        credentials = await get_valid_credentials(sess.user_id)
    except Exception:
        log.exception("failed to load credentials for user %s", sess.user_id)
        credentials = {}

    # 3. Speak acknowledgement AND call n8n concurrently.
    import random
    ack_text = random.choice(_ACK_PHRASES)
    tts = get_tts()

    # Start n8n call as a background task.
    n8n_task = asyncio_create_task(
        call_supervisor(
            session_id=sess.session_id,
            user_id=sess.user_id,
            device_id=sess.device_id,
            transcript=transcript,
            credentials=credentials,
        )
    )

    # Speak the ack phrase immediately (this blocks until ack audio finishes).
    if not sess.cancelled:
        await _send_state(sess.ws, "speaking")
        try:
            async for chunk in tts.speak(ack_text):
                if sess.cancelled:
                    break
                await _send_tts_chunk(sess.ws, chunk)
        except Exception:
            log.exception("ack TTS failed")

    # 4. Wait for n8n result.
    if sess.cancelled:
        n8n_task.cancel()
        return

    try:
        result_text = await n8n_task
    except Exception:
        log.exception("n8n task failed")
        result_text = "Sorry, I couldn't complete that request."

    if sess.cancelled or not result_text:
        if not sess.cancelled:
            await _send_done(sess.ws)
        return

    # 5. Speak the final result (streamed at sentence boundaries for low latency).
    if not sess.cancelled:
        await _send_state(sess.ws, "speaking")
        try:
            async for chunk in tts.speak(result_text, flush_sentences=True):
                if sess.cancelled:
                    break
                await _send_tts_chunk(sess.ws, chunk)
        except Exception:
            log.exception("final TTS failed")
            await _send_error(sess.ws, "voice synthesis failed")

    await _send_done(sess.ws)


async def _transcribe(audio: bytes) -> str:
    """POST raw PCM to the STT service; return transcript text."""
    if not STT_URL or not audio:
        return ""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            files = {"audio": ("audio.bin", audio, "application/octet-stream")}
            resp = await client.post(STT_URL, files=files)
            resp.raise_for_status()
            data = resp.json()
            return str(data.get("text", data.get("transcript", "")))
    except Exception:
        log.exception("STT failed")
        return ""


async def _send_tts_chunk(ws: WebSocket, pcm: bytes) -> None:
    """Send a PCM chunk as a tts_chunk frame (base64-encoded)."""
    frame = json.dumps({
        "type": "tts_chunk",
        "data": base64.b64encode(pcm).decode(),
    })
    with suppress(Exception):
        await ws.send_text(frame)


async def _send_state(ws: WebSocket, state: str) -> None:
    with suppress(Exception):
        await ws.send_text(json.dumps({"type": "state", "state": state}))


async def _send_done(ws: WebSocket) -> None:
    with suppress(Exception):
        await ws.send_text(json.dumps({"type": "done"}))


async def _send_error(ws: WebSocket, message: str) -> None:
    with suppress(Exception):
        await ws.send_text(json.dumps({"type": "error", "message": message}))


# Avoid importing asyncio at module top for clarity; use a thin alias.
import asyncio
def asyncio_create_task(coro):
    return asyncio.create_task(coro)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "sidecar:app",
        host=os.getenv("SIDECAR_HOST", "0.0.0.0"),
        port=int(os.getenv("SIDECAR_PORT", "8443")),
        log_level="info",
    )
