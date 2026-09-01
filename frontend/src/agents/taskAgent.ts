import { useAgentBus, AgentTask } from "./AgentBus";
import { openSession, sendTranscript, hasSession } from "../net/wsBridge";

function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== "undefined";
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject("Not in Tauri");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

class TaskAgent {
  private processing = false;

  constructor() {
    // Subscribe to task bus changes
    useAgentBus.subscribe((state) => {
      const pendingTasks = state.tasks.filter((t) => t.status === "pending");
      if (pendingTasks.length > 0 && !this.processing) {
        this.processNextTask();
      }
    });
  }

  private async processNextTask() {
    this.processing = true;
    const store = useAgentBus.getState();
    const task = store.tasks.find((t) => t.status === "pending");

    if (!task) {
      this.processing = false;
      return;
    }

    store.updateTask(task.id, { status: "running" });

    try {
      if (task.type === "backend") {
        await this.handleBackendTask(task);
      } else if (task.type === "architect") {
        await this.handleArchitectTask(task);
      } else {
        await this.handleLocalTask(task);
      }
    } catch (err) {
      console.error(`[TaskAgent] Task ${task.id} failed:`, err);
      store.updateTask(task.id, { status: "failed" });
    }

    this.processing = false;
    
    // Check if more tasks are queued
    if (useAgentBus.getState().tasks.some(t => t.status === "pending")) {
      setTimeout(() => this.processNextTask(), 100);
    }
  }

  private async handleBackendTask(task: AgentTask) {
    if (!hasSession()) {
      await openSession();
    }
    
    // We delegate to wsBridge to send the transcript.
    // The wsBridge will handle the response via the `assistant:server` events
    // which the MainAgent will listen to.
    await sendTranscript(task.query);
    useAgentBus.getState().updateTask(task.id, { status: "done" });
  }

  private async handleArchitectTask(task: AgentTask) {
    if (!isTauri()) {
      useAgentBus.getState().updateTask(task.id, { status: "failed", result: "Not in Tauri" });
      return;
    }

    try {
      const active = await tauriInvoke<{ owner: string; repo: string } | null>("get_active_repo_url");
      const owner = active?.owner;
      const repo = active?.repo;
      await tauriInvoke("open_architect_window", owner && repo ? { owner, repo } : {});
      useAgentBus.getState().updateTask(task.id, { status: "done" });
    } catch (e) {
      console.warn("[TaskAgent] Failed to open architect window", e);
      try {
        await tauriInvoke("open_architect_window");
        useAgentBus.getState().updateTask(task.id, { status: "done" });
      } catch {
        useAgentBus.getState().updateTask(task.id, { status: "failed" });
      }
    }
  }

  private async handleLocalTask(task: AgentTask) {
    // Local tasks (like open app) are typically executed synchronously by Rust
    // before it even hits the frontend queue, but if we route one here:
    console.log(`[TaskAgent] Executing local task: ${task.query}`);
    useAgentBus.getState().updateTask(task.id, { status: "done", result: "Executed locally" });
  }
}

export const taskAgent = new TaskAgent();