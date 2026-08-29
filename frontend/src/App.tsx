import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Avatar } from "./avatar/Avatar";
import { useAssistant } from "./store/assistant";
import { attachClickThrough } from "./overlay/clickThrough";
import { startRecording, abortCapture } from "./audio/recorder";
import { startVad } from "./audio/vad";
import { openSession } from "./net/wsBridge";

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) ?? "wss://supervisor.ultron.internal/ws";
const DEVICE_TOKEN = (import.meta.env.VITE_DEVICE_TOKEN as string) ?? "REPLACE_FROM_KEYCHAIN";
const USER_ID = (import.meta.env.VITE_USER_ID as string) ?? "local-user";
const DEVICE_ID = (import.meta.env.VITE_DEVICE_ID as string) ?? "local-device";

export default function App() {
  const state = useAssistant((s) => s.state);
  const visible = useAssistant((s) => s.visible);

  // Click-through hook lives for the app lifetime.
  useEffect(() => attachClickThrough(), []);

  // React to wake events from Rust (hotkey / Porcupine).
  useEffect(() => {
    const off = listen("assistant:wake", async () => {
      const s = useAssistant.getState();
      if (s.state !== "idle" && s.state !== "speaking") return; // already active

      // Acquire the mic ONCE and share it between the recorder and VAD.
      let stream: MediaStream;
      try {
        s.setVisible(true);
        s.setState("listening");
        await openSession(SERVER_URL, DEVICE_TOKEN, USER_ID, DEVICE_ID);
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        await startRecording(stream);
        await startVad(stream);
      } catch (err) {
        console.error("wake handler failed", err);
        await abortCapture();
      }
    });
    return () => { off.then((f) => f()); };
  }, []);

  // Auto-hide to a subtle state after 4s idle.
  useEffect(() => {
    if (state !== "idle") return;
    const t = setTimeout(() => useAssistant.getState().setVisible(false), 4000);
    return () => clearTimeout(t);
  }, [state]);

  return (
    <div id="app" className={visible ? "app--visible" : "app--hidden"}>
      <Avatar />
      <div className="caption">
        {state === "listening" && "Listening…"}
        {state === "thinking" && "Thinking…"}
        {state === "speaking" && "…"}
      </div>
    </div>
  );
}
