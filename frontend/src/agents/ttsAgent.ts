import { speak, stopTts } from "../audio/ttsPlayer";

interface TtsTask {
  id: string;
  text: string;
  resolve: () => void;
  reject: (err: any) => void;
}

class TtsAgent {
  private queue: TtsTask[] = [];
  private isSpeaking = false;
  private currentTask: TtsTask | null = null;

  /**
   * Enqueue text to be spoken. Returns a promise that resolves when it finishes speaking.
   */
  public async say(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const task: TtsTask = {
        id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
        text,
        resolve,
        reject
      };
      this.queue.push(task);
      this.processQueue();
    });
  }

  /**
   * Stop immediately, clearing the queue and rejecting pending tasks.
   * Useful for barge-in (when user interrupts the agent).
   */
  public interrupt() {
    stopTts();
    this.isSpeaking = false;
    
    // Reject all pending
    if (this.currentTask) {
      this.currentTask.reject(new Error("Interrupted"));
      this.currentTask = null;
    }
    
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      task?.reject(new Error("Interrupted by barge-in"));
    }
  }

  private async processQueue() {
    if (this.isSpeaking || this.queue.length === 0) {
      return;
    }

    this.isSpeaking = true;
    this.currentTask = this.queue.shift() || null;

    if (!this.currentTask) {
      this.isSpeaking = false;
      return;
    }

    try {
      await speak(this.currentTask.text, () => {
        if (this.currentTask) {
          this.currentTask.resolve();
          this.currentTask = null;
        }
        this.isSpeaking = false;
        this.processQueue();
      });
    } catch (err) {
      console.error("[TtsAgent] Error speaking text:", err);
      if (this.currentTask) {
        this.currentTask.reject(err);
        this.currentTask = null;
      }
      this.isSpeaking = false;
      this.processQueue();
    }
  }
}

export const ttsAgent = new TtsAgent();