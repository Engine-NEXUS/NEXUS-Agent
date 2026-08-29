import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion, AnimatePresence } from "framer-motion";
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
 * NEXUS Setup — 4-step onboarding wizard (white theme).
 *
 * Step 1: Welcome
 * Step 2: Server Connection
 * Step 3: Voice Enrollment (optional, can skip)
 * Step 4: Connect Accounts (Google, GitHub, API keys)
 */

type Step = 0 | 1 | 2 | 3;
const STEP_LABELS = ["Welcome", "Server", "Voice", "Accounts"];

export function SetupApp() {
  const [step, setStep] = useState<Step>(0);
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
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);

  // Check server connection
  const checkServer = useCallback(async () => {
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
      setServerReachable(true);
      setError(null);
    } catch {
      setServerReachable(false);
    }
  }, [serverUrl, userId]);

  useEffect(() => {
    if (step === 1 || step === 3) checkServer();
  }, [step, checkServer]);

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
      await checkServer();
    } catch (err) {
      setError(`${provider} connection failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnecting(null);
    }
  };

  const handleDisconnect = async (provider: string) => {
    try {
      await disconnectOAuth(userId, provider);
      await checkServer();
    } catch (err) {
      setError(`Disconnect failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleAddApiKey = async () => {
    if (!newApiKeyProvider.trim() || !newApiKeyValue.trim()) return;
    try {
      await addApiKey(userId, newApiKeyProvider.trim().toLowerCase(), newApiKeyValue.trim());
      setNewApiKeyProvider("");
      setNewApiKeyValue("");
      await checkServer();
    } catch (err) {
      setError(`Failed to save API key: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRemoveApiKey = async (provider: string) => {
    try {
      await removeApiKey(userId, provider);
      await checkServer();
    } catch (err) {
      setError(`Failed to remove API key: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleFinish = async () => {
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

  const canProceed = (s: Step): boolean => {
    if (s === 1) return !!serverUrl.trim();
    return true;
  };

  return (
    <div className="setup-root">
      {error && <div className="setup-error">{error}</div>}

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
          style={{ flex: 1 }}
        >
          {/* ── Step 0: Welcome ── */}
          {step === 0 && (
            <div className="setup-welcome">
              <div className="setup-welcome-orb" />
              <div>
                <h1>Welcome to NEXUS</h1>
                <p style={{ marginTop: "var(--nx-space-3)" }}>
                  Your private AI assistant. Voice-controlled, runs locally,
                  and connects to your server for powerful workflows.
                </p>
              </div>
              <button className="setup-btn setup-btn--primary" style={{ padding: "12px 32px", fontSize: "var(--nx-text-md)" }} onClick={() => setStep(1)}>
                Get Started →
              </button>
            </div>
          )}

          {/* ── Step 1: Server ── */}
          {step === 1 && (
            <>
              <StepHeader step={step} />
              <section className="setup-section">
                <h2>Server</h2>
                <label className="setup-label">
                  Server URL
                  <input
                    type="url"
                    placeholder="https://your-server.com:8443"
                    value={serverUrl}
                    onChange={(e) => setServerUrl(e.target.value)}
                    onBlur={checkServer}
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
                {serverReachable !== null && (
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--nx-space-2)", fontSize: "var(--nx-text-sm)" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: serverReachable ? "var(--nx-success)" : "var(--nx-error)" }} />
                    {serverReachable ? "Connected to server" : "Can't reach server"}
                  </div>
                )}
              </section>
            </>
          )}

          {/* ── Step 2: Voice ── */}
          {step === 2 && (
            <>
              <StepHeader step={step} />
              <section className="setup-section">
                <h2>Voice Enrollment</h2>
                <p style={{ marginBottom: "var(--nx-space-4)" }}>
                  Record 5 clips of your voice saying "NEXUS" to enable speaker verification.
                  This is optional — you can skip and enroll later.
                </p>
                <VoiceEnrollment />
              </section>
            </>
          )}

          {/* ── Step 3: Accounts ── */}
          {step === 3 && (
            <>
              <StepHeader step={step} />
              <section className="setup-section">
                <h2>Google</h2>
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
                    <button className="setup-btn" disabled={connecting !== null} onClick={() => handleConnect("google")}>
                      {connecting === "google" ? "Connecting..." : "Connect Google"}
                    </button>
                  )}
                </div>
              </section>

              <section className="setup-section">
                <h2>GitHub</h2>
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
                    <button className="setup-btn" disabled={connecting !== null} onClick={() => handleConnect("github")}>
                      {connecting === "github" ? "Connecting..." : "Connect GitHub"}
                    </button>
                  )}
                </div>
              </section>

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
                        <button className="setup-btn setup-btn--small setup-btn--danger" onClick={() => handleRemoveApiKey(provider)}>
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="setup-apikey-add">
                  <input type="text" placeholder="Provider (e.g. claude)" value={newApiKeyProvider} onChange={(e) => setNewApiKeyProvider(e.target.value)} />
                  <input type="password" placeholder="API key" value={newApiKeyValue} onChange={(e) => setNewApiKeyValue(e.target.value)} />
                  <button className="setup-btn" onClick={handleAddApiKey} disabled={!newApiKeyProvider.trim() || !newApiKeyValue.trim()}>
                    Save Key
                  </button>
                </div>
              </section>
            </>
          )}
        </motion.div>
      </AnimatePresence>

      {/* ── Footer navigation ── */}
      {step > 0 && (
        <div className="setup-footer">
          <button className="setup-btn" onClick={() => setStep((step - 1) as Step)}>
            ← Back
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--nx-space-3)" }}>
            {saved && <span className="setup-saved">Saved!</span>}
            {step < 3 ? (
              <button
                className="setup-btn setup-btn--primary"
                disabled={!canProceed(step)}
                onClick={() => setStep((step + 1) as Step)}
              >
                Continue →
              </button>
            ) : (
              <button className="setup-btn setup-btn--primary" onClick={handleFinish} disabled={!serverUrl.trim()}>
                Finish ✓
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step indicator ──────────────────────────────────────────────

function StepHeader({ step }: { step: Step }) {
  return (
    <div className="setup-step-header">
      <div className="setup-step-indicator">
        {STEP_LABELS.map((label, i) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: "var(--nx-space-2)", flex: i < 3 ? 1 : undefined }}>
            <div className={`setup-step-dot ${i === step ? "setup-step-dot--active" : ""} ${i < step ? "setup-step-dot--completed" : ""}`} />
            {i < 3 && <div className={`setup-step-bar ${i < step ? "setup-step-bar--completed" : ""}`} />}
          </div>
        ))}
      </div>
      <div className="setup-step-label">Step {step + 1} of 4</div>
      <div className="setup-step-title">{STEP_LABELS[step]}</div>
    </div>
  );
}
