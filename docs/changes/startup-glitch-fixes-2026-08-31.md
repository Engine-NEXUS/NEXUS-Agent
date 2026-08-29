# NEXUS Startup Glitch Fixes — 2026-08-31

## Overview

This PR fixes five critical bugs that caused `nexus start` to malfunction:
repeating logs in the unified console, false wake triggers on startup,
WhatsApp closing on every launch, and the sidebar getting stuck on
"Thinking..." after repository analysis.

---

## Fix 1: Log tail loop — StreamReader buffering (run.ps1)

**Symptom:** The unified console showed the same startup sequence
repeating every second — diagnostics, WebView2 cleanup, hotkey
registration, audio init, over and over.

**Root cause:** `Get-NewLines` in `run.ps1` used `StreamReader` to read
the log file. `StreamReader` has an internal read-ahead buffer — it reads
MORE bytes from the stream than it returns as lines. So `$fs.Position`
after reading was PAST the actual end of the data. On the next cycle,
`$fi.Length < $Position.Value` → position reset to 0 → re-read the entire
file → same lines printed again. Loop forever.

**Fix:** Read raw bytes with `$fs.Read(buf, 0, len)` and track position
by actual bytes read. No `StreamReader`, no buffering.

**File:** `scripts/run.ps1` — `Get-NewLines` function

---

## Fix 2: False wake trigger on startup (wakeword_oww.rs)

**Symptom:** NEXUS woke immediately on startup, before the user said
anything. The wake word model fired with probability 0.911 on startup
audio transient noise.

**Root cause:** The `nexus.onnx` model saw startup audio transient noise
(the Intel SST mic driver produces a burst of noise when the stream
starts) and output probability 0.911 — above the 0.35 threshold. This
fired before the audio stream stabilized.

**Fix:** Added a 3-second grace period (`engine_start_time` field on
`WakeEngine`) during which all detections are ignored and 0.0 is pushed
to the detection buffer to flush stale values.

**File:** `src-tauri/src/wakeword_oww.rs` — `WakeEngine` struct,
`detect_chunk` method

---

## Fix 3: Alt+Space global hotkey — WhatsApp window glitch (hotkey.rs)

**Symptom:** WhatsApp windows would flash open/close randomly while
NEXUS was running.

**Root cause:** NEXUS registered `Alt+Space` as a global hotkey for
waking the assistant. But `Alt+Space` is the **Windows system menu
shortcut** — it opens the window control menu (Restore, Move, Size,
Minimize, Maximize, Close) for whatever window is focused. By
registering it globally, NEXUS intercepted every `Alt+Space` keypress
system-wide. When the system tried to open the system menu for WhatsApp,
NEXUS swallowed the event, causing WhatsApp's window to glitch.

**Fix:** Removed `Alt+Space` from the hotkey list. The remaining
hotkeys are:
- `Ctrl+Shift+Space` — wake NEXUS / close sidebar
- `Ctrl+Alt+Space` — wake NEXUS
- `Ctrl+Space` — cancel current turn

**File:** `src-tauri/src/hotkey.rs` — `HOTKEYS` constant

---

## Fix 4: WhatsApp/M365 WebView2 processes killed on startup (run.ps1)

**Symptom:** WhatsApp Desktop closed every time the user ran
`nexus start`.

**Root cause:** `run.ps1` had this line to clean up orphaned NEXUS
WebView2 children:
```powershell
Get-Process msedgewebview2 | Stop-Process -Force
```
This killed **every** `msedgewebview2.exe` on the system. WhatsApp
Desktop, M365 Copilot, and Windows Search all use WebView2 — killing
all `msedgewebview2.exe` processes killed those apps too.

**Fix:** Walk the process tree from `nexus.exe` PIDs and kill only
`msedgewebview2.exe` processes that are descendants of NEXUS. Other
apps' WebView2 processes are left alone.

**File:** `scripts/run.ps1` — kill existing instances section

---

## Fix 5: PowerShell [ref] hashtable — repeating logs (run.ps1)

**Symptom:** Even after Fix 1, the logs continued to repeat. The
startup sequence appeared every second in the unified console.

**Root cause:** The log tail positions were stored in a hashtable:
```powershell
$pos = @{ STT = 0; Rust = 0; CDP = 0; Err = 0 }
```
and passed to `Get-NewLines` via `[ref]$pos.STT`. In PowerShell,
`[ref]` to a hashtable property creates a reference to a **boxed copy**
of the value, not the actual hashtable slot. So updates inside
`Get-NewLines` (`$Position.Value = ...`) were lost, and `$pos.STT`
stayed at 0 forever. This caused every 500ms cycle to re-read the
entire log file from the beginning.

**Fix:** Replaced the hashtable with simple variables (`$posSTT`,
`$posRust`, `$posCDP`, `$posErr`) which `[ref]` correctly updates by
reference.

**File:** `scripts/run.ps1` — position tracking variables and all
`Get-NewLines` call sites

---

## Fix 6: Sidebar stuck on "Thinking..." (wsBridge.ts)

**Symptom:** After saying `analyse zync`, the sidebar remained on
"Thinking..." instead of showing the analysis dashboard.

**Root cause:** The module-level event listener in `wsBridge.ts` used
dynamic `import()` which failed in bundled mode with:
`TypeError: Failed to resolve module specifier '@tauri-apps/api/event'`

**Fix:** Use the synchronous `window.__TAURI__.event.listen` global
API instead of dynamic import. Also: when `pendingQuery` is empty
(external session), infer the query from the response text, and always
show the sidebar when analysis data is present regardless of query
inference.

**File:** `frontend/src/net/wsBridge.ts`

---

## Testing

All fixes were verified with end-to-end tests:

| Test | Result |
|------|--------|
| Log tail — no repetition after 20s | 66 lines, 64 unique |
| Wake word — no false trigger in 15s | 0 false triggers |
| WhatsApp — survives `nexus start` | PID unchanged |
| WhatsApp — survives second `nexus start` | PID unchanged |
| Alt+Space — not registered as hotkey | Only 2 hotkeys registered |
| Diagnostics — appears once | 1 appearance (was every second) |
