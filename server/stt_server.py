"""
Minimal faster-whisper STT server for NEXUS.

This server runs LOCALLY on the user's device (127.0.0.1:39217).
Audio is sent from the NEXUS client to this local server, transcribed,
and only the resulting TEXT is sent to the remote NEXUS server.
Audio NEVER leaves the device.

For devices without a GPU, use:
  WHISPER_DEVICE=cpu WHISPER_COMPUTE=int8
  WHISPER_MODEL=tiny.en   (fastest, ~0.5s transcription, ~150MB RAM)

Requirements:
  pip install faster-whisper fastapi uvicorn python-multipart

Run locally on the device:
  uvicorn stt_server:app --host 127.0.0.1 --port 39217

Environment:
  WHISPER_MODEL    — model name (default: tiny.en)
  WHISPER_DEVICE   — "cuda" or "cpu" (default: cpu)
  WHISPER_COMPUTE  — compute type (default: int8)

Models (CPU):
  - tiny.en:  ~40MB, fastest (~0.5s), good accuracy for commands (recommended)
  - base.en:  ~75MB, slower (~1.5s), slightly better accuracy
  - small.en: ~250MB, slow (~3s), best accuracy

Models (GPU):
  - large-v3:           ~1.5GB VRAM with int8_float16
  - distil-large-v3:    ~750MB VRAM, faster, slightly lower accuracy
"""

from __future__ import annotations

import os
import logging
import time

from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel

log = logging.getLogger("NEXUS.stt")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

# Default to tiny.en — 75% faster than base with only 0.75% higher WER.
# The .en variant is English-only, which is faster and smaller than multilingual.
MODEL_NAME = os.getenv("WHISPER_MODEL", "tiny.en")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE", "int8")

# Hotwords — biases the Whisper decoder toward known app/brand names so that
# mispronunciations like "gamail" are more likely to be transcribed as "gmail".
# This is faster-whisper's built-in hotword feature (PR #731, merged May 2024).
# It adds the hotwords as a prompt to every transcription window, unlike
# initial_prompt which only affects the first window.
HOTWORDS = os.getenv(
    "WHISPER_HOTWORDS",
    " ".join([
        # Web apps / services
        "gmail", "youtube", "github", "google", "chrome", "brave", "firefox",
        "twitter", "instagram", "facebook", "reddit", "linkedin", "whatsapp",
        "netflix", "amazon", "wikipedia", "twitch", "spotify", "discord",
        "slack", "notion", "figma", "chatgpt", "claude", "gemini",
        # Google suite
        "drive", "docs", "sheets", "slides", "maps", "calendar", "translate",
        "photos", "meet", "chat",
        # Native apps
        "notepad", "calculator", "explorer", "terminal", "powershell",
        "paint", "settings", "outlook", "word", "excel", "powerpoint",
        "vscode", "code", "steam", "zoom", "teams", "skype", "telegram",
        # Action words
        "open", "launch", "start", "search", "find", "close",
    ]),
)

app = FastAPI(title="NEXUS STT", version="0.2.0")

# EAGER model loading — load at startup so the first transcription is fast.
# The previous lazy loading caused a 10-15s delay on the first command.
log.info("loading whisper model=%s device=%s compute=%s", MODEL_NAME, DEVICE, COMPUTE_TYPE)
_load_start = time.monotonic()
_model: WhisperModel = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
log.info(
    "whisper model loaded in %.1fs — ready for transcription",
    time.monotonic() - _load_start,
)


def _get_model() -> WhisperModel:
    return _model


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({
        "ok": True,
        "model": MODEL_NAME,
        "device": DEVICE,
        "hotwords": HOTWORDS[:80] + "..." if len(HOTWORDS) > 80 else HOTWORDS,
    })


@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)) -> JSONResponse:
    """Transcribe raw audio bytes. Returns {"text": "transcript"}.

    Accepts WAV, MP3, FLAC, or any format supported by PyAV.
    Raw 16-bit PCM is also accepted — we wrap it in a WAV header so
    PyAV/faster-whisper can decode it.
    """
    import io
    import struct
    audio_bytes = await audio.read()
    if not audio_bytes:
        return JSONResponse({"text": ""}, status_code=400)

    # Check if the bytes start with a RIFF/WAV header. If not, assume raw
    # 16-bit LE mono PCM at 16kHz and wrap it in a WAV header so PyAV can
    # decode it.
    is_wav = len(audio_bytes) >= 12 and audio_bytes[:4] == b"RIFF" and audio_bytes[8:12] == b"WAVE"
    if not is_wav:
        sample_rate = 16000
        num_channels = 1
        bits_per_sample = 16
        data_len = len(audio_bytes)
        header = struct.pack(
            "<4sI4s4sIHHIIHH4sI",
            b"RIFF",
            36 + data_len,
            b"WAVE",
            b"fmt ",
            16,  # fmt chunk size
            1,   # PCM
            num_channels,
            sample_rate,
            sample_rate * num_channels * bits_per_sample // 8,  # byte rate
            num_channels * bits_per_sample // 8,  # block align
            bits_per_sample,
            b"data",
            data_len,
        )
        audio_bytes = header + audio_bytes
        log.info("wrapped raw PCM (%d bytes) in WAV header", data_len)

    audio_file = io.BytesIO(audio_bytes)
    audio_file.name = "audio.wav"  # hint for PyAV format detection

    model = _get_model()
    _transcribe_start = time.monotonic()
    try:
        segments, _info = model.transcribe(
            audio_file,
            language="en",
            hotwords=HOTWORDS,
            # Use VAD but with gentle parameters — default VAD is too aggressive
            # on short command clips (<2s) and discards them entirely.
            # min_silence_duration_ms=1500 matches the frontend VAD timing.
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=1500,
                speech_pad_ms=250,
                threshold=0.3,
            ),
            # Greedy decoding — much faster than beam search (beam_size=5).
            # For short voice commands, the accuracy difference is negligible.
            beam_size=1,
        )
        text = " ".join(seg.text for seg in segments).strip()
    except Exception as e:
        log.error("transcription failed: %s", e)
        return JSONResponse({"text": "", "error": str(e)}, status_code=500)

    _elapsed = time.monotonic() - _transcribe_start
    log.info(
        "transcribed %d bytes → %d chars in %.2fs",
        len(audio_bytes), len(text), _elapsed,
    )
    return JSONResponse({"text": text})
