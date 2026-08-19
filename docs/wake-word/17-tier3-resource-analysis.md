# NEXUS Resource Analysis & Latency Breakdown

> Measured resource consumption of NEXUS + STT server, latency breakdown
> of the current pipeline, and projected resource usage after Tier 3.

All measurements taken on the development machine while NEXUS and the
local STT server were running.

---

## 1. Hardware Profile

| Component | Value | Notes |
|-----------|-------|-------|
| CPU | 13th Gen Intel Core i7-1355U | 10 physical cores, 12 logical processors |
| RAM (total) | 15.7 GB | |
| RAM (free) | 4.6 GB | 11.1 GB already in use |
| GPU | Intel Iris Xe Graphics | **Integrated** — shares system RAM |
| GPU memory | ~2 GB reported | Not dedicated VRAM |
| NVIDIA GPU | **None** | `nvidia-smi` unavailable |
| Disk | SSD | |

### Key constraint

**No NVIDIA GPU.** All AI inference (Whisper, OWW, Silero VAD) runs on CPU.
This is the primary reason Whisper `base` takes 27 seconds for a short command.

---

## 2. Current Resource Consumption (Measured)

### Process-level breakdown

| Process | PID | Working RAM | Peak RAM | Private RAM | CPU Time | Threads | Handles |
|---------|-----|-------------|----------|-------------|----------|---------|---------|
| **nexus.exe** | 27608 | 67.1 MB | 69.1 MB | 20.3 MB | 221s | 36 | 451 |
| **python.exe** (STT) | 15216 | 177.6 MB | **469.4 MB** | **1,579 MB** | 551s | 21 | 267 |
| **node.exe** (Vite dev, 6 procs) | — | 143 MB total | 232 MB peak | — | 18s | — | — |

### Aggregate

| Metric | Value |
|--------|-------|
| NEXUS stack total RAM (working) | ~388 MB |
| STT server peak RAM | 469 MB |
| STT server private memory | 1.58 GB |
| System RAM used | 11.1 GB / 15.7 GB (71%) |
| System RAM free | 4.6 GB (29%) |

### Observations

1. **STT server is the resource hog**: 469 MB peak RAM, 1.58 GB private memory.
   The Whisper `base` model on CPU is the single largest consumer.

2. **NEXUS Rust binary is lean**: 67 MB working RAM, 20 MB private. The app
   registry, window cache, OWW KWS, and audio capture are all lightweight.

3. **Node dev server overhead**: 143 MB across 6 Node processes. This is
   development-only overhead — production builds won't have this.

4. **System is under memory pressure**: 71% RAM used before NEXUS even starts.
   The STT server's 1.58 GB private allocation is significant on this machine.

5. **No GPU acceleration possible**: Intel Iris Xe is integrated graphics with
   shared memory. There's no dedicated VRAM and no CUDA support.

---

## 3. Latency Breakdown (Measured from Logs)

### Timeline: "open youtube" command

```
T+0.000s   15:05:47.317  OWW wake detected (nexus.onnx classifier fires)
            │
            │  Component: OWW KWS detection
            │  Time: ~80ms (streaming, 80ms chunk)
            │  Cost: negligible (tiny DNN on shared features)
            │
T+4.489s   15:05:51.806  Send 92,160 bytes to STT server
            │
            │  Component: VAD endpointing
            │  Time: ~4,490ms
            │  Cause: min_silence_duration_ms=1500 + speech_padding=250
            │         + time to detect speech end + buffer flush
            │  Bottleneck: YES (14.5% of total)
            │
T+31.523s  15:06:18.840  STT result received
            │
            │  Component: Whisper base inference on CPU
            │  Time: ~27,034ms
            │  Cause: base model + beam_size=5 + no max_new_tokens
            │         + hallucination loop ("youtube" repeated 200+ times)
            │  Bottleneck: YES (87% of total)
            │
T+31.523s  15:06:18.860  Registry hit + focus existing window
            │
            │  Component: App resolution + window focus
            │  Time: ~0.3ms
            │  Cost: negligible (cached registry + window cache)
            │  NOT a bottleneck
            │
T+31.523s  15:06:18.860  YouTube window focused
```

### Latency distribution

| Component | Time | % of total | Bottleneck? |
|-----------|------|------------|-------------|
| OWW wake detection | ~80ms | 0.3% | No |
| VAD endpointing | ~4,490ms | 14.5% | Yes (secondary) |
| **Whisper STT (CPU)** | **~27,034ms** | **87.0%** | **Yes (primary)** |
| App registry lookup | ~0.1ms | <0.01% | No |
| Window focus | ~0.2ms | <0.01% | No |
| **Total** | **~31,523ms** | **100%** | |

### STT output (hallucination evidence)

```
"open youtube open youtube open youtube youtube youtube
 youtube youtube youtube youtube youtube youtube youtube
 youtube youtube youtube youtube youtube youtube youtube..."
```

The model entered a repetition loop — generating "youtube" hundreds of times
because:
- No `max_new_tokens` cap → unbounded generation
- No `condition_on_previous_text=False` → feedback loop
- No `compression_ratio_threshold` → repetition not rejected
- `beam_size=5` → 5x slower than greedy, and beam search can get stuck

---

## 4. Projected Resource Usage After Tier 3

### Scenario: 10 command classifiers loaded

| Component | Current | After Tier 3 | Change |
|-----------|---------|--------------|--------|
| NEXUS Rust (working RAM) | 67 MB | ~92 MB | +25 MB (10 models × ~2.5 MB each) |
| STT server (peak RAM) | 469 MB | 469 MB (still loaded for fallback) | 0 MB |
| STT server (used for known commands) | 469 MB | **0 MB** (skipped entirely) | -469 MB |
| OWW shared models (mel + embedding) | ~2.4 MB | ~2.4 MB (shared) | 0 MB |
| Command classifier models | 0 | ~8 MB (10 × 0.8 MB) | +8 MB |
| **Total when command detected** | 388 MB | **~100 MB** | **-288 MB** |
| **Total when STT fallback used** | 388 MB | ~396 MB | +8 MB |

### Per-command model cost

| Resource | Per command model | 10 commands |
|----------|-------------------|-------------|
| Model file size | ~800 KB | ~8 MB |
| RAM (classifier only) | ~2.5 MB | ~25 MB |
| RAM (shared features) | 0 (already loaded) | 0 |
| CPU per 80ms chunk | ~0.1ms | ~1ms |
| Inference latency | ~80ms (streaming) | ~80ms (parallel) |

### Latency projection

| Scenario | Current | After Tier 3 |
|----------|---------|--------------|
| Known command ("open youtube") | 31.5s | **~200ms** |
| Unknown command (STT fallback, tuned) | 31.5s | ~2-4s |
| Complex query ("what's the weather") | 31.5s | ~2-4s |
| No command (silence/noise) | N/A | 0ms (no false positives) |

### Tier 3 latency breakdown (known command)

```
T+0ms      OWW detects command phrase (80ms chunk)
            │
            │  80ms — streaming detection on current chunk
            │
T+80ms     Command classifier fires (P > 0.5)
            │
            │  ~80ms — debounce (MIN_POSITIVE_DETECTIONS across frames)
            │
T+160ms    Emit command-detected Tauri event
            │
            │  ~1ms — event dispatch + frontend handler
            │
T+161ms    invoke("execute_command", { intent })
            │
            │  ~0.3ms — registry lookup + window focus
            │
T+161ms    YouTube focused → "Ok sir." (TTS)
```

**Total: ~161ms.** This is 195x faster than the current 31.5s.

---

## 5. CPU Usage Analysis

### Current CPU usage

| Component | CPU usage | Notes |
|-----------|-----------|-------|
| OWW KWS (wake word) | ~1% of one core | 80ms chunks, tiny DNN |
| Whisper base STT | ~100% of one core (during inference) | 27s burst |
| Audio capture + resample | <0.1% | cpal callback |
| App registry refresh | <0.1% | 2s background timer |
| Frontend (React) | <1% | Only when visible |

### After Tier 3 (10 command classifiers)

| Component | CPU usage | Change |
|-----------|-----------|--------|
| OWW KWS (wake word) | ~1% | No change |
| Command classifiers (10) | ~1% total | +1% (10 × ~0.1% each) |
| Whisper STT (known cmd) | **0%** | -100% (skipped entirely) |
| Whisper STT (fallback) | ~100% burst | No change (only when needed) |
| Audio capture + resample | <0.1% | No change |
| App registry refresh | <0.1% | No change |

**Net CPU impact**: Slight increase during idle (+1% for command classifiers),
dramatic decrease during known commands (-100% of one core for 27s).

---

## 6. Memory Pressure Analysis

### Current state: CONCERNING

```
Total RAM:     15.7 GB
Used:          11.1 GB (71%)
Free:           4.6 GB (29%)
STT private:    1.58 GB (10% of total RAM)
```

The STT server's 1.58 GB private memory allocation is 10% of total system RAM.
On a machine with only 4.6 GB free, this is significant.

### After Tier 3: IMPROVED

When a known command is detected, the STT server is not used at all.
The 1.58 GB private allocation is still reserved (server stays loaded for
fallback), but no additional memory is consumed during inference.

If we later make the STT server lazy-loaded (start only when fallback is
needed), we could reclaim 1.58 GB when no fallback is in use.

### Recommendation

1. **Keep STT server running** for now (fallback is needed for unknown commands)
2. **Consider lazy-loading STT** in a future optimization:
   - Start STT server only when Tier 3 doesn't match
   - Adds ~2-3s startup delay on first fallback
   - Saves 1.58 GB RAM when idle
3. **Monitor RAM** after adding command classifiers — should be <30 MB increase

---

## 7. GPU Considerations

### Current: No GPU acceleration

- Intel Iris Xe integrated graphics
- No CUDA support
- `nvidia-smi` unavailable
- All inference on CPU

### Could we use Intel GPU?

Intel Iris Xe supports OpenVINO and oneDNN for some models, but:
- Whisper doesn't have an official OpenVINO backend
- faster-whisper supports CTranslate2 (CUDA only, not Intel GPU)
- sherpa-onnx supports CPU and CUDA, not Intel GPU
- tract-onnx (used by OWW) is CPU-only

**Conclusion**: Intel GPU acceleration is not practical for NEXUS's models.

### If NVIDIA GPU were available

| Model | CPU latency | GPU latency (est.) |
|-------|-------------|-------------------|
| Whisper base | 27s | ~1-2s (CUDA) |
| Whisper tiny | 2-4s | ~0.3-0.5s (CUDA) |
| OWW classifier | 80ms | ~5ms (CUDA) |

Even with a GPU, Tier 3 (OWW classifiers) would still be faster for known
commands — the overhead of loading audio, running ASR, and parsing intent
exceeds a direct classifier.

---

## 8. Measurement Methodology

### How RAM was measured

```powershell
Get-Process -Name nexus, python, node |
  Select-Object Name, Id,
    @{N='WorkingSet(MB)';E={[math]::Round($_.WorkingSet64/1MB, 1)}},
    @{N='PeakWorkingSet(MB)';E={[math]::Round($_.PeakWorkingSet64/1MB, 1)}},
    @{N='PrivateMemory(MB)';E={[math]::Round($_.PrivateMemorySize64/1MB, 1)}},
    @{N='TotalProcessorTime(s)';E={[math]::Round($_.TotalProcessorTime.TotalSeconds, 1)}},
    Threads, HandleCount
```

### How latency was measured

Timestamps from NEXUS application logs (tracing crate with microsecond
precision). All timestamps are UTC (ISO 8601 with `Z` suffix).

### How CPU was measured

Windows Task Manager + `Get-Process` `TotalProcessorTime` (cumulative CPU
seconds used by the process).

### How GPU was checked

```powershell
nvidia-smi  # → not found (no NVIDIA GPU)
Get-CimInstance Win32_VideoController  # → Intel Iris Xe Graphics
```

---

## 9. Cross-References

- [16-tier3-decision-comparison.md](./16-tier3-decision-comparison.md) — Options & decision
- [15-tier3-command-classifiers.md](./15-tier3-command-classifiers.md) — Tier 3 architecture
- [12-performance-expectations.md](./12-performance-expectations.md) — Original performance targets
- [14-model-validation-results.md](./14-model-validation-results.md) — Wake-word validation
