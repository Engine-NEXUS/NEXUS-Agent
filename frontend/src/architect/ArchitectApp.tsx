import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useArchitect, type Phase1Data, type Phase2Data } from "./architectStore";
import { ArchitectureMap } from "./ArchitectureMap";
import { ArchitectSidebar } from "./ArchitectSidebar";

export function ArchitectApp() {
  const phase = useArchitect((s) => s.phase);
  const loading = useArchitect((s) => s.loading);
  const deepScanning = useArchitect((s) => s.deepScanning);
  const progressMessage = useArchitect((s) => s.progressMessage);
  const phase1Data = useArchitect((s) => s.phase1Data);
  const phase2Data = useArchitect((s) => s.phase2Data);
  const viewMode = useArchitect((s) => s.viewMode);

  const setRepo = useArchitect((s) => s.setRepo);
  const setLoading = useArchitect((s) => s.setLoading);
  const setDeepScanning = useArchitect((s) => s.setDeepScanning);
  const setProgress = useArchitect((s) => s.setProgress);
  const setPhase1Data = useArchitect((s) => s.setPhase1Data);
  const enrichPhase1 = useArchitect((s) => s.enrichPhase1);
  const setPhase2Data = useArchitect((s) => s.setPhase2Data);
  const setViewMode = useArchitect((s) => s.setViewMode);

  const [inputRepo, setInputRepo] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Fetch GitHub OAuth token from the Worker (for private repo access)
  const fetchGithubToken = useCallback(async (): Promise<string | null> => {
    try {
      const { getServerConfig } = await import("../net/wsBridge");
      const config = await getServerConfig();
      const resp = await fetch(`${config.url}/oauth/github-token?user_id=${encodeURIComponent(config.userId)}`);
      if (resp.ok) {
        const data = await resp.json();
        return data.token || null;
      }
    } catch (err) {
      console.warn("Failed to fetch GitHub token:", err);
    }
    return null;
  }, []);

  // Trigger Phase 2 deep dependency scan in background
  const triggerDeepScan = useCallback(
    async (o: string, r: string, token: string | null) => {
      setDeepScanning(true);
      try {
        const result = await invoke<Phase2Data>("analyze_repo_deep", {
          owner: o,
          repo: r,
          githubToken: token,
        });
        setPhase2Data(result);
      } catch (err: any) {
        console.warn("Phase 2 deep scan warning:", err);
        setDeepScanning(false);
      }
    },
    [setDeepScanning, setPhase2Data]
  );

  // Trigger Phase 1 fast analysis
  const triggerAnalysis = useCallback(
    async (o: string, r: string) => {
      if (!o || !r) return;
      setLoading(true);
      setErrorMsg(null);
      setProgress("init", `Starting Phase 1 analysis for ${o}/${r}...`);

      // Fetch GitHub token for private repo access
      const token = await fetchGithubToken();

      try {
        const result = await invoke<Phase1Data>("analyze_repo_phase1", {
          owner: o,
          repo: r,
          githubToken: token,
        });
        setPhase1Data(result);

        // Fire-and-forget LLM enrichment — never blocks the diagram.
        // The Worker rewrites generic layer labels into repo-specific ones
        // (e.g. "Client / Presentation Layer" → "Next.js App Router (React 19)")
        // and streams them back via the architect:phase1-enriched event.
        void invoke("enrich_phase1", {
          phase1: result,
          filePaths: result.sample_file_paths ?? [],
        }).catch((e) => console.warn("Phase 1 enrichment failed (non-fatal):", e));

        // Auto start background Phase 2 deep scan
        void triggerDeepScan(o, r, token);
      } catch (err: any) {
        console.error("Phase 1 analysis failed:", err);
        setErrorMsg(typeof err === "string" ? err : err.message || "Failed to analyze repo");
        setLoading(false);
      }
    },
    [setLoading, setProgress, setPhase1Data, enrichPhase1, triggerDeepScan, fetchGithubToken]
  );

  // Detect active repo from foreground window
  const handleDetectActiveWindow = async () => {
    try {
      const active = await invoke<{ owner: string; repo: string } | null>("get_active_repo_url");
      if (active && active.owner && active.repo) {
        setRepo(active.owner, active.repo);
        setInputRepo(`${active.owner}/${active.repo}`);
        void triggerAnalysis(active.owner, active.repo);
      } else {
        setErrorMsg("No active GitHub repository window detected in foreground.");
      }
    } catch (err) {
      console.warn("Failed to detect active repo:", err);
    }
  };

  // Submit manual input
  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = inputRepo.trim();
    if (!raw) return;

    let o = "";
    let r = "";

    if (raw.includes("github.com/")) {
      const parts = raw.split("github.com/")[1].split("/");
      o = parts[0];
      r = parts[1]?.replace(".git", "");
    } else if (raw.includes("/")) {
      const parts = raw.split("/");
      o = parts[0];
      r = parts[1];
    }

    if (o && r) {
      setRepo(o, r);
      void triggerAnalysis(o, r);
    } else {
      setErrorMsg("Please enter in format: owner/repo or full GitHub URL");
    }
  };

  // Listen to Tauri events + fetch pending repo on mount.
  //
  // When the architect window is created on-demand, the React app needs time
  // to load before it can receive Tauri events. So Rust stores the repo in a
  // pending static, and we fetch it here on mount via `get_pending_architect_repo`.
  // This is race-free. We also keep the event listener as a fast path for when
  // the window already exists (React already loaded).
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    // Fetch pending repo on mount — handles the fresh-window case.
    // Also fetches the screenshot backdrop for the liquid-glass effect.
    // NOTE: `pending` is now ALWAYS returned (non-null) once the window has
    // been opened via open_architect_window, even when no active GitHub
    // repo was auto-detected — this ensures the backdrop always reaches the
    // frontend. `owner`/`repo` may independently be null in that case, so
    // they're checked separately from the backdrop.
    invoke<{ owner: string | null; repo: string | null; backdrop?: string | null } | null>("get_pending_architect_repo")
      .then((pending) => {
        if (!pending) return;
        // Set the backdrop image for the liquid-glass card
        if (pending.backdrop) {
          document.documentElement.style.setProperty(
            "--sidebar-backdrop-image",
            `url(${pending.backdrop})`
          );
        }
        // Only auto-start analysis if an active repo was actually detected
        if (pending.owner && pending.repo) {
          setRepo(pending.owner, pending.repo);
          setInputRepo(`${pending.owner}/${pending.repo}`);
          void triggerAnalysis(pending.owner, pending.repo);
        }
      })
      .catch((e) => console.warn("[architect] get_pending_architect_repo failed:", e));

    // Listen for backdrop updates (live blur loop + window reuse)
    listen<string>("sidebar:backdrop", (event) => {
      document.documentElement.style.setProperty(
        "--sidebar-backdrop-image",
        `url(${event.payload})`
      );
    }).then((u) => unlisteners.push(u));

    listen<{ owner: string; repo: string }>("architect:set-repo", (event) => {
      setRepo(event.payload.owner, event.payload.repo);
      setInputRepo(`${event.payload.owner}/${event.payload.repo}`);
      void triggerAnalysis(event.payload.owner, event.payload.repo);
    }).then((u) => unlisteners.push(u));

    listen<{ stage: string; message: string }>("architect:progress", (event) => {
      setProgress(event.payload.stage, event.payload.message);
    }).then((u) => unlisteners.push(u));

    listen<Phase1Data>("architect:phase1-ready", (event) => {
      setPhase1Data(event.payload);
    }).then((u) => unlisteners.push(u));

    // LLM enrichment streams in ~2-3s after first paint — merges
    // repo-specific layer labels + summary into the existing diagram.
    listen<{ summary: string; layers: { id: string; label: string; tech_stack: string }[] }>(
      "architect:phase1-enriched",
      (event) => {
        enrichPhase1(event.payload);
      }
    ).then((u) => unlisteners.push(u));

    listen<Phase2Data>("architect:graph-ready", (event) => {
      setPhase2Data(event.payload);
    }).then((u) => unlisteners.push(u));

    return () => {
      unlisteners.forEach((u) => u());
    };
  }, [setRepo, setProgress, setPhase1Data, enrichPhase1, setPhase2Data, triggerAnalysis]);

  return (
    <div className="architect-app">
      {/* ── Top Navigation Bar ─────────────────────────────────────── */}
      <header className="architect-header">
        <div className="architect-header-brand">
          <span className="architect-brand-icon">🗺️</span>
          <span className="architect-brand-title">NEXUS ARCHITECT</span>
          <span className="architect-phase-badge">
            {phase === 0 && "IDLE"}
            {phase === 1 && (deepScanning ? "PHASE 1 (DEEP SCANNING…)" : "PHASE 1: VISUAL MAP")}
            {phase >= 2 && "PHASE 2: DEEP GRAPH READY"}
          </span>
        </div>

        {/* View mode switcher */}
        {phase1Data && (
          <div className="architect-view-tabs">
            <button
              type="button"
              className={`architect-tab-btn ${viewMode === "layers" ? "architect-tab-btn--active" : ""}`}
              onClick={() => setViewMode("layers")}
            >
              Layers
            </button>
            <button
              type="button"
              className={`architect-tab-btn ${viewMode === "files" ? "architect-tab-btn--active" : ""}`}
              onClick={() => setViewMode("files")}
              disabled={!phase2Data}
              title={!phase2Data ? "Waiting for deep scan..." : "View full dependency graph"}
            >
              Dependencies {phase2Data ? `(${phase2Data.files_analyzed})` : ""}
            </button>
            <button
              type="button"
              className={`architect-tab-btn ${viewMode === "hotspots" ? "architect-tab-btn--active" : ""}`}
              onClick={() => setViewMode("hotspots")}
              disabled={!phase2Data || phase2Data.hotspots.length === 0}
            >
              🔥 Hotspots {phase2Data ? `(${phase2Data.hotspots.length})` : ""}
            </button>
            <button
              type="button"
              className={`architect-tab-btn ${viewMode === "cycles" ? "architect-tab-btn--active" : ""}`}
              onClick={() => setViewMode("cycles")}
              disabled={!phase2Data || phase2Data.circular_deps.length === 0}
            >
              🔄 Cycles {phase2Data ? `(${phase2Data.circular_deps.length})` : ""}
            </button>
          </div>
        )}

        {/* Repo search / input bar */}
        <form className="architect-repo-form" onSubmit={handleManualSubmit}>
          <div className="architect-input-wrapper">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              className="architect-repo-input"
              placeholder="owner/repo or https://github.com/..."
              value={inputRepo}
              onChange={(e) => setInputRepo(e.target.value)}
            />
          </div>
          <button type="submit" className="architect-analyze-btn" disabled={loading || deepScanning}>
            {loading ? "Analyzing..." : deepScanning ? "Deep Scanning..." : "Analyze Repo"}
          </button>
        </form>

        {/* Actions */}
        <div className="architect-header-actions">
          {phase1Data && !phase2Data && !deepScanning && (
            <button
              type="button"
              className="architect-analyze-btn"
              onClick={() => triggerDeepScan(phase1Data.owner, phase1Data.repo, null)}
            >
              ⚡ Run Deep Scan
            </button>
          )}
          <button
            type="button"
            className="architect-detect-btn"
            onClick={handleDetectActiveWindow}
            title="Scan active browser window"
          >
            🪟 Detect Window
          </button>
        </div>
      </header>

      {/* ── Progress & Status Banner ───────────────────────────────── */}
      {(loading || deepScanning) && (
        <div className="architect-progress-bar-container">
          <div className="architect-progress-indicator" />
          <span className="architect-progress-text">
            {progressMessage || (deepScanning ? "Running deep AST import scan in background..." : "Processing...")}
          </span>
        </div>
      )}

      {errorMsg && (
        <div className="architect-error-banner">
          ⚠️ {errorMsg}
          <button type="button" className="architect-error-close" onClick={() => setErrorMsg(null)}>
            ✕
          </button>
        </div>
      )}

      {/* ── Main Layout Canvas + Sidebar ──────────────────────────── */}
      <main className="architect-main">
        {phase1Data ? (
          <>
            <ArchitectureMap />
            <ArchitectSidebar />
          </>
        ) : (
          <div className="architect-hero-empty">
            <div className="architect-hero-card">
              <div className="architect-hero-badge">PHASE 1 & 2 ARCHITECTURE ENGINE</div>
              <h1 className="architect-hero-title">Turn unfamiliar code into an explorable map</h1>
              <p className="architect-hero-subtitle">
                Detects GitHub repositories from your active window, clusters directories into architectural
                layers, and computes real import dependency graphs with cycle & hotspot detection.
              </p>
              <div className="architect-hero-actions">
                <button
                  type="button"
                  className="architect-hero-btn"
                  onClick={() => {
                    setInputRepo("vercel/next.js");
                    void triggerAnalysis("vercel", "next.js");
                  }}
                >
                  Try Sample: <code>vercel/next.js</code>
                </button>
                <button
                  type="button"
                  className="architect-hero-btn architect-hero-btn--secondary"
                  onClick={handleDetectActiveWindow}
                >
                  🔍 Detect Current Browser Tab
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
