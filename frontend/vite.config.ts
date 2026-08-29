import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Tauri expects assets at fixed paths; clear base, default port 5173.
// Multi-page: index.html (overlay) + setup.html (setup window).
//
// Silero VAD files (model + worklet) live in public/ so Vite serves them
// as-is without any transformation. ONNX WASM runtime is loaded from CDN
// to avoid the known Vite+onnxruntime-web dynamic import incompatibility.
export default defineConfig({
  plugins: [react()],
  base: "./",
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  },
  envPrefix: ["VITE_"],
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        setup: resolve(__dirname, "setup.html"),
      },
    },
  },
});
