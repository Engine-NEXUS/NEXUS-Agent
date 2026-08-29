import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAssistant, transition } from "../store/assistant";
import { playTtsChunk, stopTts } from "../audio/ttsPlayer";

/**
 * WebSocket bridge facade.
 *
 * The Rust main process owns the actual WSS connection (so the webview can be torn down
 * between interactions without dropping the socket). The frontend only instructs
 * open/close and reacts to `assistant:server` events forwarded by Rust.
 */

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) ?? "wss://supervisor.ultron.internal/ws";
const DEVICE_TOKEN = (import.meta.env.VITE_DEVICE_TOKEN as string) ?? "REPLACE_FROM_KEYCHAIN";
const USER_ID = (import.meta.env.VITE_USER_ID as string) ?? "local-user";
const DEVICE_ID = (import.meta.env.VITE_DEVICE_ID as string) ?? "local-device";

let unlisten: UnlistenFn | null = null;

export async function openSession(
  url: string = SERVER_URL,
  token: string = DEVICE_TOKEN,
  userId: string = USER_ID,
  deviceId: string = DEVICE_ID,
): Promise<string> {
  const sessionId = await invoke<string>("open_session", { url, token, userId, deviceId });
  if (!unlisten) {
    unlisten = await listen<ServerEvent>("assistant:server", (e) => handle(e.payload));
  }
  return sessionId;
}

/** Signal end-of-audio (VAD silence) so the sidecar flushes to STT + n8n. */
export async function endAudio(): Promise<void> {
  await invoke("end_audio", {});
}

/** Cancel the current turn. */
export async function cancelSession(): Promise<void> {
  await invoke("cancel_session", {});
}

export async function closeSession(): Promise<void> {
  await invoke("close_session", {});
}

interface ServerEvent {
  kind: string;
  state?: string | null;
  seq?: number | null;
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
    case "transcript":
      // User's transcribed speech — add to transcript display.
      if (ev.data) store.addUserMessage(ev.data);
      break;
    case "tts_chunk":
      if (store.state !== "speaking") store.setState("speaking");
      if (ev.data) {
        void playTtsChunk(ev.seq ?? 0, ev.data);
      }
      break;
    case "ack":
      // Acknowledgement text (e.g. "On it, sir.") — add to transcript.
      if (ev.data) store.addAssistantMessage(ev.data);
      break;
    case "result":
      // Final result text from n8n — add to transcript.
      if (ev.data) store.addAssistantMessage(ev.data);
      break;
    case "done":
      stopTts();
      store.reset();
      break;
    case "error":
      console.error("server error:", ev.message);
      if (ev.message) store.addAssistantMessage(`Error: ${ev.message}`);
      store.reset();
      break;
  }
}

type AssistantStateKind = "idle" | "listening" | "thinking" | "speaking";
