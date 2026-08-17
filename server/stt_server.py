"""
Minimal faster-whisper STT server for NEXUS.

This server runs LOCALLY on the user's device (localhost:8000).
Audio is sent from the NEXUS client to this local server, transcribed,
and only the resulting TEXT is sent to the remote NEXUS server.
Audio NEVER leaves the device.

For devices without a GPU, use:
  WHISPER_DEVICE=cpu WHISPER_COMPUTE=int8
  WHISPER_MODEL=base   (or "tiny" for fastest, "small" for better accuracy)

Requirements:
  pip install faster-whisper fastapi uvicorn python-multipart

Run locally on the device:
  uvicorn stt_server:app --host 127.0.0.1 --port 8000

Environment:
  WHISPER_MODEL    — model name (default: base)
  WHISPER_DEVICE   — "cuda" or "cpu" (default: cpu)
  WHISPER_COMPUTE  — compute type (default: int8)

Models (CPU):
  - tiny:    ~40MB, fastest, lower accuracy
  - base:    ~75MB, good balance (recommended for CPU)
  - small:   ~250MB, better accuracy
  - medium:  ~750MB, high accuracy (slow on CPU)

Models (GPU):
  - large-v3:           ~1.5GB VRAM with int8_float16
  - distil-large-v3:    ~750MB VRAM, faster, slightly lower accuracy
"""

from __future__ import annotations

import os
import logging

from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

log = logging.getLogger("NEXUS.stt")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

MODEL_NAME = os.getenv("WHISPER_MODEL", "base")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE", "int8")

app = FastAPI(title="NEXUS STT", version="0.1.0")

# Load model once on startup.
log.info("loading whisper model=%s device=%s compute=%s", MODEL_NAME, DEVICE, COMPUTE_TYPE)
_model: WhisperModel | None = None


def _get_model() -> WhisperModel:
    global _model
    if _model is None:
        _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
        log.info("whisper model loaded")
    return _model


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"ok": True, "model": MODEL_NAME, "device": DEVICE})


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)) -> JSONResponse:
    """Transcribe raw audio bytes. Returns {"text": "transcript"}."""
    audio_bytes = await audio.read()
    if not audio_bytes:
        return JSONResponse({"text": ""}, status_code=400)

    model = _get_model()
    segments, _info = model.transcribe(
        audio_bytes,
        language="en",
        vad_filter=True,
        beam_size=5,
    )
    text = " ".join(seg.text for seg in segments).strip()
    log.info("transcribed %d bytes → %d chars", len(audio_bytes), len(text))
    return JSONResponse({"text": text})
