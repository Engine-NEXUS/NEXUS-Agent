import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { useSidebar, type SidebarFontSize } from "./sidebarStore";
import { renderMarkdownToHtml } from "./markdownRenderer";
import { speak, stopTts } from "../audio/ttsPlayer";

/**
 * NEXUS Response Sidebar
 *
 * Rich frosted-glass panel rendering full Markdown with:
 * - GitHub Flavored Markdown (GFM) tables & formatting
 * - Syntax-highlighted code blocks with 1-click Copy Code buttons
 * - Responsive images with Lightbox full-size zoom modal
 * - GitHub Callout / Alert cards ([!NOTE], [!TIP], [!IMPORTANT], etc.)
 * - Safe external link handling in user's default browser
 * - Read Aloud (TTS) control, Copy Full Response, Font-size adjustment
 * - Smooth acrylic blur with readable high-contrast typography
 */
export function SidebarApp() {
  const visible = useSidebar((s) => s.visible);
  const response = useSidebar((s) => s.response);
  const query = useSidebar((s) => s.query);
  const fontSize = useSidebar((s) => s.fontSize);
  const speaking = useSidebar((s) => s.speaking);
  const activeImage = useSidebar((s) => s.activeImage);
  const collapsedQuery = useSidebar((s) => s.collapsedQuery);

  const show = useSidebar((s) => s.show);
  const hide = useSidebar((s) => s.hide);
  const setFontSize = useSidebar((s) => s.setFontSize);
  const setSpeaking = useSidebar((s) => s.setSpeaking);
  const setActiveImage = useSidebar((s) => s.setActiveImage);
  const setCollapsedQuery = useSidebar((s) => s.setCollapsedQuery);

  const responseScrollRef = useRef<HTMLDivElement>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [showScrollTop, setShowScrollTop] = useState(false);

  // Render markdown to sanitized HTML with custom enhancements
  const renderedHtml = useMemo(() => {
    return renderMarkdownToHtml(response);
  }, [response]);

  // Expose global hooks for direct IPC evaluation
  useEffect(() => {
    (window as any).__NEXUS_SET_SIDEBAR_CONTENT__ = (q: string, t: string) => {
      show(q, t);
    };
    (window as any).__NEXUS_HIDE_SIDEBAR__ = () => {
      stopTts();
      hide();
    };

    return () => {
      delete (window as any).__NEXUS_SET_SIDEBAR_CONTENT__;
      delete (window as any).__NEXUS_HIDE_SIDEBAR__;
    };
  }, [show, hide]);

  // Listen for Tauri events
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen<{ query: string; text: string }>("sidebar:show", (event) => {
      show(event.payload.query, event.payload.text);
    }).then((u) => unlisteners.push(u));

    listen("sidebar:hide", () => {
      stopTts();
      hide();
    }).then((u) => unlisteners.push(u));

    return () => {
      unlisteners.forEach((u) => u());
    };
  }, [show, hide]);

  // Keyboard shortcut: Escape to close
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (activeImage) {
          setActiveImage(null);
        } else {
          stopTts();
          hide();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hide, activeImage, setActiveImage]);

  // Scroll to top when new response arrives
  useEffect(() => {
    if (responseScrollRef.current) {
      responseScrollRef.current.scrollTop = 0;
    }
  }, [response]);

  // Monitor scroll position for "Scroll to Top" button
  const handleScroll = useCallback(() => {
    if (!responseScrollRef.current) return;
    const st = responseScrollRef.current.scrollTop;
    setShowScrollTop(st > 250);
  }, []);

  // Native window visibility management
  useEffect(() => {
    if (visible) {
      invoke("show_sidebar").catch(() => {});
    } else {
      stopTts();
      const t = setTimeout(() => invoke("hide_sidebar").catch(() => {}), 400);
      return () => clearTimeout(t);
    }
  }, [visible]);

  // Event delegation on the markdown container (handles Copy Code, Image Zoom, Links)
  const handleContainerClick = useCallback(
    async (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;

      // 1. Copy Code button clicked
      const copyBtn = target.closest(".nexus-copy-code-btn") as HTMLButtonElement | null;
      if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        const rawCode = copyBtn.dataset.code ? decodeURIComponent(copyBtn.dataset.code) : "";
        if (rawCode) {
          try {
            await navigator.clipboard.writeText(rawCode);
            const labelEl = copyBtn.querySelector(".nexus-btn-label");
            const originalText = labelEl ? labelEl.textContent : "Copy";
            if (labelEl) labelEl.textContent = "Copied!";
            copyBtn.classList.add("nexus-copied");
            setTimeout(() => {
              if (labelEl) labelEl.textContent = originalText;
              copyBtn.classList.remove("nexus-copied");
            }, 2000);
          } catch (err) {
            console.error("Failed to copy code:", err);
          }
        }
        return;
      }

      // 2. Image Zoom button or Image clicked
      const zoomBtn = target.closest(".nexus-image-zoom-btn") as HTMLButtonElement | null;
      const imgEl = target.closest(".nexus-image") as HTMLImageElement | null;
      if (zoomBtn || imgEl) {
        e.preventDefault();
        e.stopPropagation();
        const src = zoomBtn?.dataset.src || imgEl?.src || "";
        const alt = zoomBtn?.dataset.alt || imgEl?.alt || "Image preview";
        if (src) {
          setActiveImage({ src, alt });
        }
        return;
      }

      // 3. Link clicked
      const linkEl = target.closest(".nexus-link") as HTMLAnchorElement | null;
      if (linkEl) {
        e.preventDefault();
        e.stopPropagation();
        const href = linkEl.dataset.href || linkEl.href;
        if (href && href !== "#") {
          try {
            await openExternal(href);
          } catch {
            window.open(href, "_blank");
          }
        }
      }
    },
    [setActiveImage]
  );

  // Copy entire response
  const handleCopyAll = async () => {
    if (!response) return;
    try {
      await navigator.clipboard.writeText(response);
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 2000);
    } catch (err) {
      console.error("Failed to copy response:", err);
    }
  };

  // Toggle Read Aloud (TTS)
  const handleToggleTts = () => {
    if (speaking) {
      stopTts();
      setSpeaking(false);
    } else {
      if (!response) return;
      setSpeaking(true);
      void speak(response, () => {
        setSpeaking(false);
      });
    }
  };

  // Cycle font size (sm -> md -> lg -> xl -> sm)
  const handleCycleFontSize = () => {
    const sizes: SidebarFontSize[] = ["sm", "md", "lg", "xl"];
    const nextIdx = (sizes.indexOf(fontSize) + 1) % sizes.length;
    setFontSize(sizes[nextIdx]);
  };

  // Scroll to top
  const scrollToTop = () => {
    responseScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div id="sidebar-app" className={visible ? "sidebar--visible" : "sidebar--hidden"}>
      <div className={`sidebar-card font-size--${fontSize}`}>
        {/* ── Top Header Toolbar ─────────────────────────────────────── */}
        <header className="sidebar-header">
          <div className="sidebar-header-left">
            <div className="sidebar-brand-badge">
              <span className="sidebar-brand-dot" />
              <span className="sidebar-brand-name">NEXUS</span>
              <span className="sidebar-tag">INTELLIGENCE</span>
            </div>
          </div>

          <div className="sidebar-header-actions">
            {/* Font Size Toggle */}
            <button
              type="button"
              className="sidebar-action-btn"
              onClick={handleCycleFontSize}
              title={`Font size: ${fontSize.toUpperCase()} (Click to change)`}
            >
              <span className="sidebar-font-size-icon">A</span>
              <span className="sidebar-font-size-label">{fontSize.toUpperCase()}</span>
            </button>

            {/* Read Aloud (TTS) */}
            <button
              type="button"
              className={`sidebar-action-btn ${speaking ? "sidebar-action-btn--active" : ""}`}
              onClick={handleToggleTts}
              title={speaking ? "Stop reading aloud" : "Read aloud (TTS)"}
            >
              {speaking ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                  <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                </svg>
              )}
            </button>

            {/* Copy Full Response */}
            <button
              type="button"
              className={`sidebar-action-btn ${copyFeedback ? "sidebar-action-btn--success" : ""}`}
              onClick={handleCopyAll}
              title={copyFeedback ? "Copied to clipboard!" : "Copy full response"}
            >
              {copyFeedback ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>

            {/* Close Sidebar */}
            <button
              type="button"
              className="sidebar-close-btn"
              onClick={() => {
                stopTts();
                hide();
              }}
              title="Close (Esc)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </header>

        {/* ── User Query Banner ──────────────────────────────────────── */}
        {query && (
          <div className="sidebar-query-card">
            <div className="sidebar-query-header" onClick={() => setCollapsedQuery(!collapsedQuery)}>
              <div className="sidebar-query-title">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span>PROMPT</span>
              </div>
              <button type="button" className="sidebar-query-toggle" aria-label="Toggle query preview">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  style={{ transform: collapsedQuery ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}
                >
                  <polyline points="18 15 12 9 6 15" />
                </svg>
              </button>
            </div>
            {!collapsedQuery && <div className="sidebar-query-text">{query}</div>}
          </div>
        )}

        {/* ── Response Body (Rich Markdown / Tables / Code / Images) ─── */}
        <div className="sidebar-response" ref={responseScrollRef} onScroll={handleScroll}>
          <div
            className="nexus-markdown-body"
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
            onClick={handleContainerClick}
          />
        </div>

        {/* ── Floating Scroll to Top button ──────────────────────────── */}
        {showScrollTop && (
          <button type="button" className="sidebar-scroll-top-btn" onClick={scrollToTop} title="Scroll to top">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
        )}

        {/* ── Footer Status Bar ──────────────────────────────────────── */}
        <footer className="sidebar-footer">
          <div className="sidebar-footer-hint">
            <kbd className="sidebar-kbd">Esc</kbd> or <kbd className="sidebar-kbd">Ctrl+Shift+Space</kbd> to close
          </div>
        </footer>
      </div>

      {/* ── Image Lightbox Modal ─────────────────────────────────────── */}
      {activeImage && (
        <div className="nexus-lightbox-overlay" onClick={() => setActiveImage(null)}>
          <div className="nexus-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <div className="nexus-lightbox-header">
              <span className="nexus-lightbox-title">{activeImage.alt || "Image Preview"}</span>
              <div className="nexus-lightbox-actions">
                <button
                  type="button"
                  className="nexus-lightbox-btn"
                  onClick={() => openExternal(activeImage.src).catch(() => window.open(activeImage.src, "_blank"))}
                  title="Open in external browser"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="nexus-lightbox-btn nexus-lightbox-close"
                  onClick={() => setActiveImage(null)}
                  title="Close (Esc)"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="nexus-lightbox-body">
              <img src={activeImage.src} alt={activeImage.alt} className="nexus-lightbox-img" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
