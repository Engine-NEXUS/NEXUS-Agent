import { useAgentBus } from "./AgentBus";
import { parseIntent } from "../intent/parser";
import { memoryAgent } from "./memoryAgent";
import { ttsAgent } from "./ttsAgent";
import { useAssistant } from "../store/assistant";

class MainAgent {
  /**
   * Main entrypoint for processing user transcripts.
   * This replaces the logic that used to be duplicated inside recorder.ts.
   */
  public async handleTranscript(transcript: string) {
    if (!transcript.trim()) return;

    console.log(`[MainAgent] Processing transcript: "${transcript}"`);
    memoryAgent.log("user", transcript);

    const store = useAssistant.getState();
    store.setState("thinking");

    // 1. Check for routines/predictions before falling back to manual parsing
    // (In the future, the memory agent could intercept here)

    // 2. Parse intent locally
    const intent = parseIntent(transcript);
    
    // Log intent to memory if it's known
    if (intent.action !== "unknown") {
      memoryAgent.log("user", transcript, JSON.stringify(intent));
    }

    if (intent.action === "open_architect") {
      useAgentBus.getState().addTask({ type: "architect", query: transcript, status: "pending" });
      await ttsAgent.say("Opening Architecture Mapper, sir.");
      store.reset();
      store.setVisible(false);
      return;
    }

    if (intent.action !== "unknown") {
      // Known local command — execute it directly.
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const result = await invoke<{ success: boolean; message: string }>("execute_command", { intent });
        
        console.log("[MainAgent] local command result:", result);
        
        let confirmText = "Ok sir.";
        if (result.message) {
          confirmText = result.message;
        }
        
        // Only say "Ok sir." if it wasn't a specific message from Rust, but since
        // Rust usually returns something or we default to Ok sir.
        store.addAssistantMessage(confirmText);
        await ttsAgent.say(confirmText.replace(/,/g, ""));
      } catch (err) {
        console.error("[MainAgent] Local intent execution failed:", err);
        store.addAssistantMessage("Execution failed.");
        await ttsAgent.say("I encountered an error executing that command, sir.");
      }
      
      // Give TTS a moment, then hide
      setTimeout(() => {
        store.setVisible(false);
        setTimeout(() => store.reset(), 550);
      }, 800);
      return;
    }

    // 3. Fallback to backend processing
    console.log("[MainAgent] Routing to backend TaskAgent");
    useAgentBus.getState().addTask({ type: "backend", query: transcript, status: "pending" });
    
    // Note: The TaskAgent will trigger the wsBridge, which emits `assistant:server` events.
    // The wsBridge handler in wsBridge.ts currently updates the assistant store and triggers TTS.
    // In a future refactor, we would intercept those events here and route them to ttsAgent.
  }
}

export const mainAgent = new MainAgent();