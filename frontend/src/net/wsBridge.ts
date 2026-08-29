import { useAssistant, transition } from "../store/assistant";
import { speak, stopTts } from "../audio/ttsPlayer";

/**
 * Sidebar event helpers — emit events to the sidebar window.
 * The sidebar only shows for server responses (n8n/Ollama/Hermes),
 * NOT for local commands.
 */
async function emitSidebarShow(query: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("sidebar:show", { query });
  } catch (e) {
    console.warn("[NEXUS] sidebar:show emit failed:", e);
  }
}

async function emitSidebarResponse(text: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("sidebar:response", { text });
  } catch (e) {
    console.warn("[NEXUS] sidebar:response emit failed:", e);
  }
}

async function emitSidebarHide(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("sidebar:hide", {});
  } catch (e) {
    console.warn("[NEXUS] sidebar:hide emit failed:", e);
  }
}

/**
 * WebSocket bridge facade.
 *
 * The Rust main process owns the actual WSS connection (so the webview can be torn down
 * between interactions without dropping the socket). The frontend only instructs
 * open/close and reacts to `assistant:server` events forwarded by Rust.
 *
 * Protocol (text-only — no audio bytes cross the network):
 *   Client → Server: start, transcript, cancel
 *   Server → Client: state, ack, result, done, error
 */

// Build-time fallback only — the real URL comes from get_server_config at runtime.
const FALLBACK_URL = (import.meta.env.VITE_SERVER_URL as string) ?? "ws://127.0.0.1:49152/ws";
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
 * Open a backend session with retry logic.
 *
 * On cold boot, the Python sidecar may take 3-10 seconds to start.
 * This retries the connection with exponential backoff instead of
 * failing immediately.
 *
 * @param maxRetries Number of retry attempts (default 5)
 * @param baseDelayMs Initial delay between retries (default 1000ms, doubles each time)
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
 * On success, emits sidebar:show so the response sidebar slides in. */
export async function sendTranscript(text: string): Promise<void> {
  if (!isTauri()) return;
  if (!sessionOpen) {
    throw new Error("no backend session — local-only mode");
  }
  await tauriInvoke("send_transcript", { text });
  // Server request succeeded — show the response sidebar
  await emitSidebarShow(text);
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
      // Final result text from n8n — speak it locally and add to transcript.
      if (ev.data) {
        store.addAssistantMessage(ev.data);
        store.setState("speaking");
        // Show the response in the sidebar
        void emitSidebarResponse(ev.data);
        void speak(ev.data, () => {
          // After result finishes, the done event will reset to idle.
        });
      }
      break;
    case "done":
      sessionOpen = false;
      stopTts();
      store.reset();
      // Hide the sidebar after the response is done
      void emitSidebarHide();
      break;
    case "error":
      sessionOpen = false;
      console.error("server error:", ev.message);
      if (ev.message) store.addAssistantMessage(`Error: ${ev.message}`);
      stopTts();
      store.reset();
      // Hide the sidebar on error too
      void emitSidebarHide();
      break;
  }
}

type AssistantStateKind = "idle" | "listening" | "thinking" | "speaking";
