import { resolve } from "node:path";
import { loadConfig } from "@frak-sandbox/shared/config-loader";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const ROOT = resolve(__dirname, "../..");
const CONFIG_FILE = resolve(ROOT, "sandbox.config.json");

export default defineConfig(({ mode }) => {
  const frakConfig = loadConfig({ configFile: CONFIG_FILE });

  if (mode === "production") {
    process.env.VITE_API_URL = `https://${frakConfig.domains.api}`;
    process.env.VITE_SSH_HOSTNAME = frakConfig.sshProxy.domain;
    process.env.VITE_SSH_PORT = String(frakConfig.sshProxy.port);
    process.env.VITE_AUTH_ORG_NAME = frakConfig.auth.allowedOrg || "";
    process.env.VITE_OPENCODE_PORT = String(frakConfig.services.opencode.port);
  }

  return {
    plugins: [
      TanStackRouterVite({
        autoCodeSplitting: true,
      }),
      react(),
    ],
    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
        "node:child_process": resolve(
          __dirname,
          "./src/shims/node-child-process.ts",
        ),
      },
    },
    envDir: mode === "production" ? "/dev/null" : undefined,
    server: {
      port: 5173,
      host: "0.0.0.0",
      allowedHosts: true,
      proxy: {
        "/api": {
          target: "http://localhost:4000",
          changeOrigin: true,
        },
        "/auth": {
          target: "http://localhost:4000",
          changeOrigin: true,
        },
        "/health": {
          target: "http://localhost:4000",
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: false,
    },
  };
});
