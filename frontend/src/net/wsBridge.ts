import { useAssistant, transition } from "../store/assistant";
import { speak, stopTts } from "../audio/ttsPlayer";

/**
 * Sidebar event helpers — emit events to the sidebar window.
 * The sidebar only shows for server responses (n8n/Ollama/Hermes),
 * NOT for local commands. It slides in WITH the response already rendered
 * (no "Thinking…" state) and stays until dismissed via Ctrl+Shift+Space.
 */
async function emitSidebarShow(query: string, text: string): Promise<void> {
  if (!isTauri()) return;
  try {
    // Call the Rust command that shows the sidebar window AND emits the
    // content event from Rust (more reliable than JS-to-JS event delivery).
    await tauriInvoke("show_sidebar_with_content", { query, text });
    console.log("[NEXUS] sidebar: show_sidebar_with_content IPC ok");
  } catch (e) {
    console.warn("[NEXUS] sidebar:show failed:", e);
  }
}

/** Emit sidebar:hide from the frontend. Currently the hotkey (Rust) emits
 * this directly, but this is exported for programmatic dismissal if needed. */
export async function emitSidebarHide(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("sidebar:hide", {});
  } catch (e) {
    console.warn("[NEXUS] sidebar:hide emit failed:", e);
  }
}

/**
 * Decide whether a server response warrants the sidebar.
 *
 * Three gates, all must pass:
 *   1. Response length >= 80 chars — short replies ("Done, sir") don't need a panel.
 *   2. Query is not a local-command verb (open/close/play/…) — those are handled by the orb.
 *   3. Query contains an info/research intent keyword (check/show/find/what/…).
 *
 * If the server sends an explicit `display: "sidebar"` hint in the result
 * payload, that overrides the heuristic.
 */
function shouldShowSidebar(query: string, response: string): boolean {
  // Gate 1: too short to be worth reading in a panel
  if (response.length < 80) return false;

  // Gate 2: local-command style queries never use the sidebar
  const localVerbs = /^(open|launch|start|close|quit|exit|kill|play|pause|stop|mute|volume|set|turn)\b/i;
  if (localVerbs.test(query.trim())) return false;

  // Gate 3: info/research/server intent markers
  // Note: "analyz" matches "analyze" (American), "analys" matches "analyse"/"analysis" (British)
  const infoIntent = /\b(check|show|list|find|search|look up|what|who|when|where|why|how|explain|summar|review|status|pr|pull request|issue|repo|commit|branch|deploy|log|error|analyz|analys|tell me|give me|get|fetch|read|display)\b/i;
  return infoIntent.test(query);
}

/** Track the pending query so the result handler can decide whether to show the sidebar. */
let pendingQuery = "";

/**
 * HTTP bridge facade (serverless — no WebSocket, no sidecar).
 *
 * The Rust main process makes HTTP POST requests to the Cloudflare Worker
 * and forwards results to the frontend as `assistant:server` events.
 *
 * Protocol (text-only — no audio bytes cross the network):
 *   Client → Worker: POST { request_id, requester, task }
 *   Worker → Client: { reply_text, intent }
 *   Rust emits: state(thinking), ack, result, done
 */

// Build-time fallback only — the real URL comes from get_server_config at runtime.
// This is the Cloudflare Worker URL (HTTPS, not WebSocket — serverless architecture).
const FALLBACK_URL = (import.meta.env.VITE_SERVER_URL as string) ?? "https://nexus-worker.example.workers.dev";
const DEVICE_TOKEN = (import.meta.env.VITE_DEVICE_TOKEN as string) ?? "";

/**
 * Check if we're running inside the Tauri WebView (has IPC bridge).
 */
function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
}

/** Lazy-load Tauri APIs only when running inside the Tauri WebView. */
async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function tauriListen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => handler(e.payload));
}

let unlisten: (() => void) | null = null;

/** Tracks whether a backend session is actually open. */
let sessionOpen = false;

/** Cached server config — loaded once from Rust at first use, then reused. */
let cachedConfig: { url: string; token: string; userId: string; deviceId: string } | null = null;

/**
 * Load server config from Rust (reads nexus-config.json).
 * Falls back to build-time env vars if not in Tauri or if the IPC call fails.
 */
async function getServerConfig(): Promise<{ url: string; token: string; userId: string; deviceId: string }> {
  if (cachedConfig) return cachedConfig;

  if (isTauri()) {
    try {
      const config = await tauriInvoke<{ server_url: string; user_id: string; device_id: string }>("get_server_config");
      cachedConfig = {
        url: config.server_url,
        token: DEVICE_TOKEN,
        userId: config.user_id,
        deviceId: config.device_id,
      };
      return cachedConfig;
    } catch (err) {
      console.warn("[NEXUS] get_server_config failed, using fallback:", err);
    }
  }

  // Fallback: build-time env vars
  cachedConfig = {
    url: FALLBACK_URL,
    token: DEVICE_TOKEN,
    userId: (import.meta.env.VITE_USER_ID as string) ?? "local-user",
    deviceId: (import.meta.env.VITE_DEVICE_ID as string) ?? "local-device",
  };
  return cachedConfig;
}

/**
 * Open a backend session — loads the Worker URL + identity from config.
 * No WebSocket connection is made (serverless HTTP architecture).
 * The Worker is called on-demand when sendTranscript() is invoked.
 */
export async function openSession(
  url?: string,
  token?: string,
  userId?: string,
  deviceId?: string,
): Promise<string> {
  if (!isTauri()) return "";

  // If URL not passed, load from runtime config.
  if (!url) {
    const config = await getServerConfig();
    url = config.url;
    token = token ?? config.token;
    userId = userId ?? config.userId;
    deviceId = deviceId ?? config.deviceId;
  }

  const maxRetries = 5;
  const baseDelayMs = 1000;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const sessionId = await tauriInvoke<string>("open_session", { url, token, userId, deviceId });
      sessionOpen = true;
      if (!unlisten) {
        unlisten = await tauriListen<ServerEvent>("assistant:server", (payload) => handle(payload));
      }
      return sessionId;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
        console.warn(`[NEXUS] backend session attempt ${attempt + 1}/${maxRetries} failed, retrying in ${delay}ms:`, err);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // All retries exhausted — throw so caller falls through to local-only mode.
  throw new Error(`backend session failed after ${maxRetries} retries: ${lastErr}`);
}

/** Returns true if a backend session is currently open. */
export function hasSession(): boolean {
  return sessionOpen;
}

/** Send the transcribed text to the server for processing.
 * Throws if no session is open so the caller can handle the local-only case.
 * Does NOT show the sidebar — the sidebar appears only when the response
 * arrives (in the "result" handler), and only if shouldShowSidebar() agrees. */
export async function sendTranscript(text: string): Promise<void> {
  if (!isTauri()) return;
  if (!sessionOpen) {
    throw new Error("no backend session — local-only mode");
  }
  pendingQuery = text;
  await tauriInvoke("send_transcript", { text });
}

/** Cancel the current turn. */
export async function cancelSession(): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke("cancel_session", {});
}

export async function closeSession(): Promise<void> {
  if (!isTauri()) return;
  sessionOpen = false;
  await tauriInvoke("close_session", {});
}

interface ServerEvent {
  kind: string;
  state?: string | null;
  data?: string | null;
  message?: string | null;
}

function handle(ev: ServerEvent): void {
  const store = useAssistant.getState();
  switch (ev.kind) {
    case "state": {
      const s = (ev.state as any) as AssistantStateKind | undefined;
      if (s && transition(store.state, s)) store.setState(s);
      else if (s) store.setState(s); // allow explicit server override
      break;
    }
    case "ack":
      // Acknowledgement text (e.g. "On it, sir.") — speak it locally and add to transcript.
      if (ev.data) {
        store.addAssistantMessage(ev.data);
        store.setState("speaking");
        void speak(ev.data, () => {
          // After ack finishes, go back to thinking while server processes.
          if (useAssistant.getState().state === "speaking") {
            useAssistant.getState().setState("thinking");
          }
        });
      }
      break;
    case "result":
      // Final result text from the Worker.
      //
      // Behavior:
      //   - Info/research queries (long responses): Show sidebar with the
      //     full text. Speak only "Here is the analysis, sir" — do NOT read
      //     the entire long response aloud. Auto-close orb after TTS.
      //   - Short responses / commands: Speak the response aloud and
      //     auto-close the orb. No sidebar.
      if (ev.data) {
        store.addAssistantMessage(ev.data);
        const isArchitectQuery = /\b(analy[sz]e|map|understand|explore|architecture|what breaks|blast radius)\b/i.test(pendingQuery)
          && /\b(repo|repository|codebase|project|architecture|code)\b/i.test(pendingQuery);

        if (isArchitectQuery && isTauri()) {
          void tauriInvoke("open_architect_window");
        }

        const showSidebar = shouldShowSidebar(pendingQuery, ev.data);
        if (showSidebar) {
          // Show the sidebar with the full response text
          void emitSidebarShow(pendingQuery, ev.data);
          // The orb may have been hidden after "On it sir" — show it briefly
          // so the user sees NEXUS is speaking the confirmation.
          store.setVisible(true);
          store.setState("speaking");
          void speak("Here is the analysis, sir", () => {
            sessionOpen = false;
            store.reset();
            // Auto-close the orb after the short confirmation
            store.setVisible(false);
          });
        } else {
          // Short response — speak it aloud and auto-close
          // The orb may have been hidden — show it for the response.
          store.setVisible(true);
          store.setState("speaking");
          void speak(ev.data, () => {
            sessionOpen = false;
            store.reset();
            store.setVisible(false);
          });
        }
      }
      break;
    case "done":
      // "done" from Rust is now only emitted on error/cancel paths.
      // Normal flow: the "result" handler above emits done after TTS.
      sessionOpen = false;
      store.reset();
      break;
    case "error":
      sessionOpen = false;
      console.error("server error:", ev.message);
      if (ev.message) store.addAssistantMessage(`Error: ${ev.message}`);
      stopTts();
      store.reset();
      // Do NOT auto-hide on error — the user may want to read the error.
      break;
  }
}

type AssistantStateKind = "idle" | "listening" | "thinking" | "speaking";
