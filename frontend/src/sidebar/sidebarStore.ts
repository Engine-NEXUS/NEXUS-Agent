import { create } from "zustand";

/**
 * Sidebar store — shared between the main orb window and the sidebar window.
 *
 * The main window emits "sidebar:show" { query, text } when a server response
 * arrives (and only for info/research queries — see shouldShowSidebar()).
 * The sidebar window listens and renders the response immediately.
 *
 * The sidebar stays visible until dismissed via Ctrl+Shift+Space.
 * There is no auto-hide and no "loading" state — the sidebar appears
 * fully formed with the response already in hand.
 */

interface SidebarState {
  visible: boolean;
  response: string;
  query: string;
  show: (query: string, text: string) => void;
  hide: () => void;
}

export const useSidebar = create<SidebarState>((set) => ({
  visible: false,
  response: "",
  query: "",
  show: (query: string, text: string) => set({ visible: true, query, response: text }),
  hide: () => set({ visible: false, response: "", query: "" }),
}));
