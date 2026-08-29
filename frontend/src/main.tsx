import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

/**
 * Expose a global wake function that Rust calls via win.eval().
 * This bypasses the Tauri event system which has reliability issues
 * with repeated events in v2.
 */
(window as any).__NEXUS_WAKE__ = () => {
  import("./store/assistant").then(({ useAssistant }) => {
    const s = useAssistant.getState();
    console.log("[NEXUS] wake →", s.state);
    s.setVisible(true);
    s.setState("listening");
  });
};

(window as any).__NEXUS_CANCEL__ = () => {
  import("./store/assistant").then(({ useAssistant }) => {
    console.log("[NEXUS] cancel");
    useAssistant.getState().reset();
    useAssistant.getState().setVisible(false);
  });
};

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
