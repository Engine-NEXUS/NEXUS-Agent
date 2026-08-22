import { create } from "zustand";

export type AssistantState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "error";

/** Human-readable status text shown below the orb. */
export const STATUS_TEXT: Record<AssistantState, string> = {
  idle: "",
  connecting: "CONNECTING",
  listening: "LISTENING",
  thinking: "THINKING",
  speaking: "SPEAKING",
  error: "CONNECTION ERROR",
};

/** Accent color per state (matches CSS tokens). */
export const STATE_COLOR: Record<AssistantState, string> = {
  idle: "#6aa8ff",
  connecting: "#6aa8ff",
  listening: "#6aa8ff",
  thinking: "#a855f7",
  speaking: "#22c55e",
  error: "#DC2626",
};

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

interface AssistantStore {
  state: AssistantState;
  visible: boolean;
  /** Conversation transcript for display in the sidebar. */
  transcript: TranscriptEntry[];
  /** Index of the TTS chunk currently playing (for avatar mouth animation). */
  speakSeq: number | null;
  setState: (s: AssistantState) => void;
  setVisible: (v: boolean) => void;
  addUserMessage: (text: string) => void;
  addAssistantMessage: (text: string) => void;
  setSpeakSeq: (n: number | null) => void;
  /** Reset to idle and hide after a short delay (driven by an effect in App). */
  reset: () => void;
  /** Clear the transcript. */
  clearTranscript: () => void;
}

export const useAssistant = create<AssistantStore>((set) => ({
  state: "idle",
  visible: false,
  transcript: [],
  speakSeq: null,
  setState: (s) => set({ state: s }),
  setVisible: (v) => set({ visible: v }),
  addUserMessage: (text) =>
    set((st) => ({
      transcript: [...st.transcript, { role: "user", text, timestamp: Date.now() }],
    })),
  addAssistantMessage: (text) =>
    set((st) => ({
      transcript: [...st.transcript, { role: "assistant", text, timestamp: Date.now() }],
    })),
  setSpeakSeq: (n) => set({ speakSeq: n }),
  reset: () => set({ state: "idle", speakSeq: null }),
  clearTranscript: () => set({ transcript: [] }),
}));

/**
 * Canonical state-machine transitions. Enforced everywhere we call setState.
 *   idle       -> connecting, listening   (wake / hotkey)
 *   connecting -> listening, error        (ws connected / failed)
 *   listening  -> thinking, idle          (VAD silence + STT + transcript sent)
 *   thinking   -> speaking, idle, error   (result / cancel / ws down)
 *   speaking   -> idle                    (done event)
 *   error      -> idle, connecting        (retry / dismiss)
 */
export function transition(from: AssistantState, to: AssistantState): boolean {
  const allowed: Record<AssistantState, AssistantState[]> = {
    idle: ["connecting", "listening"],
    connecting: ["listening", "error"],
    listening: ["thinking", "idle"],
    thinking: ["speaking", "idle", "error"],
    speaking: ["idle"],
    error: ["idle", "connecting"],
  };
  return allowed[from]?.includes(to) ?? false;
}
