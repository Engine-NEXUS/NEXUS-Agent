import { invoke } from "@tauri-apps/api/core";

export interface ConversationEntry {
  id: string;
  timestamp: number;
  role: "user" | "assistant";
  text: string;
  intent?: string; // stringified intent action/target
  dayOfWeek: number;
  hourOfDay: number;
}

export interface RoutinePattern {
  action: string;
  target: string;
  count: number;
}

export interface Routine {
  commands: RoutinePattern[];
  timeRange: [number, number]; // e.g. [8, 10]
  confidence: number;
}

export interface Preferences {
  responseLength: "concise" | "detailed";
  preferBrowser: boolean;
  customRoutines?: string[];
}

class MemoryAgent {
  private history: ConversationEntry[] = [];
  private preferences: Preferences = {
    responseLength: "concise",
    preferBrowser: false,
  };
  
  private readonly HISTORY_KEY = "history";
  private readonly PREFS_KEY = "preferences";
  private initialized = false;

  constructor() {
    // Call init() from the UI lifecycle or it will auto-init on first log
  }

  public async init() {
    if (this.initialized) return;
    try {
      const storedHistory = await invoke<string>("load_memory", { key: this.HISTORY_KEY });
      if (storedHistory) {
        this.history = JSON.parse(storedHistory);
      }

      const storedPrefs = await invoke<string>("load_memory", { key: this.PREFS_KEY });
      if (storedPrefs) {
        this.preferences = { ...this.preferences, ...JSON.parse(storedPrefs) };
      }
      this.initialized = true;
      console.log("[MemoryAgent] Loaded memory from disk.");
    } catch (e) {
      console.error("[MemoryAgent] Failed to load local memory from disk:", e);
    }
  }

  private async save() {
    try {
      await invoke("save_memory", { key: this.HISTORY_KEY, data: JSON.stringify(this.history) });
      await invoke("save_memory", { key: this.PREFS_KEY, data: JSON.stringify(this.preferences) });
    } catch (e) {
      console.error("[MemoryAgent] Failed to save local memory to disk:", e);
    }
  }

  /**
   * Log a new conversation turn
   */
  public async log(role: "user" | "assistant", text: string, intent?: string) {
    if (!this.initialized) await this.init();

    const now = new Date();
    const entry: ConversationEntry = {
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2),
      timestamp: now.getTime(),
      role,
      text,
      intent,
      dayOfWeek: now.getDay(),
      hourOfDay: now.getHours(),
    };
    
    this.history.push(entry);

    // Keep history bounded (e.g., last 1000 interactions)
    if (this.history.length > 1000) {
      this.history.shift();
    }
    
    await this.save();
    console.log(`[MemoryAgent] Logged ${role} message`);
  }

  /**
   * Get the most recent conversation context to pass to the backend LLM
   */
  public async getRecentContext(turns: number = 10): Promise<ConversationEntry[]> {
    if (!this.initialized) await this.init();
    return this.history.slice(-turns);
  }

  public async getPreferences(): Promise<Preferences> {
    if (!this.initialized) await this.init();
    return this.preferences;
  }

  public async updatePreferences(updates: Partial<Preferences>) {
    if (!this.initialized) await this.init();
    this.preferences = { ...this.preferences, ...updates };
    await this.save();
  }

  /**
   * Detect patterns based on the current day and time to proactively suggest routines
   */
  public async getRoutineSuggestions(): Promise<string[]> {
    if (!this.initialized) await this.init();

    const now = new Date();
    const currentHour = now.getHours();
    const currentDay = now.getDay();
    const isWeekend = currentDay === 0 || currentDay === 6;

    // Filter to entries around the same time of day (+/- 1 hour) and same type of day (weekday/weekend)
    const relevantEntries = this.history.filter(e => {
      if (e.role !== "user" || !e.intent) return false;
      const eIsWeekend = e.dayOfWeek === 0 || e.dayOfWeek === 6;
      if (isWeekend !== eIsWeekend) return false;

      const hourDiff = Math.abs(e.hourOfDay - currentHour);
      // Account for wrap-around at midnight if necessary, but simple check works for most
      return hourDiff <= 1 || hourDiff >= 23;
    });

    // Count frequency of intents
    const counts: Record<string, number> = {};
    for (const entry of relevantEntries) {
      if (entry.intent) {
        counts[entry.intent] = (counts[entry.intent] || 0) + 1;
      }
    }

    // Identify routines: intents seen 3+ times in this time window
    const routineIntents: string[] = [];
    for (const [intentStr, count] of Object.entries(counts)) {
      if (count >= 3) {
        routineIntents.push(intentStr);
      }
    }

    // Combine dynamically detected routines with custom routines
    const allRoutines = [...this.preferences.customRoutines || [], ...routineIntents];
    // Deduplicate
    const uniqueRoutines = Array.from(new Set(allRoutines));
    return uniqueRoutines;
  }

  public async addCustomRoutine(intentStr: string) {
    if (!this.initialized) await this.init();
    if (!this.preferences.customRoutines) {
      this.preferences.customRoutines = [];
    }
    if (!this.preferences.customRoutines.includes(intentStr)) {
      this.preferences.customRoutines.push(intentStr);
      await this.save();
    }
  }

  public async clearCustomRoutines() {
    if (!this.initialized) await this.init();
    this.preferences.customRoutines = [];
    await this.save();
  }

  /**
   * Wipe all on-device memory
   */
  public async clear() {
    this.history = [];
    try {
      await invoke("clear_memory");
      console.log("[MemoryAgent] Memory wiped from disk.");
    } catch (e) {
      console.error("[MemoryAgent] Failed to clear memory:", e);
    }
  }
}

export const memoryAgent = new MemoryAgent();