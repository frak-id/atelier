import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The v2 server (apps/server) listens on :4000 in mock/dev. Proxying every
// server-owned path keeps the browser origin === server origin, so the
// httpOnly `sandbox_token` cookie and CORS are moot in dev.
const SERVER_TARGET = "http://localhost:4000";
const PROXY_PATHS = ["/v1", "/api", "/sessions", "/auth", "/health", "/mcp"];

export default defineConfig({
  plugins: [
    tanstackRouter({ autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5174,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: Object.fromEntries(
      PROXY_PATHS.map((path) => [
        path,
        { target: SERVER_TARGET, changeOrigin: true, ws: true },
      ]),
    ),
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    // `@atelier/server` is a type-only import (Eden `App` type). Never let a
    // stray value import pull the Bun/Node server graph into the browser
    // bundle — fail loudly instead.
    rollupOptions: {
      external: ["@atelier/server"],
    },
  },
});
