/**
 * NEXUS Central Orchestrator — frontend event listener.
 *
 * This module listens to the "orchestrator:event" channel from Rust and
 * translates events into frontend state changes (Zustand store updates,
 * TTS playback, sidebar display, etc).
 *
 * This REPLACES the scattered "assistant:server" event handling in
 * wsBridge.ts and recorder.ts. The central orchestrator in Rust now owns:
 *   - When to show/hide the loading indicator
 *   - When to speak the ack
 *   - When to speak the result
 *   - When to show the sidebar with the response
 *   - Request lifecycle (cancel, done, error)
 *
 * The frontend just reacts to orchestrator events — it no longer makes
 * independent decisions about loading state or ack timing.
 */

import { useAssistant } from "../store/assistant";
import { speak, stopTts } from "../audio/ttsPlayer";

function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
}

/** Orchestrator event shape (mirrors Rust OrchestratorEvent enum). */
interface OrchestratorEvent {
  type: "state" | "loading" | "ack" | "result" | "done" | "error";
  request_id: string;
  // state
  state?: "idle" | "listening" | "thinking" | "speaking";
  // loading
  visible?: boolean;
  // ack
  text?: string;
  // result
  analysis?: unknown;
  dialog_state?: unknown;
  // error
  message?: string;
}

let initialized = false;
let currentRequestId: string | null = null;

/** Current request ID (for debugging / diagnostics). */
export function getCurrentRequestId(): string | null {
  return currentRequestId;
}

/**
 * Initialize the orchestrator event listener.
 * Call this once at app startup (from App.tsx or main.tsx).
 *
 * This listens to the "orchestrator:event" channel and dispatches to:
 *   - useAssistant store (state, visible, loadingVisible, transcript)
 *   - TTS player (speak ack, speak result, stop on cancel)
 *   - Sidebar display (show result)
 */
export async function initOrchestratorListener(): Promise<void> {
  if (initialized || !isTauri()) return;
  initialized = true;

  const { listen } = await import("@tauri-apps/api/event");

  console.log("[NEXUS] orchestrator: initializing event listener");

  await listen<OrchestratorEvent>("orchestrator:event", async (event) => {
    const ev = event.payload;
    const store = useAssistant.getState();

    console.log(`[NEXUS] orchestrator: ${ev.type} (req=${ev.request_id})`, ev);

    switch (ev.type) {
      case "state": {
        if (ev.state) {
          store.setState(ev.state as any);
        }
        break;
      }

      case "loading": {
        // The Rust side already shows/hides the loading window directly.
        // We just update the store for UI consistency (e.g. if the frontend
        // needs to know the loading state for rendering decisions).
        if (ev.visible !== undefined) {
          store.setLoadingVisible(ev.visible);
        }
        break;
      }

      case "ack": {
        // Speak the acknowledgement ("On it sir")
        if (ev.text) {
          store.setState("speaking");
          store.addAssistantMessage(ev.text);
          void speak(ev.text);
          // Hide the orb after a short delay (TTS is playing the ack).
          // The loading indicator is already shown by Rust.
          setTimeout(() => {
            useAssistant.getState().setVisible(false);
          }, 1500);
        }
        break;
      }

      case "result": {
        // Final result from the subsystem
        currentRequestId = ev.request_id;

        // Hide loading (Rust already does this, but update store too)
        store.setLoadingVisible(false);

        // Show the orb again for speaking the result
        store.setVisible(true);
        store.setState("speaking");

        // Add to transcript
        if (ev.text) {
          store.addAssistantMessage(ev.text);
        }

        // Speak the result
        if (ev.text) {
          void speak(ev.text);
        }

        // If there's analysis data, we could show it in the sidebar
        // (the existing sidebar logic handles this via the old channel)
        if (ev.analysis) {
          console.log("[NEXUS] orchestrator: result has analysis data", ev.analysis);
        }
        if (ev.dialog_state) {
          console.log("[NEXUS] orchestrator: result has dialog state", ev.dialog_state);
        }
        break;
      }

      case "done": {
        // Request is fully complete (TTS finished speaking)
        currentRequestId = null;
        store.setLoadingVisible(false);
        store.setVisible(true); // Show orb briefly before reset
        setTimeout(() => store.reset(), 550);
        break;
      }

      case "error": {
        console.error("[NEXUS] orchestrator: error:", ev.message);
        store.setLoadingVisible(false);
        store.setVisible(true);
        store.setState("speaking");
        const errMsg = ev.message || "Something went wrong sir.";
        store.addAssistantMessage(`Error: ${errMsg}`);
        void speak(errMsg);
        // After speaking the error, reset
        setTimeout(() => {
          currentRequestId = null;
          setTimeout(() => store.reset(), 550);
        }, 3000);
        break;
      }
    }
  });

  console.log("[NEXUS] orchestrator: event listener ready");
}

/**
 * Process a transcript through the central orchestrator.
 *
 * This is the frontend entry point — call this after STT produces a transcript.
 * It invokes the Rust `orchestrator_process` command which:
 *   1. Parses intent (deterministic, <1ms)
 *   2. Routes to the correct subsystem
 *   3. Emits ack + loading events
 *   4. Dispatches to the subsystem
 *   5. Emits result + done
 *
 * The caller does NOT need to manage loading state, ack timing, or TTS —
 * the orchestrator handles all of that.
 */
export async function processViaOrchestrator(
  transcript: string,
  dialogContext?: unknown,
): Promise<{ request_id: string; subsystem: string; handled_locally: boolean } | null> {
  if (!isTauri()) return null;

  const { invoke } = await import("@tauri-apps/api/core");

  try {
    const result = await invoke<{
      request_id: string;
      subsystem: string;
      handled_locally: boolean;
    }>("orchestrator_process", {
      transcript,
      dialogContext: dialogContext ?? null,
    });

    currentRequestId = result.request_id;
    console.log("[NEXUS] orchestrator: process result", result);
    return result;
  } catch (err) {
    console.error("[NEXUS] orchestrator: process failed:", err);
    return null;
  }
}

/** Cancel the active orchestrator request (barge-in / new wake). */
export async function cancelOrchestrator(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("orchestrator_cancel");
    stopTts();
    currentRequestId = null;
  } catch (err) {
    console.warn("[NEXUS] orchestrator: cancel failed:", err);
  }
}

/** Signal that a request is done (called after TTS finishes). */
export async function signalOrchestratorDone(requestId: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("orchestrator_done", { requestId });
  } catch (err) {
    console.warn("[NEXUS] orchestrator: done signal failed:", err);
  }
}
