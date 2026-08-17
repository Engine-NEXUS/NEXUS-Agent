import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAssistant, transition } from "../store/assistant";
import { speak, stopTts } from "../audio/ttsPlayer";

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

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) ?? "wss://supervisor.nexus.internal/ws";
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

/** Send the transcribed text to the server for processing. */
export async function sendTranscript(text: string): Promise<void> {
  await invoke("send_transcript", { text });
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
        void speak(ev.data, () => {
          // After result finishes, the done event will reset to idle.
        });
      }
      break;
    case "done":
      stopTts();
      store.reset();
      break;
    case "error":
      console.error("server error:", ev.message);
      if (ev.message) store.addAssistantMessage(`Error: ${ev.message}`);
      stopTts();
      store.reset();
      break;
  }
}

type AssistantStateKind = "idle" | "listening" | "thinking" | "speaking";
