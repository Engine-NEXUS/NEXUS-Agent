# 27 — Native App Priority + Resolution Cache + Daily Scan

> **Commit:** `02d162c` — `feat: native app priority + resolution cache + daily scan`
> **Date:** 2026-08-23
> **Status:** Complete

---

## Problem

When the user said "open gmail", NEXUS always opened a **browser tab** — even when a Gmail PWA was installed via Brave. Same for Spotify (Store app installed), YouTube (PWA installed), Netflix (Store app installed), etc.

The user wanted:
- Installed native apps to open instead of browser tabs
- Microsoft Store/UWP/MSIX apps to open when installed
- Browser-installed PWAs to open as apps, not tabs
- Cross-platform support (Windows, macOS, Linux)
- No noticeable command delay
- A "permanent" solution, not a superficial URL-map fix

---

## Root Cause

### Layer 1: Frontend Short-Circuit (PRIMARY BUG)

In `frontend/src/intent/parser.ts`, the `open` command handler checked `URL_MAP` **before** sending the intent to Rust:

```typescript
// BROKEN: URL_MAP short-circuit
const url = URL_MAP[cleaned];  // "gmail" → "https://mail.google.com"
if (url) {
  return { action: "open_url", target: cleaned, url };  // ← ALWAYS browser tab
}
```

For any service in `URL_MAP` (gmail, spotify, youtube, netflix, etc.), the frontend immediately returned `open_url` → browser tab. Rust never got a chance to check if a native app was installed.

### Layer 2: Rust Already Had the Correct Logic

The Rust resolver in `command_executor.rs` already had the right priority:
1. Check if app is running → focus its window
2. Check if app is installed → launch it
3. URL fallback → open in browser

And `app_registry.rs` already correctly skipped URL fallbacks when native apps existed:
```rust
let already_exists = entries.iter().any(|e| {
    e.search_names.iter().any(|s| search.contains(&s.as_str()))
});
if already_exists { continue; }  // Don't add URL fallback if native app exists
```

### Layer 3: Get-StartApps Finds Everything

`Get-StartApps` discovers all app types on Windows:
- Microsoft Store apps (Spotify, Netflix, WhatsApp)
- Browser PWAs (Gmail, YouTube, Figma — via Brave)
- Squirrel desktop apps (Discord, Figma)
- Win32 apps (Steam, VS Code, Office)
- Windows native apps (Notepad, Calculator, Paint)

**The registry already had all these in its cache.** The problem was purely that the frontend never sent `open_app` to Rust for known URL targets.

---

## Fix — 8 Phases

### Phase 1+2: Remove URL_MAP Short-Circuit (`parser.ts`)

- Removed the 86-line `URL_MAP` constant from the frontend
- Removed the `if (url) return open_url` short-circuit
- All "open <app>" commands now go to Rust as `open_app`
- Rust resolves: running → installed (native/PWA/Store) → URL fallback
- Renamed to `BROWSER_FORCE_URL_MAP` (only for explicit "in browser" commands)

### Phase 3: Rust 3-Tier Resolution (Already Correct)

No changes needed. The Rust code already had:
1. Registry lookup (includes native apps, Store apps, PWAs)
2. Legacy fallback: check running → check installed → URL fallback

### Phase 4: "in browser" Escape Hatch (`parser.ts`)

Added regex for explicit browser commands:
- "open gmail **in browser**" → forces `open_url`
- "open gmail **website**" → forces `open_url`
- "open gmail **on the web**" → forces `open_url`
- Regular "open gmail" → native app if installed

### Phase 5: Resolution Cache (`app_registry.rs`)

New `app_resolution_cache.json` stores phrase → app mappings:

```json
{
  "gmail": {
    "display_name": "Gmail",
    "matched_name": "gmail",
    "use_count": 15,
    "last_used": 1724438400
  }
}
```

**Flow:**
```
"open gmail"
  → 1. Resolution cache hit? → launch saved app (~0.01ms)
  → 2. App registry HashMap hit? → launch + save to cache (~1ms)
  → 3. Legacy fallback: running → installed → URL
  → 4. Save result to resolution cache for next time
```

Benefits:
- O(1) resolution on repeat commands (~0.01ms vs ~1ms)
- Remembers user preferences when multiple apps match the same name
- Stale entries auto-fallthrough if app is uninstalled

### Phase 6: Usage-Based Ranking

When multiple apps match a name (e.g. "Figma" → both Squirrel app AND Brave PWA exist), the one with the highest `use_count` wins:

```
"open figma"
  → Registry returns 2 matches:
    - Figma (Squirrel) — use_count: 0
    - Figma (Brave PWA) — use_count: 5  ← winner
  → Launch Brave PWA (your preferred Figma)
```

### Phase 7: Daily Scan (`app_registry.rs`)

Changed the OS scan from every 5 minutes → once per day:

```
NEXUS starts
  → Load app_cache.json from disk (instant)
  → Was cache scanned TODAY?
    ├── YES → skip scan (apps haven't changed)
    └── NO  → background scan (catches installs/uninstalls)
  → Hourly check: is it a new day?
    └── YES → one scan → save to disk
```

| Metric | Before | After |
|--------|--------|-------|
| Scans per day | 288 (every 5 min) | 1 (daily) |
| Scanning overhead | 99.7% waste | Minimal |

**Disk cache format v2:**
```json
{
  "version": 2,
  "updated_at": 1724438400,
  "last_scan_date": "2026-08-23",
  "entries": [...]
}
```

**Manual refresh:** Added `refresh_app_registry` IPC command for "NEXUS, refresh apps".

### Phase 8: Cross-Platform PWA Discovery

| Platform | PWA Discovery | Status |
|----------|--------------|--------|
| Windows | `Get-StartApps` already finds PWAs | No changes needed |
| macOS | Scan `~/Applications/Chrome Apps`, `Brave Apps`, `Edge Apps` | **Added** |
| Linux | Scan browser `.desktop` files with `WebApp=true` | **Added** |

---

## Resolution Priority

The complete resolution order after all phases:

```
1. Resolution cache (phrase → app, remembers previous choice) — O(1) ~0.01ms
2. App already running? → Focus its window
3. Native app installed? → Launch it (Win32/Store/UWP/PWA)
4. URL fallback → Open in browser
5. Nothing found → "Didn't find that, sir."
```

---

## Test Results

| Test | Result |
|------|--------|
| TypeScript compile | 0 errors |
| Rust cargo check | 0 errors |
| Release build | Success (3m 54s) |
| Parser tests | 17/17 passed |
| App cache format | Version 2, last_scan_date=2026-08-23 |
| Native app entries | 10/10 correct (all NATIVE, not URL) |

### App Resolution Verified

| Service | AppID | Type |
|---------|-------|------|
| Gmail | `Brave._crx_fmgjjmmmlfcabfkddbjimcfncm` | Brave PWA |
| YouTube | `Brave._crx_agimnkijcamfeangaknmldooml` | Brave PWA |
| Spotify | `SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify` | Store app |
| Netflix | `4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App` | Store app |
| WhatsApp | `5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App` | Store app |
| Discord | `com.squirrel.Discord.Discord` | Desktop app |
| Claude | `Claude_pzs8sxrjxfjjc!Claude` | Store app |
| ChatGPT | `OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0!ChatGPT` | Store app |
| Notepad | `Microsoft.WindowsNotepad_8wekyb3d8bbwe!App` | Windows app |
| Calculator | `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App` | Windows app |

---

## Files Modified

| File | Changes |
|------|---------|
| `frontend/src/intent/parser.ts` | Removed `URL_MAP` short-circuit, added "in browser" escape hatch, renamed to `BROWSER_FORCE_URL_MAP` |
| `src-tauri/src/app_registry.rs` | Resolution cache, daily scan, cross-platform PWA discovery, cache v2 format, `force_refresh()` |
| `src-tauri/src/commands.rs` | Added `refresh_app_registry` IPC command |
| `src-tauri/src/lib.rs` | Registered `refresh_app_registry` command |

---

## User Experience After Fix

| You say | Native app installed? | What opens |
|---------|----------------------|------------|
| "open gmail" | Yes (Brave PWA) | **Gmail PWA** |
| "open spotify" | Yes (Store app) | **Spotify app** |
| "open youtube" | Yes (Brave PWA) | **YouTube PWA** |
| "open netflix" | Yes (Store app) | **Netflix app** |
| "open notepad" | Yes (Windows app) | **Notepad** |
| "open gmail in browser" | Any | **Browser tab** (forced) |
| "open xyz" (not installed) | No | **Browser tab** (URL fallback) |
| "go to youtube.com" | N/A | **Browser tab** (raw URL) |
