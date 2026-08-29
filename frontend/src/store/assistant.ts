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
 *   idle  -> listening   (wake / hotkey)
 *   listening -> thinking (VAD silence + session open)
 *   thinking -> speaking (first tts_chunk)
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
