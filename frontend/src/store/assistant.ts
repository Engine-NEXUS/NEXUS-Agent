import { create } from "zustand";

export type AssistantState = "idle" | "listening" | "thinking" | "speaking";

interface AssistantStore {
  state: AssistantState;
  visible: boolean;
  lastTranscript: string | null;
  /** Index of the TTS chunk currently playing (for avatar mouth animation). */
  speakSeq: number | null;
  setState: (s: AssistantState) => void;
  setVisible: (v: boolean) => void;
  setTranscript: (t: string | null) => void;
  setSpeakSeq: (n: number | null) => void;
  /** Reset to idle and hide after a short delay (driven by an effect in App). */
  reset: () => void;
}

export const useAssistant = create<AssistantStore>((set) => ({
  state: "idle",
  visible: false,
  lastTranscript: null,
  speakSeq: null,
  setState: (s) => set({ state: s }),
  setVisible: (v) => set({ visible: v }),
  setTranscript: (t) => set({ lastTranscript: t }),
  setSpeakSeq: (n) => set({ speakSeq: n }),
  reset: () => set({ state: "idle", speakSeq: null, lastTranscript: null }),
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
