# Feature 15 — Setup Wizard

> **Window label:** `setup`
> **Size:** 520x680
> **Entry point:** `frontend/setup.html` → `frontend/src/setup/main.tsx` → `SetupApp.tsx`
> **Added in:** commit `5ee9275` (initial), `6663e57` (white theme), `03a34ad` (multi-option accounts)
> **PR:** #16

---

## Overview

A 4-step white-themed onboarding wizard that appears on first launch. Guides the user through server configuration, voice enrollment, and account connecting.

---

## Window Configuration

```json
{
  "label": "setup",
  "title": "NEXUS Setup",
  "width": 520,
  "height": 680,
  "resizable": false,
  "decorations": true,
  "transparent": false,
  "visible": false,
  "center": true,
  "url": "setup.html"
}
```

---

## Wizard Steps

### Step 1: Welcome
- NEXUS gradient logo
- "AI Desktop Assistant" tagline
- Brief description
- "Get Started" button → Step 2
- Progress indicator: ●○○○

### Step 2: Server Configuration
- Server URL input (default: `ws://127.0.0.1:49152/ws`)
- User ID input (default: `local-user`)
- Device ID input (default: `local-device`)
- "Test Connection" button
- Connection status indicator (green check / red x)
- "Back" and "Next" buttons
- Progress indicator: ●●○○

### Step 3: Voice Enrollment
- Instructions: "Record 5 clips of your voice saying 'NEXUS'"
- Record button (large, gradient)
- Progress: "Clip 1/5", "Clip 2/5", etc.
- Playback for each clip
- "Skip" button (optional step)
- "Back" and "Finish" buttons
- Progress indicator: ●●●○

### Step 4: Accounts
- "Connect Your Accounts" header
- Description: "Connect Google and GitHub so NEXUS can manage your email, calendar, repos, and PRs."
- **Google card** with Google logo SVG icon
  - "Gmail · Calendar · Drive · Meet"
  - Connect / Disconnect / Not configured
- **GitHub card** with GitHub logo SVG icon
  - "Repos · Pull Requests · Issues"
  - Connect / Disconnect / Not configured
- API Keys section
- "Back" and "Finish" buttons
- Progress indicator: ●●●●

---

## Multi-Option Account Cards

### Google Card
```
┌──────────────────────────────────────────┐
│  [G]   Google              [Connect]     │
│        Gmail · Calendar · Drive · Meet    │
└──────────────────────────────────────────┘
```

- 48x48 white icon container with Google's 4-color logo SVG
- "Google" heading + service description
- States:
  - **Not connected:** Blue "Connect" button
  - **Connecting:** "Connecting..." (disabled button)
  - **Connected:** Green "Connected" badge + "Disconnect" button
  - **Not configured:** Yellow "Not configured" badge (server lacks OAuth config)

### GitHub Card
```
┌──────────────────────────────────────────┐
│  [G]   GitHub              [Connect]     │
│        Repos · Pull Requests · Issues     │
└──────────────────────────────────────────┘
```

- 48x48 dark icon container (#1F2937) with GitHub logo SVG (white)
- "GitHub" heading + service description
- Same states as Google card

### CSS
```css
.setup-provider--large {
  padding: var(--nx-space-5);
  gap: var(--nx-space-3);
}

.setup-provider-icon {
  width: 48px;
  height: 48px;
  border-radius: var(--nx-radius);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.setup-provider-icon--google {
  background: #FFFFFF;
  border: 1px solid var(--nx-border);
}

.setup-provider-icon--github {
  background: #1F2937;
  color: #FFFFFF;
}
```

---

## OAuth Flow

### Connect Flow
1. User clicks "Connect" on Google or GitHub card
2. Frontend calls `invoke("get_oauth_config", { provider })` to check if OAuth is configured
3. If configured, frontend opens the OAuth URL in the default browser
4. User authorizes in the browser
5. Browser redirects to `nexus://oauth/callback?code=...&state=...`
6. Tauri deep-link plugin captures the redirect
7. Frontend sends the auth code to the server
8. Server exchanges code for access/refresh tokens
9. Frontend polls `invoke("get_oauth_status", { provider })`
10. When connected, the card shows "Connected" badge

### Disconnect Flow
1. User clicks "Disconnect"
2. Frontend calls `invoke("disconnect_oauth", { provider })`
3. Server revokes tokens
4. Card reverts to "Connect" button

### Not Configured
If the server doesn't have OAuth credentials for a provider, the card shows a yellow "Not configured" badge instead of a Connect button.

---

## API Keys Section

The setup wizard also includes an API keys section for services that use API keys instead of OAuth:

- Claude API key
- Devin API key
- Antigravity API key
- Custom API keys

Users can:
- Add a new API key (provider name + key value)
- View existing keys (masked)
- Delete a key

Keys are stored encrypted on the server, not locally.

---

## Progress Indicator

Each step shows a progress indicator with 4 dots:
```
Step 1: ●○○○
Step 2: ●●○○
Step 3: ●●●○
Step 4: ●●●●
```

The active dot is filled with the gradient accent color. Inactive dots are light gray.

---

## CSS Styling

The setup wizard uses the shared design tokens from `frontend/src/theme/tokens.css`:
- White background
- Blue→purple gradient accents for buttons and active states
- 12px border radius
- Subtle shadows for cards
- Segoe UI font family
- Slide transitions between steps (Framer Motion)

### Setup-specific CSS (`setup.css`)
- 440 lines
- Step transition animations
- Provider card styles (large cards with icons)
- Badge styles (ok=green, warn=yellow)
- Button styles (primary=gradient, small=compact)
- API key list styles
- Progress indicator styles

---

## File Structure

```
frontend/
├── setup.html                      # HTML entry point
└── src/setup/
    ├── main.tsx                    # React entry (renders SetupApp)
    ├── SetupApp.tsx                # Main wizard component (348 lines)
    └── setup.css                   # White theme styles (440 lines)
```

---

## How to Access

### First Launch
The setup wizard appears automatically on first launch if `nexus-config.json` doesn't exist in the app data directory. The Rust backend checks for this file at startup:

```rust
let config_path = dir.join("nexus-config.json");
if !config_path.exists() {
    // Show setup wizard
    let win = app.get_webview_window("setup")?;
    win.show()?;
    win.set_focus()?;
}
```

### Via Tray Menu
Right-click the NEXUS tray icon → "Settings…" → if not configured, opens setup wizard; if configured, opens settings window.

### Via Settings Window
The settings window has a "Re-run Setup" button in the Backend tab that opens the setup wizard.

---

## Rust IPC Commands

The setup wizard uses these IPC commands:

| Command | Description |
|---------|-------------|
| `open_setup_window` | Show and focus the setup window |
| `close_setup_window` | Hide the setup window |
| `save_server_config` | Save server URL, user ID, device ID to `nexus-config.json` |
| `get_server_config` | Read saved server config (or defaults) |
| `get_oauth_config` | Check if OAuth is configured for a provider |
| `get_oauth_status` | Check if a provider is currently connected |
| `disconnect_oauth` | Disconnect a provider's OAuth |
| `enroll_voice` | Record a voice enrollment clip |
| `get_voice_profile_status` | Check voice enrollment status |
| `delete_voice_profile` | Delete voice profile |

---

## Configuration Saved

When the user completes the setup wizard, the following is saved to `nexus-config.json`:

```json
{
  "serverUrl": "ws://127.0.0.1:49152/ws",
  "userId": "user-123",
  "deviceId": "device-456"
}
```

This file's existence marks setup as complete — the wizard won't appear again on next launch.
