# 08 — CSP for Silero VAD CDN

**Branch:** prem224k
**Status:** Implemented and tested
**Date:** 2026-08-29

---

## Problem

Silero VAD loads its WASM model from `cdn.jsdelivr.net`. The original CSP
(Content Security Policy) didn't allow this, causing CSP violations and
VAD initialization failures.

The VAD Web Worker also needs `blob:` URLs for inline worker creation.

## Implementation (`src-tauri/tauri.conf.json`)

### Before (broken)
```json
"csp": "default-src 'self'; connect-src 'self' wss: https: ipc: http://ipc.localhost; media-src 'self' blob: data:; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:;"
```

### After (working)
```json
"csp": "default-src 'self'; connect-src 'self' wss: https: ipc: http://ipc.localhost; media-src 'self' blob: data:; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:;"
```

### Changes

| Directive | Added | Reason |
|---|---|---|
| `script-src` | `'unsafe-eval'` | WASM instantiation requires eval |
| `script-src` | `https://cdn.jsdelivr.net` | Silero VAD WASM model loads from CDN |
| `worker-src` | `'self' blob:` | VAD Web Worker created from blob URL |

## Files Changed

- `src-tauri/tauri.conf.json` — CSP update
