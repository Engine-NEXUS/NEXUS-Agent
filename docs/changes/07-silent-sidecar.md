# Change: Silent Sidecar (pythonw.exe)

**Commit:** `4c987d5` + `3cfa5ef` ("fix: silent sidecar (no terminal) + port 49152" / "fix: mic prompt every restart + terminal window on every boot")
**Date:** 2026-08-19

---

## Problem

Every time NEXUS started, a Python terminal window popped up on the screen. This was ugly and made NEXUS look like a developer tool, not a polished assistant.

## Root Cause

The sidecar was launched with `python.exe`, which is a **console-subsystem** executable — it always opens a terminal window.

The `CREATE_NO_WINDOW` flag (`0x08000000`) was added to suppress the window, but it's **not bulletproof** on Windows 11 + Windows Terminal. Under certain conditions, a window still flashed.

## Fix

Switch to `pythonw.exe` — the **GUI-subsystem** Python executable.

```rust
// sidecar_manager.rs
#[cfg(target_os = "windows")]
const CANDIDATES: &[&str] = &["pythonw", "python", "python3", "py"];
```

`pythonw.exe`:
- Lives in the **same install directory** as `python.exe` — it's on PATH whenever Python is.
- Is a GUI-subsystem executable — it **can never** show a console window.
- Has no stdout/stderr by default — we redirect to a log file.

## Log Redirection

Since `pythonw.exe` has no console, stdout/stderr must be redirected to a file:

```rust
let log_path = resolve_log_path();  // %LOCALAPPDATA%\com.nexus.assistant\sidecar.log
let log_file = std::fs::File::create(&log_path)?;
let log_stderr = log_file.try_clone()?;
cmd.stdout(Stdio::from(log_file));
cmd.stderr(Stdio::from(log_stderr));
```

The log is **truncated** on each startup (not appended).

## CREATE_NO_WINDOW Still Set

Even with `pythonw.exe`, we still set `CREATE_NO_WINDOW` as a belt-and-suspenders measure:

```rust
#[cfg(target_os = "windows")]
{
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
```

This ensures no window appears even if `pythonw.exe` spawns child processes.

## Verification

- `tasklist` shows `pythonw.exe` running (not `python.exe`).
- No terminal window appears on screen.
- Sidecar logs are written to `%LOCALAPPDATA%\com.nexus.assistant\sidecar.log`.
- Health endpoint responds on port 49152.

## Files Changed

- `src-tauri/src/sidecar_manager.rs` — `CANDIDATES` array reordered to prefer `pythonw` on Windows.
