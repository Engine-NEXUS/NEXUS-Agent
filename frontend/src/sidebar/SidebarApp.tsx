import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSidebar } from "./sidebarStore";

/**
 * NEXUS Response Sidebar
 *
 * A frosted-glass window on the right edge of the screen that shows
 * server responses (from n8n/Ollama/Hermes). Only appears when an
 * info/research query gets a response from the remote server — not for
 * local commands like "open gmail".
 *
 * The sidebar slides in WITH the response already rendered (no loading
 * state). It stays visible until dismissed via Ctrl+Shift+Space (the
 * same global hotkey that wakes the orb).
 *
 * Communication:
 *   - Main window emits "sidebar:show" { query, text } → sidebar slides in with content
 *   - Main window emits "sidebar:hide" → sidebar slides out
 *   - Ctrl+Shift+Space → sidebar hides (handled via the hotkey event)
 */
export function SidebarApp() {
  const visible = useSidebar((s) => s.visible);
  const response = useSidebar((s) => s.response);
  const query = useSidebar((s) => s.query);
  const show = useSidebar((s) => s.show);
  const hide = useSidebar((s) => s.hide);
  const responseRef = useRef<HTMLDivElement>(null);

  // Listen for events from the main window
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen<{ query: string; text: string }>("sidebar:show", (event) => {
      show(event.payload.query, event.payload.text);
    }).then((u) => unlisteners.push(u));

    listen("sidebar:hide", () => {
      hide();
    }).then((u) => unlisteners.push(u));

    return () => {
      unlisteners.forEach((u) => u());
    };
  }, [show, hide]);

  // Auto-scroll response to bottom
  useEffect(() => {
    if (responseRef.current) {
      responseRef.current.scrollTop = responseRef.current.scrollHeight;
    }
  }, [response]);

  // Native window visibility
  useEffect(() => {
    if (visible) {
      invoke("show_sidebar").catch(() => {});
    } else {
      // Delay native hide to let the slide-out animation finish
      const t = setTimeout(() => invoke("hide_sidebar").catch(() => {}), 400);
      return () => clearTimeout(t);
    }
  }, [visible]);

  return (
    <div id="sidebar-app" className={visible ? "sidebar--visible" : "sidebar--hidden"}>
      <div className="sidebar-card">
        {/* Header */}
        <div className="sidebar-header">
          <div className="sidebar-logo">NEXUS</div>
          <div className="sidebar-status">
            <span className="sidebar-done-dot" />
          </div>
        </div>

        {/* Query line — what the user asked */}
        {query && (
          <div className="sidebar-query">{query}</div>
        )}

        {/* Response text */}
        <div className="sidebar-response" ref={responseRef}>
          <div className="sidebar-response-text">{response}</div>
        </div>

        {/* Dismiss hint */}
        <div className="sidebar-dismiss-hint">
          Ctrl+Shift+Space to dismiss
        </div>
      </div>
    </div>
  );
}
