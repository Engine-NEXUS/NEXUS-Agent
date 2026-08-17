import { useEffect } from "react";
import { useRive, useStateMachineInput } from "@rive-app/react-canvas";
import { useAssistant, type AssistantState } from "../store/assistant";

/**
 * Rive-driven avatar. State machine inputs `isListening`, `isThinking`, `isSpeaking`,
 * `idle` are driven from the zustand store. The element is marked `data-interactive`
 * so the click-through hook keeps it mouse-clickable.
 *
 * If Rive fails to load (e.g. dev without the .riv asset), we fall back to a CSS orb so
 * the app remains functional.
 */
export function Avatar() {
  const state = useAssistant((s) => s.state);
  const speakSeq = useAssistant((s) => s.speakSeq);

  const { RiveComponent, rive } = useRive({
    src: "avatar.riv",
    stateMachines: "AssistantSM",
    autoplay: true,
    onLoadError: () => console.warn("avatar.riv missing → CSS fallback"),
  });

  const idleInput = useStateMachineInput(rive, "AssistantSM", "idle");
  const listenInput = useStateMachineInput(rive, "AssistantSM", "isListening");
  const thinkInput = useStateMachineInput(rive, "AssistantSM", "isThinking");
  const speakInput = useStateMachineInput(rive, "AssistantSM", "isSpeaking");

  useEffect(() => {
    const map: Record<AssistantState, boolean[]> = {
      idle: [true, false, false, false],
      listening: [false, true, false, false],
      thinking: [false, false, true, false],
      speaking: [false, false, false, true],
    };
    const [i, l, t, s] = map[state];
    if (idleInput) idleInput.value = i;
    if (listenInput) listenInput.value = l;
    if (thinkInput) thinkInput.value = t;
    if (speakInput) speakInput.value = s;
  }, [state, idleInput, listenInput, thinkInput, speakInput]);

  // Mouth flap while speaking (toggled on each new TTS chunk).
  useEffect(() => {
    if (speakSeq == null || !speakInput) return;
    // small visual pulse by toggling speaking input
    speakInput.value = true;
    const t = setTimeout(() => {
      if (speakInput) speakInput.value = state === "speaking";
    }, 80);
    return () => clearTimeout(t);
  }, [speakSeq, speakInput, state]);

  return (
    <div data-interactive className="avatar-wrap" style={{ position: "relative", width: 140, height: 140 }}>
      {rive ? (
        <RiveComponent style={{ width: "100%", height: "100%" }} />
      ) : (
        // CSS fallback orb — still driven by state via CSS classes.
        <div className={`orb orb--${state}`} />
      )}
    </div>
  );
}
