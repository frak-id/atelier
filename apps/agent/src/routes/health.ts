import { Elysia } from "elysia";
import { loadConfig } from "../utils/config";
import { checkPort } from "../utils/service";
import { getCpuUsage, getDiskUsage, getMemoryUsage } from "../utils/system";

export const healthRoutes = new Elysia()
  .get("/health", async () => {
    const config = await loadConfig();
    const [vscode, opencode, sshd, ttyd] = await Promise.all([
      checkPort(8080),
      checkPort(3000),
      checkPort(22),
      checkPort(7681),
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
