import React from "react";
import ReactDOM from "react-dom/client";
import { ArchitectApp } from "./ArchitectApp";
import "./architect.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ArchitectApp />
  </React.StrictMode>,
);
