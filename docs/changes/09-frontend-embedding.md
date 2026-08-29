# Change: Frontend Not Embedded in .exe

**Commit:** `fc46cc7` ("fix: frontend not embedded in .exe (root cause of ERR_CONNECTION_REFUSED)")
**Date:** 2026-08-19

---

## Problem

The release build of `nexus.exe` showed `ERR_CONNECTION_REFUSED` when trying to load the frontend. The WebView couldn't find the HTML/JS/CSS files.

## Root Cause

The frontend wasn't being built before the Tauri build. The `beforeBuildCommand` in `tauri.conf.json` was either missing or pointing at the wrong directory:

```json
// Problematic:
"beforeBuildCommand": "npm --prefix ../frontend run build"
```

When `cargo tauri build` was run from an unexpected working directory, `../frontend` resolved incorrectly → the frontend wasn't built → no `dist/` folder → WebView had nothing to load.

## Fix

1. **Build the frontend explicitly** from the project root before running `cargo tauri build`:
   ```powershell
   cd C:\PROJECTS\ULTRON\frontend
   npm run build
   cd ..\src-tauri
   cargo tauri build
   ```

2. **Tauri embeds the `dist/` folder** into the executable via `tauri generate_context!()`. The `tauri.conf.json` `build.frontendDist` (or `build.devUrl` for dev) points to `../frontend/dist`.

3. **In production**, the frontend is served from `tauri.localhost` (embedded), not from `localhost:5173` (Vite dev server).

## Dev vs Prod URLs

| Mode | Frontend URL | How it's served |
|------|-------------|-----------------|
| Dev (`cargo tauri dev`) | `http://localhost:5173` | Vite dev server (HMR) |
| Prod (`cargo tauri build`) | `http://tauri.localhost` | Embedded in the .exe |

The `isTauriRuntime` check in `main.tsx` ensures the frontend only calls Tauri IPC when running inside the WebView (not in a browser).

## Remaining Issue

The `beforeBuildCommand` path issue remains in `tauri.conf.json` and should be corrected for repeatable installer builds from arbitrary working directories. The current workaround is to build the frontend manually before `cargo tauri build`.

## Files Changed

- `frontend/dist/` — rebuilt and embedded in the .exe.
- `src-tauri/tauri.conf.json` — `frontendDist` points to `../frontend/dist`.

## Result

- `nexus.exe` loads the frontend from `tauri.localhost` (embedded).
- No `ERR_CONNECTION_REFUSED`.
- No dependency on Vite dev server in production.
