import { create } from "zustand";

export interface AgentTask {
  id: string;
  type: "backend" | "architect" | "local";
  query: string;
  status: "pending" | "running" | "done" | "failed";
  result?: string;
  startedAt: number;
}

interface AgentBusStore {
  tasks: AgentTask[];
  addTask: (task: Omit<AgentTask, "id" | "startedAt">) => string;
  updateTask: (id: string, updates: Partial<AgentTask>) => void;
  removeTask: (id: string) => void;
  clearTasks: () => void;
}

export const useAgentBus = create<AgentBusStore>((set) => ({
  tasks: [],
  addTask: (task) => {
    const id = `task-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newTask: AgentTask = {
      ...task,
      id,
      startedAt: Date.now(),
    };
    set((state) => ({ tasks: [...state.tasks, newTask] }));
    return id;
  },
  updateTask: (id, updates) => {
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    }));
  },
  removeTask: (id) => {
    set((state) => ({ tasks: state.tasks.filter((t) => t.id !== id) }));
  },
  clearTasks: () => set({ tasks: [] }),
}));