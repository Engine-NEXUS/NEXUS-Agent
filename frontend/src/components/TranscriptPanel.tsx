import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAssistant } from "../store/assistant";

/**
 * Transcript panel shown below the status bar.
 * Displays the last few conversation messages with auto-scroll.
 * Shows a placeholder when empty.
 */
export function TranscriptPanel() {
  const transcript = useAssistant((s) => s.transcript);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript]);

  // Show last 4 messages to keep the panel compact
  const visible = transcript.slice(-4);

  return (
    <div className="nx-transcript" ref={scrollRef}>
      {visible.length === 0 ? (
        <div className="nx-transcript-empty">
          Say something to NEXUS…
        </div>
      ) : (
        <AnimatePresence initial={false}>
          {visible.map((msg, i) => {
            const idx = transcript.length - visible.length + i;
            return (
              <motion.div
                key={`${idx}-${msg.timestamp}`}
                initial={{ opacity: 0, y: 8, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                className={`nx-msg nx-msg--${msg.role}`}
              >
                <div className="nx-msg-role">
                  {msg.role === "user" ? "You" : "NEXUS"}
                </div>
                {msg.text}
              </motion.div>
            );
          })}
        </AnimatePresence>
      )}
    </div>
  );
}
