# 18 — Orb Window Revert

> **Commit:** `4e1086c` — `revert: restore original orb window — keep settings window + setup wizard`
> **Date:** 2026-08-20
> **PR:** #16 (merged as `ed1c4b8`)
> **Status:** Complete — orb restored to original

---

## What Changed

After the white theme UI overhaul (commit `5ee9275`) expanded the orb window from 200x200 to 320x440 with a white card, status bar, and transcript panel, the user was upset:

> "why did u create that bring the orginal self back i said for the installer interface when a user instal exe for steup create the ineterface bring my orl aniamtion bac i dont want any chnage to be made in that"

The orb window was reverted to its exact original state. The settings window and setup wizard redesigns were kept since they are separate from the orb.

---

## Files Reverted

### `frontend/src/App.tsx`
- **From:** 102 lines, white card with StatusBar + TranscriptPanel, 320x440
- **To:** 82 lines, transparent orb only, 200x200
- The `App` component now only renders the `Avatar` inside a transparent `#app` div
- Auto-hide timer (8 seconds) preserved
- Native window visibility with deferred hide for slide-down animation preserved
- Click-through toggle preserved

### `frontend/src/avatar/Avatar.tsx`
- **From:** 120px, 6 states (idle/listening/thinking/speaking/connecting/error)
- **To:** 180px, 4 states (idle/listening/thinking/speaking)
- Lottie animation segments preserved:
  - `SEG_LOADING` = [171, 260] — loading circles
  - `SEG_SMILE_ARRIVE` = [261, 316] — smile arrives
  - `FRAME_HOLD_SMILE` = 300 — stable smile hold frame
- Animation modes: `wake-loading`, `wake-smile`, `idle-smile`, `loading-loop`, `holding`

### `frontend/src/store/assistant.ts`
- **From:** 6 states (added `connecting` and `error`)
- **To:** 4 states (`idle`, `listening`, `thinking`, `speaking`)
- Zustand store with: `state`, `visible`, `messages`, `setState`, `setVisible`, `addUserMessage`, `addAssistantMessage`, `reset`

### `frontend/src/styles.css`
- **From:** White card styling, 320x440, transcript/caption visible
- **To:** Transparent background, 200x200, transcript/caption hidden
- Slide-up animation: `cubic-bezier(0.34, 1.56, 0.64, 1)` (bouncy spring)
- Slide-down animation: `cubic-bezier(0.4, 0, 0.7, 1)` (gravity ease-in)
- CSS fallback orb: 80px blue gradient circle (only shows if Lottie fails to load)

### `src-tauri/tauri.conf.json`
- Main window: 320x440 → 200x200
- Settings window config kept (600x720)

### `src-tauri/src/lib.rs`
- Orb positioning: 320px → 200px
- Settings IPC commands kept registered

---

## Files Deleted

- `frontend/src/components/StatusBar.tsx` — status text bar (no longer needed)
- `frontend/src/components/TranscriptPanel.tsx` — conversation transcript (no longer needed)

These were deleted because they referenced `STATUS_TEXT` and other exports from the 6-state assistant store that no longer existed after the revert, causing TypeScript compilation errors.

---

## Files Kept (Not Reverted)

- `frontend/src/theme/tokens.css` — CSS design tokens (used by settings + setup)
- `frontend/src/settings/` — entire settings window (SettingsApp.tsx, settings.css, main.tsx)
- `frontend/settings.html` — settings HTML entry point
- `frontend/src/setup/SetupApp.tsx` — 4-step setup wizard
- `frontend/src/setup/setup.css` — white theme setup styles
- `frontend/package.json` — framer-motion dependency
- `src-tauri/src/commands.rs` — settings IPC commands
- `src-tauri/src/tray.rs` — tray opens settings window

---

## Verification

| Check | Result |
|-------|--------|
| App.tsx line count | 82 (original) |
| Avatar.tsx size | 180px (original) |
| styles.css | No `nx-card` class (original) |
| assistant.ts states | 4 (original) |
| tauri.conf.json main window | 200x200 (original) |
| TypeScript compilation | Pass (0 errors) |
| Release build | Pass (4m 19s) |
| NEXUS launches | Pass |
| Sidecar healthy | Pass |

---

## Lesson

The orb is the sacred core of NEXUS. It is a 200x200 transparent window with a Lottie animation (loading circles + smile face) that slides up from the bottom-center of the screen. **Never modify the orb without explicit user request.** The user's words:

> "bring my orl aniamtion bac i dont want any chnage to be made in that"
