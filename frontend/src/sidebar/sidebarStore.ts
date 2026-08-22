import { create } from "zustand";

/**
 * Sidebar store — shared between the main orb window and the sidebar window.
 *
 * The main window calls showSidebar() when a server response arrives,
 * and the sidebar window reads the state to display the response.
 *
 * Since each Tauri window has its own JS context, we use Tauri events
 * to communicate. The main window emits "sidebar:show" / "sidebar:hide"
 * events, and the sidebar window listens for them.
 */

interface SidebarState {
  visible: boolean;
  response: string;
  query: string;
  loading: boolean;
  show: (query: string) => void;
  setResponse: (text: string) => void;
  setLoading: (loading: boolean) => void;
  hide: () => void;
}

export const useSidebar = create<SidebarState>((set) => ({
  visible: false,
  response: "",
  query: "",
  loading: true,
  show: (query: string) => set({ visible: true, query, response: "", loading: true }),
  setResponse: (text: string) => set({ response: text, loading: false }),
  setLoading: (loading: boolean) => set({ loading }),
  hide: () => set({ visible: false, response: "", query: "", loading: false }),
}));
