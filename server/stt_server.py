"""
Minimal faster-whisper STT server for ULTRON.

Deploy on the GPU server alongside n8n and Ollama.

Requirements:
  pip install faster-whisper fastapi uvicorn python-multipart

Run:
  uvicorn stt_server:app --host 0.0.0.0 --port 8000

Environment:
  WHISPER_MODEL    — model name (default: large-v3)
  WHISPER_DEVICE   — "cuda" or "cpu" (default: cuda)
  WHISPER_COMPUTE  — compute type (default: int8_float16)

With 11GB VRAM:
  - large-v3 + int8_float16: ~3.1GB VRAM (leaves ~8GB for Ollama)
  - distil-large-v3 + int8_float16: ~1.5GB VRAM (more room for Ollama)
"""

from __future__ import annotations

import os
import logging

from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

log = logging.getLogger("ultron.stt")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

MODEL_NAME = os.getenv("WHISPER_MODEL", "large-v3")
DEVICE = os.getenv("WHISPER_DEVICE", "cuda")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE", "int8_float16")

app = FastAPI(title="Ultron STT", version="0.1.0")

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
