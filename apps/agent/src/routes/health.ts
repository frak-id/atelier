import { Elysia } from "elysia";
import { SERVICE_PORTS } from "../constants";
import { loadConfig } from "../utils/config";
import { checkPort } from "../utils/service";
import { getCpuUsage, getDiskUsage, getMemoryUsage } from "../utils/system";

export const healthRoutes = new Elysia()
  .get("/health", async () => {
    const config = await loadConfig();
    const [vscode, opencode, sshd, ttyd] = await Promise.all([
      checkPort(SERVICE_PORTS.vscodePort),
      checkPort(SERVICE_PORTS.opencodePort),
      checkPort(22),
      checkPort(SERVICE_PORTS.terminalPort),
    ]);
    return {
      status: "healthy",
      sandboxId: config?.sandboxId,
      services: { vscode, opencode, sshd, ttyd },
      uptime: process.uptime(),
    };
  })
  .get("/metrics", () => ({
    cpu: getCpuUsage(),
    memory: getMemoryUsage(),
    disk: getDiskUsage(),
    timestamp: new Date().toISOString(),
  }));
