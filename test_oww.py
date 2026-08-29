"""Test openWakeWord with alexa model using microphone."""
import sys
import openwakeword
from openwakeword import Model
import numpy as np
import sounddevice as sd
import time

print("Loading openWakeWord alexa model...", flush=True)
model = Model(wakeword_models=["./src-tauri/resources/oww/alexa_v0.1.onnx"])
print("Model loaded! Say 'Alexa' into the microphone.", flush=True)
print("Press Ctrl+C to stop.\n", flush=True)

chunk_duration = 0.08  # 80ms chunks (1280 samples at 16kHz)
sample_rate = 16000
chunk_size = int(sample_rate * chunk_duration)

frame_count = 0

def audio_callback(indata, frames, time_info, status):
    global frame_count
    if status:
        print(f"Status: {status}", flush=True)
    audio = indata[:, 0]
    prediction = model.predict(audio)
    frame_count += 1
    for key, score in prediction.items():
        if score > 0.5:
            print(f"  >>> DETECTED: {key} (score: {score:.3f}) <<<", flush=True)
        elif score > 0.1:
            print(f"  [{frame_count}] {key}: {score:.3f}", flush=True)

with sd.InputStream(samplerate=sample_rate, channels=1, dtype='float32',
                    blocksize=chunk_size, callback=audio_callback):
    print(f"Listening at {sample_rate}Hz, chunk={chunk_size} samples ({chunk_duration*1000:.0f}ms)...", flush=True)
    try:
        while True:
            time.sleep(0.1)
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
