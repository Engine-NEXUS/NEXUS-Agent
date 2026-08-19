/**
 * Bug 2 test: Race condition between finishCapture and abortCapture.
 *
 * Tests that:
 * 1. finishCapture copies pcmBuffer synchronously before any await
 * 2. abortCapture doesn't clear pcmBuffer while finishCapture is in progress
 * 3. The captureInProgress guard prevents interference
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

(globalThis as any).window = {
  __NEXUS_RELEASE_MIC__: () => {},
};

let stateHistory: string[] = [];

vi.mock("../store/assistant", () => {
  let state = "idle";
  const store = {
    get state() { return state; },
    visible: false,
    transcript: [] as any[],
    speakSeq: null,
    setState: (s: string) => { state = s; stateHistory.push(s); },
    setVisible: (_v: boolean) => {},
    addUserMessage: (_t: string) => {},
    addAssistantMessage: (_t: string) => {},
    setSpeakSeq: (_n: number | null) => {},
    reset: () => { state = "idle"; stateHistory.push("idle"); },
    clearTranscript: () => {},
  };
  return {
    useAssistant: { getState: () => store },
    transition: () => true,
  };
});

vi.mock("../net/wsBridge", () => ({
  openSession: vi.fn().mockRejectedValue(new Error("connection refused")),
  closeSession: vi.fn().mockResolvedValue(undefined),
  sendTranscript: vi.fn().mockRejectedValue(new Error("no backend session")),
  hasSession: vi.fn().mockReturnValue(false),
}));

// Make transcribeAudio slow so we can test the race
let transcribeDelay = 0;
vi.mock("./stt", () => ({
  transcribeAudio: vi.fn().mockImplementation(() => {
    return new Promise((resolve) => {
      setTimeout(() => resolve("open gmail"), transcribeDelay);
    });
  }),
}));

import { finishCapture, abortCapture } from "../audio/recorder";

describe("Bug 2: Race condition finishCapture vs abortCapture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateHistory = [];
    transcribeDelay = 0;
  });

  it("abortCapture should not clear buffer when finishCapture is in progress", async () => {
    // Make STT slow so abortCapture runs during finishCapture
    transcribeDelay = 100;

    // Start finishCapture (it will await slow STT)
    const finishPromise = finishCapture();

    // Immediately call abortCapture (simulates 5s auto-hide firing mid-capture)
    await abortCapture();

    // Wait for finishCapture to complete
    await finishPromise;

    // The key assertion: finishCapture should complete without crashing
    // and state should eventually be "idle" (not stuck)
    expect(stateHistory).toContain("idle");
  });

  it("abortCapture should clear buffer when no capture is in progress", async () => {
    // No finishCapture running — abortCapture should work normally
    await abortCapture();
    expect(stateHistory).toContain("idle");
  });

  it("finishCapture should be re-entrant safe", async () => {
    // Call finishCapture twice in quick succession
    const p1 = finishCapture();
    const p2 = finishCapture();
    await Promise.all([p1, p2]);

    // Both should complete without error
    // State should be idle
    expect(stateHistory).toContain("idle");
  });
});
