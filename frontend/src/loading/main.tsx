import React from "react";
import ReactDOM from "react-dom/client";
import { LoadingApp } from "./LoadingApp";
import "./loading.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LoadingApp />
  </React.StrictMode>,
);
