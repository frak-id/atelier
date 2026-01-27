import { Elysia } from "elysia";
import { sandboxConfig } from "../constants";
import { checkPort } from "../utils/service";
import { getCpuUsage, getDiskUsage, getMemoryUsage } from "../utils/system";

export const healthRoutes = new Elysia()
  .get("/health", async () => {
    const services = sandboxConfig?.services;
    const [vscode, opencode, sshd, ttyd] = await Promise.all([
      checkPort(services?.vscode.port ?? 8080),
      checkPort(services?.opencode.port ?? 3000),
      checkPort(22),
      checkPort(services?.terminal.port ?? 7681),
    ]);
    return {
      status: "healthy",
      sandboxId: sandboxConfig?.sandboxId,
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
