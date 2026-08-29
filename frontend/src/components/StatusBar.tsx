import { motion, AnimatePresence } from "framer-motion";
import { useAssistant, STATUS_TEXT } from "../store/assistant";

/**
 * Status bar shown below the orb.
 * Displays the current state as uppercase tracked text with a pulsing dot.
 * Hidden when idle (no text to show).
 */
export function StatusBar() {
  const state = useAssistant((s) => s.state);
  const statusText = STATUS_TEXT[state];

  return (
    <div className={`nx-status nx-status--${state}`}>
      <AnimatePresence mode="wait">
        {statusText && (
          <motion.div
            key={statusText}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            style={{ display: "flex", alignItems: "center", gap: "var(--nx-space-2)" }}
          >
            <span className="nx-status-dot" />
            {statusText}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
