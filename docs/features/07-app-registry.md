# Feature: App Registry (Pre-Indexed Launcher + Resolution Cache)

> A Raycast/Alfred-style pre-indexed app launcher that resolves "open gmail" to the installed Gmail PWA in ~0.01 ms. Supports native apps, Microsoft Store apps, browser PWAs, and URL fallback across Windows, macOS, and Linux.

**Source files:**
- `src-tauri/src/app_registry.rs` — the registry, resolution cache, daily scan
- `src-tauri/src/command_executor.rs` — calls `lookup()` + `launch()`
- `frontend/src/intent/parser.ts` — sends `open_app` to Rust (no URL short-circuit)

---

## The Problem

The old approach ran `Get-StartApps` (PowerShell) on every "open <app>" command. This took ~566 ms per call. Worse, the frontend short-circuited known URL aliases (gmail, spotify, youtube) to browser tabs **before** Rust could check if a native app was installed.

## The Solution

Pre-index all installed apps at startup, cache to disk, and look up in O(1) at command time. The frontend no longer short-circuits to URLs — all "open" commands go to Rust, which resolves in this priority:

1. **Resolution cache** (phrase → app, remembers previous choice) — O(1) ~0.01ms
2. **App already running?** → Focus its window
3. **Native app installed?** → Launch it (Win32/Store/UWP/PWA)
4. **URL fallback** → Open in browser
5. **Not found** → "Didn't find that, sir."

```
STARTUP:
  1. Load disk cache (instant if it exists)
  2. Check: was the cache scanned TODAY?
     ├── YES → skip scan (apps haven't changed)
     └── NO  → background scan (catches installs/uninstalls)
  3. Load resolution cache (phrase → app mapping)
  4. Pre-initialize mic + VAD (see hot-mic feature)

ON COMMAND ("open gmail"):
  1. Resolution cache hit? → "gmail" → "Brave PWA" → LAUNCH (~0.01ms)
  2. Cache miss → HashMap lookup: "gmail" → AppEntry
  3. Focus existing window (if app is running)
  4. If not running → launch new instance
  5. If not installed → URL fallback
  6. Save result to resolution cache for next time
  Total: ~1 ms (first time), ~0.01 ms (repeat)
```

## Launch Methods (Cross-Platform)

| Method | Platform | Example |
|--------|----------|---------|
| `Aumid` | Windows | `shell:AppsFolder\{aumid}` via `ShellExecuteW` (UWP/Store/PWA) |
| `Exe` | Windows | Direct exe path via `ShellExecuteW` (Win32 apps) |
| `Bundle` | macOS | `open -b com.apple.Safari` (by bundle ID) |
| `AppPath` | macOS | `open -a /Applications/Chrome.app` (by path) |
| `DesktopExec` | Linux | Exec line from `.desktop` file |

## App Discovery Sources

### Windows
1. `Get-StartApps` — discovers Win32, UWP, Store, PWA, Squirrel apps
2. Known native app paths (calc.exe, notepad.exe, etc.)
3. App Paths registry (`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths`)
4. Uninstall registry (installed programs)
5. Start Menu `.lnk` resolution
6. PATH executable scan (`where.exe`)
7. URL fallback entries (only if no native app exists)

### macOS
1. `/Applications`, `/System/Applications`, `~/Applications` — `.app` bundles
2. Spotlight (`mdfind kMDItemKind == 'Application'`) — non-standard locations
3. **PWA directories** — `~/Applications/Chrome Apps`, `Brave Apps`, `Edge Apps`
4. Bundle ID extraction from `Info.plist`

### Linux
1. XDG `.desktop` files (`/usr/share/applications`, `~/.local/share/applications`)
2. Flatpak apps (`flatpak list`)
3. Snap apps (`/var/lib/snapd/desktop/applications`)
4. **PWA `.desktop` files** — browser profile dirs with `WebApp=true`

## Resolution Cache

A separate JSON file (`app_resolution_cache.json`) stores phrase → app mappings:

```json
{
  "version": 1,
  "entries": {
    "gmail": {
      "display_name": "Gmail",
      "matched_name": "gmail",
      "use_count": 15,
      "last_used": 1724438400
    },
    "spotify": {
      "display_name": "Spotify",
      "matched_name": "spotify",
      "use_count": 8,
      "last_used": 1724438300
    }
  }
}
```

**Benefits:**
- O(1) resolution on repeat commands (~0.01ms vs ~1ms)
- Remembers user preferences when multiple apps match the same name
- Stale entries auto-fallthrough if app is uninstalled
- Usage-based ranking: most-used app wins when ambiguous

## Daily Scan

The OS scan runs **once per day** (down from every 5 minutes):

| Metric | Before | After |
|--------|--------|-------|
| Scans per day | 288 (every 5 min) | 1 (daily) |
| Scanning overhead | 99.7% waste | Minimal |

**Logic:**
- Disk cache stores `last_scan_date` (YYYY-MM-DD)
- If cache is from today → skip scan entirely (instant startup)
- If cache is from previous day → background scan on startup
- Hourly check: if new day detected → one scan
- Manual refresh: `refresh_app_registry` IPC command ("NEXUS, refresh apps")

## Disk Cache Format (v2)

```json
{
  "version": 2,
  "updated_at": 1724438400,
  "last_scan_date": "2026-08-23",
  "entries": [
    {
      "display_name": "Gmail",
      "search_names": ["gmail", "google mail"],
      "launch": { "type": "aumid", "aumid": "Brave._crx_fmgjjmmmlfcabfkddbjimcfncm" },
      "use_count": 15,
      "last_used": 1724438400
    }
  ]
}
```

## URL Fallback Logic

URL fallbacks are only added for services where **no native app exists**:

```rust
let already_exists = entries.iter().any(|e| {
    e.search_names.iter().any(|s| search.contains(&s.as_str()))
});
if already_exists { continue; }  // Don't add URL fallback if native app exists
```

This means:
- If Gmail PWA is installed → no URL fallback for "gmail" → PWA always wins
- If Gmail PWA is NOT installed → URL fallback added → browser tab opens

## "In Browser" Escape Hatch

The user can force browser behavior with explicit commands:
- "open gmail **in browser**" → forces `open_url`
- "open gmail **website**" → forces `open_url`
- "open gmail **on the web**" → forces `open_url`

This gives the user control when they explicitly want the browser version, even if a native app is installed.

## Usage Tracking

Each successful launch:
1. Increments `use_count` in the app cache
2. Updates `last_used` timestamp
3. Saves to the resolution cache (phrase → app mapping)
4. Persists both caches to disk in the background

When multiple apps match the same name (e.g. "Figma" → Squirrel app + Brave PWA), the one with the highest `use_count` wins.
