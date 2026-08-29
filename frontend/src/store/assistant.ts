import { create } from "zustand";

export type AssistantState = "idle" | "listening" | "thinking" | "speaking";

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
  /** Current microphone audio volume (RMS, 0.0 - ~1.0) for avatar reactivity. */
  audioVolume: number;
  setState: (s: AssistantState) => void;
  setVisible: (v: boolean) => void;
  setAudioVolume: (v: number) => void;
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
  audioVolume: 0,
  setState: (s) => set({ state: s }),
  setVisible: (v) => set({ visible: v }),
  setAudioVolume: (v) => set({ audioVolume: v }),
  addUserMessage: (text) =>
    set((st) => ({
      transcript: [...st.transcript, { role: "user", text, timestamp: Date.now() }],
    })),
  addAssistantMessage: (text) =>
    set((st) => ({
      transcript: [...st.transcript, { role: "assistant", text, timestamp: Date.now() }],
    })),
  setSpeakSeq: (n) => set({ speakSeq: n }),
  reset: () => set({ state: "idle", speakSeq: null, audioVolume: 0 }),
  clearTranscript: () => set({ transcript: [] }),
}));

/**
 * Canonical state-machine transitions. Enforced everywhere we call setState.
 *   idle  -> listening   (wake / hotkey)
 *   listening -> thinking (VAD silence + local STT + transcript sent)
 *   thinking -> speaking (ack or result event — local TTS speaks)
 *   speaking -> idle      (done event)
 */
export function transition(from: AssistantState, to: AssistantState): boolean {
  const allowed: Record<AssistantState, AssistantState[]> = {
    idle: ["listening"],
    listening: ["thinking", "idle"],
    thinking: ["speaking", "idle"],
    speaking: ["idle"],
  };
  return allowed[from]?.includes(to) ?? false;
}
