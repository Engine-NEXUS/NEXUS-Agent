import { useEffect, useRef } from "react";
import { Avatar } from "./avatar/Avatar";
import { useAssistant } from "./store/assistant";
import { initOrchestratorListener } from "./net/orchestrator";

function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
}

async function tauriInvoke(cmd: string, args?: Record<string, unknown>): Promise<any> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

export default function App() {
  const state = useAssistant((s) => s.state);
  const visible = useAssistant((s) => s.visible);
  const loadingVisible = useAssistant((s) => s.loadingVisible);

  // Initialize the central orchestrator event listener (once).
  // This listens to "orchestrator:event" from Rust and handles:
  //   - state transitions (thinking → speaking)
  //   - loading indicator visibility
  //   - ack TTS ("On it sir")
  //   - result TTS + sidebar display
  //   - error handling
  useEffect(() => {
    void initOrchestratorListener();
  }, []);

  // 8-second auto-hide: if user doesn't respond while listening, slide back down.
  // Also cleans up VAD + recording + mic stream to avoid orphaned AudioContexts.
  // Delay reset() until after the slide-down completes so the Lottie doesn't
  // switch segments mid-slide (which would cause a visual glitch).
  useEffect(() => {
    if (!visible || state !== "listening") return;
    const t = setTimeout(() => {
      // Stop VAD + recording + mic stream before hiding.
      import("./audio/vad").then(({ stopVad }) => stopVad()).catch(() => {});
      import("./audio/recorder").then(({ abortCapture }) => {
        void abortCapture().catch(() => {});
      }).catch(() => {});
      useAssistant.getState().setVisible(false);
      // Delay state reset until the 0.5s slide-down finishes.
      setTimeout(() => useAssistant.getState().reset(), 550);
    }, 8000);
    return () => clearTimeout(t);
  }, [visible, state]);

  // Native orb window visibility — only depends on `visible` (the orb).
  // The loading animation is now in a SEPARATE Tauri window, so hiding the
  // orb window does NOT affect the loading window.
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      tauriInvoke("show_overlay").catch(() => {});
    } else {
      hideTimerRef.current = setTimeout(() => {
        tauriInvoke("hide_overlay").catch(() => {});
        hideTimerRef.current = null;
      }, 600);
    }
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [visible]);

  // When state is active (not idle), ensure click-through is OFF.
  useEffect(() => {
    if (state === "idle") return;
    tauriInvoke("set_click_through", { ignore: false }).catch(() => {});
  }, [state]);

  // Loading window management — show/hide a separate Tauri window at the
  // top-right corner of the screen. This window contains the Lottie loading
  // animation and is completely independent from the orb window.
  useEffect(() => {
    if (loadingVisible) {
      console.log("[NEXUS] loading: showing loading window at top-right corner");
      tauriInvoke("show_loading_indicator").catch((e) =>
        console.warn("[NEXUS] loading: show_loading_indicator failed:", e)
      );
    } else {
      console.log("[NEXUS] loading: hiding loading window");
      tauriInvoke("hide_loading_indicator").catch((e) =>
        console.warn("[NEXUS] loading: hide_loading_indicator failed:", e)
      );
    }
  }, [loadingVisible]);

  // Cleanup: destroy the loading window when the App unmounts
  useEffect(() => {
    return () => {
      tauriInvoke("hide_loading_indicator").catch(() => {});
    };
  }, []);

  return (
    <div id="app" className={visible ? "app--visible" : "app--hidden"}>
      <div className="avatar-section" data-interactive>
        <Avatar />
      </div>
    </div>
  );
}
