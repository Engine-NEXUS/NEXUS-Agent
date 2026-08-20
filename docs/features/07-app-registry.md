# Feature: App Registry (Pre-Indexed Launcher)

> A Raycast/Alfred-style pre-indexed app launcher that resolves "open youtube" to an actual app launch in ~1 ms instead of ~1.5 seconds.

**Source files:**
- `src-tauri/src/app_registry.rs` — the registry
- `src-tauri/src/command_executor.rs` — calls `lookup()` + `launch()`

---

## The Problem

The old approach ran `Get-StartApps` (PowerShell) on every "open <app>" command. This took ~566 ms per call. With 30+ commands, the delay was noticeable.

## The Solution

Pre-index all installed apps at startup, cache to disk, and look up in O(1) at command time.

```
STARTUP (background thread):
  1. Load disk cache (instant if it exists)
  2. Build in-memory HashMap: { "chrome" → AppEntry, "youtube" → AppEntry, ... }
  3. Background refresh every 5 minutes (re-scan installed apps)

ON COMMAND ("open youtube"):
  1. HashMap lookup: "youtube" → AppEntry { launch: Url { url: "https://youtube.com" } }
  2. Try focus existing window (if app is running)
  3. If not running → launch new instance
  4. If not installed → URL fallback
  5. Record usage (for ranking)
  Total: ~1 ms
```

## Launch Methods (Cross-Platform)

| Method | Platform | Example |
|--------|----------|---------|
| `Aumid` | Windows | `shell:AppsFolder\{aumid}` via `ShellExecuteW` (UWP apps) |
| `Exe` | Windows | Direct exe path via `ShellExecuteW` (Win32 apps) |
| `Bundle` | macOS | `open -b com.apple.Safari` (by bundle ID) |
| `AppPath` | macOS | `open -a /Applications/Chrome.app` (by path) |
| `DesktopExec` | Linux | Exec line from `.desktop` file |
| `Url` | All | `open::that("https://youtube.com")` (URL fallback) |

## Resolution Priority

When the user says "open chrome":

1. **Registry hit?** → `lookup("chrome")` returns `AppEntry`.
2. **Focus existing?** → `try_focus_existing()` — if Chrome is already running, focus its window.
3. **Launch new?** → `launch()` — if Chrome is installed but not running, launch it.
4. **URL fallback?** → If Chrome isn't installed, open `https://...` in the default browser.
5. **Not found** → "Didn't find that, sir."

## Fuzzy Matching

The registry supports fuzzy matching for app names:
- "chrome" matches "Google Chrome"
- "vs code" matches "Visual Studio Code"
- "file explorer" matches "Windows File Explorer"

## Disk Cache

The cache is stored as JSON in the app data directory:
```json
{
  "version": 1,
  "updated_at": 1697...",
  "entries": [
    { "display_name": "Google Chrome", "search_names": ["chrome", "google chrome"], "launch": { "type": "exe", "path": "C:\\...\\chrome.exe" }, "use_count": 5, "last_used": 1697... }
  ]
}
```

On startup, the disk cache is loaded instantly. The background refresh updates it every 5 minutes (and on first launch if the cache doesn't exist).

## Usage Tracking

Each successful launch increments `use_count` and updates `last_used`. This enables future ranking (most-used apps first) — though currently all matches are exact/fuzzy, not ranked by usage.
