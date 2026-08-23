# 23 — Meeting Detection Self-Trigger Fix

> **Commit:** `d1e9d20` — `fix: meeting detection self-trigger — NEXUS detects own WebView2 as meeting`
> **Date:** 2026-08-23
> **Status:** Complete

---

## Problem

NEXUS's meeting detection system was falsely flagging its own WebView2 child process (`msedgewebview2.exe`) as a meeting application. This caused:

1. Wake-word detection to be suppressed (NEXUS wouldn't respond to "NEXUS")
2. TTS to be silenced (NEXUS couldn't speak responses)
3. A deadlock state where NEXUS woke up but couldn't respond or speak

The root cause: `msedgewebview2.exe` is the rendering engine for Tauri v2's webview. NEXUS spawns it as a child process, but the meeting detector was scanning all running processes without excluding NEXUS's own children.

---

## Root Cause

In `src-tauri/src/meeting_detect.rs`, the meeting detection logic:

1. Enumerated all processes using `Toolhelp32Snapshot`
2. Checked each process name against a list of known meeting apps (Zoom, Teams, Meet, etc.)
3. Did NOT exclude processes that were descendants of `nexus.exe`

Since `msedgewebview2.exe` can appear in meeting app lists (Edge is used for Teams/Meet), and NEXUS's WebView2 process has a similar name, the detector triggered on NEXUS's own rendering process.

---

## Fix

### 1. Descendant PID Exclusion

Added a BFS (Breadth-First Search) traversal using `Toolhelp32Snapshot` to build a set of all descendant PIDs of `nexus.exe`. Any process in this set is excluded from meeting detection.

```rust
fn get_descendant_pids(parent_pid: u32) -> HashSet<u32> {
    // BFS through Toolhelp32Snapshot to find all children of parent_pid
    // Returns a set that can be checked in O(1) per process
}
```

### 2. Explicit `msedgewebview2.exe` Skip

Even if the descendant check fails (e.g. PID reuse), `msedgewebview2.exe` is explicitly skipped:

```rust
if proc_name.eq_ignore_ascii_case("msedgewebview2.exe") {
    continue;  // NEXUS's own webview — never a meeting
}
```

### 3. Preserved Real Meeting Detection

Actual meeting processes (Zoom, Teams, Google Meet via browser, Webex, etc.) are still detected correctly. The fix only excludes NEXUS's own child processes.

---

## Files Modified

| File | Change |
|------|--------|
| `src-tauri/src/meeting_detect.rs` | Added descendant PID BFS + `msedgewebview2.exe` skip |

---

## Verification

- NEXUS no longer enters the deadlock state when WebView2 starts
- Wake-word detection works while NEXUS is visible
- TTS plays normally while the webview is running
- Real meeting apps (Zoom, Teams) are still detected correctly
