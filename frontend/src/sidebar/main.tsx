import React from "react";
import ReactDOM from "react-dom/client";
import { SidebarApp } from "./SidebarApp";
import "./sidebar.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SidebarApp />
  </React.StrictMode>,
);
