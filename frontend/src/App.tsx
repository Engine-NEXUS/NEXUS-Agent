import { useEffect, useRef } from "react";
import { Avatar } from "./avatar/Avatar";
import { StatusBar } from "./components/StatusBar";
import { TranscriptPanel } from "./components/TranscriptPanel";
import { useAssistant } from "./store/assistant";

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

  // Native window visibility with deferred hide for slide-down animation.
  //
  // Show: call show_overlay immediately so the native window is visible
  //   before the CSS slide-up transition plays.
  //
  // Hide: DON'T call hide_overlay immediately. Instead, let the CSS class
  //   change to app--hidden trigger the slide-down transition (0.5s).
  //   Only after the transition completes do we call hide_overlay to
  //   natively hide the window. This prevents the orb from vanishing
  //   "in the air" — it slides back down the way it came.
  //
  // Edge case — rapid re-wake during slide-down: the pending hide timer
  //   is cleared, the window stays shown, and the orb reverses direction.
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (visible) {
      // Cancel any pending native hide (e.g. rapid re-wake mid-slide-down).
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      tauriInvoke("show_overlay").catch(() => {});
    } else {
      // Defer native hide until the CSS slide-down transition finishes.
      // CSS transition is 0.5s; add 100ms buffer for safety.
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

  return (
    <div id="app" className={visible ? "app--visible" : "app--hidden"}>
      <div className="nx-card" data-interactive>
        {/* Orb with state-reactive glow halo */}
        <div className="avatar-section" data-interactive>
          <div className={`nx-orb-halo nx-orb-halo--${state}`} />
          <Avatar />
        </div>

        {/* Status text: LISTENING / THINKING / SPEAKING / etc. */}
        <StatusBar />

        {/* Conversation transcript (last few messages) */}
        <TranscriptPanel />
      </div>
    </div>
  );
}
