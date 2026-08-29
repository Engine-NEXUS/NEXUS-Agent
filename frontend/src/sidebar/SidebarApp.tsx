import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useSidebar } from "./sidebarStore";

/**
 * NEXUS Response Sidebar
 *
 * A transparent window on the right edge of the screen that shows
 * server responses (from n8n/Ollama/Hermes). Only appears when a
 * request was sent to the remote server — not for local commands.
 *
 * Communication:
 *   - Main window emits "sidebar:show" { query } → sidebar slides in, shows loading
 *   - Main window emits "sidebar:response" { text } → sidebar shows the response
 *   - Main window emits "sidebar:hide" → sidebar slides out
 */
export function SidebarApp() {
  const visible = useSidebar((s) => s.visible);
  const response = useSidebar((s) => s.response);
  const loading = useSidebar((s) => s.loading);
  const show = useSidebar((s) => s.show);
  const setResponse = useSidebar((s) => s.setResponse);
  const hide = useSidebar((s) => s.hide);
  const responseRef = useRef<HTMLDivElement>(null);

  // Listen for events from the main window
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen<{ query: string }>("sidebar:show", (event) => {
      show(event.payload.query);
    }).then((u) => unlisteners.push(u));

    listen<{ text: string }>("sidebar:response", (event) => {
      setResponse(event.payload.text);
    }).then((u) => unlisteners.push(u));

    listen("sidebar:hide", () => {
      hide();
    }).then((u) => unlisteners.push(u));

    return () => {
      unlisteners.forEach((u) => u());
    };
  }, [show, setResponse, hide]);

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
            {loading ? (
              <span className="sidebar-loading-dot" />
            ) : (
              <span className="sidebar-done-dot" />
            )}
          </div>
        </div>

        {/* Response text */}
        <div className="sidebar-response" ref={responseRef}>
          {loading && !response ? (
            <div className="sidebar-thinking">
              <div className="sidebar-thinking-text">Thinking</div>
              <div className="sidebar-dots">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          ) : (
            <div className="sidebar-response-text">{response}</div>
          )}
        </div>
      </div>
    </div>
  );
}
