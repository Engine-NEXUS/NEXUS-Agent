import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  setSidecarBaseUrl,
  connectOAuth,
  addApiKey,
  removeApiKey,
  listApiKeys,
  getOAuthStatus,
  disconnectOAuth,
  type OAuthStatus,
} from "./oauth";
import { VoiceEnrollment } from "./VoiceEnrollment";

/**
 * NEXUS Setup page.
 *
 * Shown on first launch (no config saved) or via tray → Settings.
 * Lets the user:
 *   - Enter their server URL
 *   - Connect Google (Gmail, Calendar, Drive, Meet) via OAuth
 *   - Connect GitHub (full repo read/write) via OAuth
 *   - Add API keys for Claude, Devin, Antigravity, etc.
 *   - Save config and close
 */
export function SetupApp() {
  const [serverUrl, setServerUrl] = useState("");
  const [userId, setUserId] = useState("local-user");
  const [deviceId, setDeviceId] = useState("local-device");
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
  const [apiKeys, setApiKeys] = useState<string[]>([]);
  const [configCheck, setConfigCheck] = useState<Record<string, { configured: boolean; scopes: string }>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [newApiKeyProvider, setNewApiKeyProvider] = useState("");
  const [newApiKeyValue, setNewApiKeyValue] = useState("");

  // Refresh status when server URL or user changes.
  const refreshStatus = useCallback(async () => {
    if (!serverUrl) return;
    setSidecarBaseUrl(serverUrl);
    try {
      const [status, keys, config] = await Promise.all([
        getOAuthStatus(userId),
        listApiKeys(userId),
        fetch(`${serverUrl.replace(/\/+$/, "")}/config/check`).then((r) => r.json()),
      ]);
      setOauthStatus(status);
      setApiKeys(keys);
      setConfigCheck(config);
      setError(null);
    } catch (err) {
      setError(`Can't reach server: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [serverUrl, userId]);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Handle OAuth connect.
  const handleConnect = async (provider: "google" | "github") => {
    if (!serverUrl) {
      setError("Enter your server URL first");
      return;
    }
    setConnecting(provider);
    setError(null);
    try {
      setSidecarBaseUrl(serverUrl);
      await connectOAuth(provider, userId);
      await refreshStatus();
    } catch (err) {
      setError(`${provider} connection failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnecting(null);
    }
  };

  // Handle OAuth disconnect.
  const handleDisconnect = async (provider: string) => {
    try {
      await disconnectOAuth(userId, provider);
      await refreshStatus();
    } catch (err) {
      setError(`Disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Handle API key save.
  const handleAddApiKey = async () => {
    if (!newApiKeyProvider.trim() || !newApiKeyValue.trim()) return;
    try {
      await addApiKey(userId, newApiKeyProvider.trim().toLowerCase(), newApiKeyValue.trim());
      setNewApiKeyProvider("");
      setNewApiKeyValue("");
      await refreshStatus();
    } catch (err) {
      setError(`Failed to save API key: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Handle API key removal.
  const handleRemoveApiKey = async (provider: string) => {
    try {
      await removeApiKey(userId, provider);
      await refreshStatus();
    } catch (err) {
      setError(`Failed to remove API key: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Save config and close.
  const handleSave = async () => {
    if (!serverUrl.trim()) {
      setError("Server URL is required");
      return;
    }
    try {
      await invoke("save_server_config", {
        serverUrl: serverUrl.trim(),
        userId: userId.trim(),
        deviceId: deviceId.trim(),
      });
      await invoke("close_setup_window");
      setSaved(true);
    } catch (err) {
      setError(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="setup-root">
      <div className="setup-header">
        <h1>NEXUS Setup</h1>
        <p>Connect your accounts to give NEXUS access to your tools.</p>
      </div>

      {error && <div className="setup-error">{error}</div>}

      {/* Server configuration */}
      <section className="setup-section">
        <h2>Server</h2>
        <label className="setup-label">
          Server URL
          <input
            type="url"
            placeholder="https://your-server.com:8443"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            onBlur={refreshStatus}
          />
        </label>
        <div className="setup-row">
          <label className="setup-label setup-label--small">
            User ID
            <input type="text" value={userId} onChange={(e) => setUserId(e.target.value)} />
          </label>
          <label className="setup-label setup-label--small">
            Device ID
            <input type="text" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} />
          </label>
        </div>
      </section>

      {/* Google */}
      <section className="setup-section">
        <div className="setup-provider">
          <div className="setup-provider-info">
            <h3>Google</h3>
            <p>Gmail · Calendar · Drive · Meet</p>
          </div>
          {oauthStatus.google?.connected ? (
            <div className="setup-connected">
              <span className="setup-badge setup-badge--ok">
                Connected{oauthStatus.google.expired ? " (expired)" : ""}
              </span>
              <button className="setup-btn setup-btn--small" onClick={() => handleDisconnect("google")}>
                Disconnect
              </button>
            </div>
          ) : configCheck.google && !configCheck.google.configured ? (
            <span className="setup-badge setup-badge--warn">Not configured on server</span>
          ) : (
            <button
              className="setup-btn"
              disabled={connecting !== null}
              onClick={() => handleConnect("google")}
            >
              {connecting === "google" ? "Connecting..." : "Connect Google"}
            </button>
          )}
        </div>
      </section>

      {/* GitHub */}
      <section className="setup-section">
        <div className="setup-provider">
          <div className="setup-provider-info">
            <h3>GitHub</h3>
            <p>Full repository read/write access</p>
          </div>
          {oauthStatus.github?.connected ? (
            <div className="setup-connected">
              <span className="setup-badge setup-badge--ok">Connected</span>
              <button className="setup-btn setup-btn--small" onClick={() => handleDisconnect("github")}>
                Disconnect
              </button>
            </div>
          ) : configCheck.github && !configCheck.github.configured ? (
            <span className="setup-badge setup-badge--warn">Not configured on server</span>
          ) : (
            <button
              className="setup-btn"
              disabled={connecting !== null}
              onClick={() => handleConnect("github")}
            >
              {connecting === "github" ? "Connecting..." : "Connect GitHub"}
            </button>
          )}
        </div>
      </section>

      {/* API Keys */}
      <section className="setup-section">
        <h2>API Keys</h2>
        <p className="setup-hint">
          Add API keys for services like Claude, Devin, Antigravity, etc.
        </p>

        {apiKeys.length > 0 && (
          <div className="setup-apikey-list">
            {apiKeys.map((provider) => (
              <div key={provider} className="setup-apikey-item">
                <span className="setup-badge setup-badge--ok">{provider}</span>
                <button
                  className="setup-btn setup-btn--small setup-btn--danger"
                  onClick={() => handleRemoveApiKey(provider)}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="setup-apikey-add">
          <input
            type="text"
            placeholder="Provider (e.g. claude, devin)"
            value={newApiKeyProvider}
            onChange={(e) => setNewApiKeyProvider(e.target.value)}
          />
          <input
            type="password"
            placeholder="API key"
            value={newApiKeyValue}
            onChange={(e) => setNewApiKeyValue(e.target.value)}
          />
          <button className="setup-btn" onClick={handleAddApiKey} disabled={!newApiKeyProvider.trim() || !newApiKeyValue.trim()}>
            Save Key
          </button>
        </div>
      </section>

      {/* Voice Enrollment */}
      <VoiceEnrollment />

      {/* Save & Continue */}
      <div className="setup-footer">
        <button className="setup-btn setup-btn--primary" onClick={handleSave} disabled={!serverUrl.trim()}>
          Save & Continue
        </button>
        {saved && <span className="setup-saved">Saved!</span>}
      </div>
    </div>
  );
}
