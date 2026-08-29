# 06 — Wake-Word Reliability (Single-Frame High-Confidence)

**Branch:** prem224k
**Status:** Implemented and tested
**Date:** 2026-08-29

---

## Problem

The openWakeWord model (78.6% accuracy, 58.2% recall) sometimes produces a
single high-confidence detection (e.g. probability 0.89) but the adjacent
frames are below threshold. The 2-frame smoothing requirement
(`MIN_POSITIVE_DETECTIONS = 2.0`) silently discarded these valid detections.

This meant the user would say "NEXUS" clearly, the model would detect it
with 0.89 confidence on one frame, but the wake wouldn't fire because the
neighboring frames were below 0.45.

## Implementation (`src-tauri/src/wakeword_oww.rs`)

### New constant

```rust
/// Single-frame high-confidence threshold.
/// If any single frame exceeds this, trigger immediately without
/// requiring MIN_POSITIVE_DETECTIONS frames.
const SINGLE_FRAME_HIGH_CONFIDENCE: f32 = 0.5;
```

### Two trigger paths in `calculate_average()`

```rust
fn calculate_average(&self) -> f32 {
    let all = self.detections_buffer.to_vec();

    // Path 1: single high-confidence frame triggers immediately
    for &d in &all {
        if d >= SINGLE_FRAME_HIGH_CONFIDENCE {
            return d;
        }
    }

    // Path 2: smoothed multi-frame detection
    let mut cumulative = 0.0f32;
    let mut positive_count = 0.0f32;
    for d in all {
        if d > self.threshold {
            cumulative += d;
            positive_count += 1.0;
        }
    }
    // ... require MIN_POSITIVE_DETECTIONS (2.0) frames
}
```

### Why 0.5?

- Above the 0.45 trigger threshold
- Far above noise (silence gate blocks RMS < 0.0005, model produces <0.01 on non-wake speech)
- Covers both enrolled and non-enrolled speakers:
  - Enrolled speaker: model produces 0.89+
  - Non-enrolled speaker: model produces 0.67+
  - 0.5 covers both cases

### Logging

```rust
if avg >= SINGLE_FRAME_HIGH_CONFIDENCE {
    tracing::info!(
        "wake: high-confidence single-frame trigger (avg={:.3}, prob={:.3})",
        avg, probability
    );
}
```

## Why prem224k's approach is better than prem22k's

| Approach | How it works | False positive risk |
|---|---|---|
| **prem22k**: `MIN_POSITIVE_DETECTIONS = 1.0` | ANY single frame above 0.45 triggers | Higher — noise spikes at 0.46+ would trigger |
| **prem224k**: `SINGLE_FRAME_HIGH_CONFIDENCE = 0.5` | Only 0.5+ single frames trigger instantly; 0.45-0.5 still needs 2 frames | Lower — noise rarely reaches 0.5 |

prem224k's approach is more precise: high-confidence detections trigger
instantly, but borderline detections still require multi-frame smoothing.

## Files Changed

- `src-tauri/src/wakeword_oww.rs` — SINGLE_FRAME_HIGH_CONFIDENCE constant, two-path calculate_average()
