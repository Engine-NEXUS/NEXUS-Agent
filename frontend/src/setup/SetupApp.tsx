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
 * NEXUS Setup — 3-step onboarding wizard (white theme).
 *
 * Step 0: Welcome
 * Step 1: Voice Enrollment (optional, can skip)
 * Step 2: Connect Accounts (Google, GitHub, API keys)
 *
 * The server URL, user ID, and device ID are auto-generated on first
 * launch (see lib.rs) — the user never has to enter them manually.
 * The server URL is baked into the installer at build time.
 */

type Step = 0 | 1 | 2;
const STEP_LABELS = ["Welcome", "Voice", "Accounts"];

export function SetupApp() {
  const [step, setStep] = useState<Step>(0);
  const [serverUrl, setServerUrl] = useState("");
  const [userId, setUserId] = useState("");
  const [oauthStatus, setOauthStatus] = useState<Record<string, OAuthStatus>>({});
  const [apiKeys, setApiKeys] = useState<string[]>([]);
  const [configCheck, setConfigCheck] = useState<Record<string, { configured: boolean; scopes: string }>>({});
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [newApiKeyProvider, setNewApiKeyProvider] = useState("");
  const [newApiKeyValue, setNewApiKeyValue] = useState("");
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);

  // Load the auto-generated config from Rust (server URL + user ID + device ID)
  useEffect(() => {
    invoke<{ serverUrl: string; userId: string; deviceId: string }>("get_server_config")
      .then((cfg) => {
        setServerUrl(cfg.serverUrl);
        setUserId(cfg.userId);
      })
      .catch(() => {});
  }, []);

  // Check server connection (auto, using the baked-in config)
  const checkServer = useCallback(async () => {
    if (!serverUrl || !userId) return;
    setSidecarBaseUrl(serverUrl);
    try {
      const [status, keys, config] = await Promise.all([
        getOAuthStatus(userId),
        listApiKeys(userId),
        fetch(`${serverUrl.replace(/\/+$/, "").replace(/^ws/, "http")}/config/check`).then((r) => r.json()),
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
    if (step === 2) checkServer();
  }, [step, checkServer]);

  const handleConnect = async (provider: "google" | "github") => {
    if (!serverUrl) {
      setError("Server not configured");
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
    try {
      await invoke("close_setup_window");
      setSaved(true);
    } catch (err) {
      setError(`Failed to finish: ${err instanceof Error ? err.message : String(err)}`);
    }
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

          {/* ── Step 1: Voice ── */}
          {step === 1 && (
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

          {/* ── Step 2: Accounts ── */}
          {step === 2 && (
            <>
              <StepHeader step={step} />
              <section className="setup-section">
                <h2>Connect Your Accounts</h2>
                <p style={{ marginBottom: "var(--nx-space-4)", color: "var(--nx-text-secondary)", fontSize: "var(--nx-text-sm)" }}>
                  Connect Google and GitHub so NEXUS can manage your email, calendar, repos, and PRs.
                  You can connect both, one, or skip and do it later.
                </p>

                {/* Server status indicator (auto-configured, not user-entered) */}
                {serverReachable !== null && (
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--nx-space-2)", fontSize: "var(--nx-text-sm)", marginBottom: "var(--nx-space-4)" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: serverReachable ? "var(--nx-success)" : "var(--nx-error)" }} />
                    {serverReachable ? "Connected to server" : "Can't reach server — check back later"}
                  </div>
                )}

                {/* Google card */}
                <div className="setup-provider setup-provider--large">
                  <div className="setup-provider-icon setup-provider-icon--google">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" fill="#EA4335"/>
                    </svg>
                  </div>
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
                    <span className="setup-badge setup-badge--warn">Not configured</span>
                  ) : (
                    <button className="setup-btn setup-btn--primary setup-btn--small" disabled={connecting !== null} onClick={() => handleConnect("google")}>
                      {connecting === "google" ? "Connecting..." : "Connect"}
                    </button>
                  )}
                </div>

                {/* GitHub card */}
                <div className="setup-provider setup-provider--large">
                  <div className="setup-provider-icon setup-provider-icon--github">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                    </svg>
                  </div>
                  <div className="setup-provider-info">
                    <h3>GitHub</h3>
                    <p>Repos · Pull Requests · Issues</p>
                  </div>
                  {oauthStatus.github?.connected ? (
                    <div className="setup-connected">
                      <span className="setup-badge setup-badge--ok">Connected</span>
                      <button className="setup-btn setup-btn--small" onClick={() => handleDisconnect("github")}>
                        Disconnect
                      </button>
                    </div>
                  ) : configCheck.github && !configCheck.github.configured ? (
                    <span className="setup-badge setup-badge--warn">Not configured</span>
                  ) : (
                    <button className="setup-btn setup-btn--primary setup-btn--small" disabled={connecting !== null} onClick={() => handleConnect("github")}>
                      {connecting === "github" ? "Connecting..." : "Connect"}
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
            {step < 2 ? (
              <button
                className="setup-btn setup-btn--primary"
                onClick={() => setStep((step + 1) as Step)}
              >
                Continue →
              </button>
            ) : (
              <button className="setup-btn setup-btn--primary" onClick={handleFinish}>
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
          <div key={label} style={{ display: "flex", alignItems: "center", gap: "var(--nx-space-2)", flex: i < 2 ? 1 : undefined }}>
            <div className={`setup-step-dot ${i === step ? "setup-step-dot--active" : ""} ${i < step ? "setup-step-dot--completed" : ""}`} />
            {i < 2 && <div className={`setup-step-bar ${i < step ? "setup-step-bar--completed" : ""}`} />}
          </div>
        ))}
      </div>
      <div className="setup-step-label">Step {step + 1} of 3</div>
      <div className="setup-step-title">{STEP_LABELS[step]}</div>
    </div>
  );
}
