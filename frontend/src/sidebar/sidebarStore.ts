import { create } from "zustand";

/**
 * Sidebar store — shared state for the NEXUS Response Sidebar window.
 *
 * Supports:
 * - Response text and user query
 * - Font size customization (saved to localStorage)
 * - TTS playback tracking
 * - Lightbox modal for enlarged image viewing
 * - Copy confirmation feedback
 */

export type SidebarFontSize = "sm" | "md" | "lg" | "xl";

interface SidebarState {
  visible: boolean;
  response: string;
  query: string;
  timestamp: number;
  fontSize: SidebarFontSize;
  speaking: boolean;
  activeImage: { src: string; alt: string } | null;
  collapsedQuery: boolean;

  show: (query: string, text: string) => void;
  hide: () => void;
  setFontSize: (size: SidebarFontSize) => void;
  setSpeaking: (speaking: boolean) => void;
  setActiveImage: (image: { src: string; alt: string } | null) => void;
  setCollapsedQuery: (collapsed: boolean) => void;
}

const SAVED_FONT_SIZE = (localStorage.getItem("nexus_sidebar_font_size") as SidebarFontSize) || "md";

export const useSidebar = create<SidebarState>((set) => ({
  visible: false,
  response: "",
  query: "",
  timestamp: 0,
  fontSize: SAVED_FONT_SIZE,
  speaking: false,
  activeImage: null,
  collapsedQuery: false,

  show: (query: string, text: string) =>
    set({
      visible: true,
      query,
      response: text,
      timestamp: Date.now(),
      speaking: false,
      activeImage: null,
    }),

  hide: () =>
    set({
      visible: false,
      response: "",
      query: "",
      speaking: false,
      activeImage: null,
    }),

  setFontSize: (size: SidebarFontSize) => {
    localStorage.setItem("nexus_sidebar_font_size", size);
    set({ fontSize: size });
  },

  setSpeaking: (speaking: boolean) => set({ speaking }),

  setActiveImage: (activeImage) => set({ activeImage }),

  setCollapsedQuery: (collapsedQuery) => set({ collapsedQuery }),
}));
