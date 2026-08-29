import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects assets at fixed paths; clear base, default port 5173.
export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: ["VITE_"],
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
  },
});
