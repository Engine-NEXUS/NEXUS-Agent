# 20 — Setup Wizard Redesign

> **Commit:** `6663e57` — `feat: white-themed NSIS installer + setup wizard (orb untouched)`
> **Date:** 2026-08-20 (initial), `03a34ad` (multi-option accounts update)
> **PR:** #16 (merged as `ed1c4b8`)
> **Status:** Complete

---

## What Changed

The first-launch setup wizard was completely redesigned from a single-page dark form into a 4-step white-themed onboarding wizard with multi-option account connecting.

---

## Wizard Steps

### Step 1: Welcome
- NEXUS logo and tagline
- "Get Started" button
- Brief description of what NEXUS does

### Step 2: Server Configuration
- Server URL input (default: `ws://127.0.0.1:49152/ws`)
- User ID input
- Device ID input
- "Test Connection" button
- Connection status indicator

### Step 3: Voice Enrollment
- Record 5 clips of your voice saying "NEXUS"
- Speaker verification for wake word
- Optional — can skip and enroll later
- Progress indicator (clip 1/5, 2/5, etc.)

### Step 4: Accounts
- Multi-option account cards with brand icons
- **Google** card: Gmail, Calendar, Drive, Meet
  - Google logo SVG icon
  - Connect/Disconnect button
  - Connected status badge
  - "Not configured" warning if server lacks OAuth config
- **GitHub** card: Repos, Pull Requests, Issues
  - GitHub logo SVG icon (dark background)
  - Connect/Disconnect button
  - Connected status badge
  - "Not configured" warning if server lacks OAuth config
- API Keys section for Claude, Devin, etc.

---

## File Structure

```
frontend/
├── setup.html                    # HTML entry point
└── src/setup/
    ├── SetupApp.tsx              # Main wizard component (4 steps)
    ├── setup.css                 # White theme styles (440 lines)
    └── (uses ../theme/tokens.css) # Shared design tokens
```

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

## Multi-Option Account Cards (Updated in `03a34ad`)

### Google Card
```tsx
<div className="setup-provider setup-provider--large">
  <div className="setup-provider-icon setup-provider-icon--google">
    <svg>/* Google logo */</svg>
  </div>
  <div className="setup-provider-info">
    <h3>Google</h3>
    <p>Gmail · Calendar · Drive · Meet</p>
  </div>
  {connected ? (
    <div className="setup-connected">
      <span className="setup-badge setup-badge--ok">Connected</span>
      <button onClick={disconnect}>Disconnect</button>
    </div>
  ) : (
    <button onClick={connect}>Connect</button>
  )}
</div>
```

### GitHub Card
```tsx
<div className="setup-provider setup-provider--large">
  <div className="setup-provider-icon setup-provider-icon--github">
    <svg>/* GitHub logo */</svg>
  </div>
  <div className="setup-provider-info">
    <h3>GitHub</h3>
    <p>Repos · Pull Requests · Issues</p>
  </div>
  {connected ? (
    <div className="setup-connected">
      <span className="setup-badge setup-badge--ok">Connected</span>
      <button onClick={disconnect}>Disconnect</button>
    </div>
  ) : (
    <button onClick={connect}>Connect</button>
  )}
</div>
```

### Provider Card CSS
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

When the user clicks "Connect" for Google or GitHub:

1. Frontend calls `invoke("get_oauth_config", { provider: "google" })`
2. If OAuth is configured on the server, the frontend opens the OAuth URL
3. The browser redirects to `nexus://oauth/callback?code=...&state=...`
4. The Tauri deep-link plugin captures the redirect
5. The frontend sends the auth code to the server
6. The server exchanges the code for access/refresh tokens
7. The frontend polls `invoke("get_oauth_status", { provider: "google" })`
8. When connected, the card shows "Connected" badge

If OAuth is not configured on the server, the card shows "Not configured" warning badge.

---

## API Keys Section

The setup wizard also includes an API keys section for services that use API keys instead of OAuth:
- Claude API key
- Devin API key
- Antigravity API key
- Custom API keys

Users can add, view, and delete API keys. Keys are stored encrypted on the server.

---

## Test Results

| Test | Result |
|------|--------|
| TypeScript compilation | Pass (0 errors) |
| Setup window opens | Pass |
| 4 steps navigate correctly | Pass |
| Google card shows | Pass |
| GitHub card shows | Pass |
| OAuth connect flow | Pass (when server configured) |
| API keys add/remove | Pass |

---

## How to Access

- **First launch:** Setup wizard appears automatically if `nexus-config.json` doesn't exist
- **Via tray:** Right-click tray icon → "Settings…" → opens setup if not configured, settings if configured
- **Via settings:** Settings window has a "Re-run Setup" button in the Backend tab
