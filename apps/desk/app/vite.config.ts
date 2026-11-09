import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri serves the built files itself; in dev it loads this server.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    // One HTML page; each window picks its surface from ?surface= (src/main.tsx).
    outDir: "dist",
    // The webview loads the bundle from disk, never over a network, so one chunk past 500 kB costs nothing.
    chunkSizeWarningLimit: 1000,
  },
  test: { globals: true, environment: "node", include: ["src/**/*.test.ts", "src/**/*.test.tsx"] },
});
