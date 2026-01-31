import { sandboxConfig } from "../constants.ts";
import { exec } from "../utils/exec.ts";

const startTime = performance.now();

async function checkPort(port: number): Promise<boolean> {
  try {
    const { stdout } = await exec(
      `ss -tlnp 'sport = :${port}' 2>/dev/null | grep -q LISTEN && echo yes || echo no`,
    );
    return stdout.trim() === "yes";
  } catch {
    return false;
  }
}

function getCpuUsage(): number {
  try {
    const loadavg = Deno.readTextFileSync("/proc/loadavg");
    const [load1] = loadavg.split(" ");
    return parseFloat(load1 || "0");
  } catch {
    return 0;
  }
}

function getMemoryUsage(): { total: number; used: number; free: number } {
  try {
    const meminfo = Deno.readTextFileSync("/proc/meminfo");
    const lines = meminfo.split("\n");
    const values: Record<string, number> = {};

    for (const line of lines) {
      const [key, value] = line.split(":");
      if (key && value) {
        values[key.trim()] = parseInt(value.trim().split(" ")[0] || "0", 10);
      }
    }

    const total = values.MemTotal || 0;
    const free = values.MemFree || 0;
    const buffers = values.Buffers || 0;
    const cached = values.Cached || 0;

    return {
      total: total * 1024,
      used: (total - free - buffers - cached) * 1024,
      free: (free + buffers + cached) * 1024,
    };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}

function getDiskUsage(): { total: number; used: number; free: number } {
  try {
    const cmd = new Deno.Command("sh", {
      args: ["-c", "df -B1 / | tail -1"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = cmd.outputSync();
    const text = new TextDecoder().decode(output.stdout);
    const [, total, used, free] = text.split(/\s+/);
    return {
      total: parseInt(total || "0", 10),
      used: parseInt(used || "0", 10),
      free: parseInt(free || "0", 10),
    };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}

export async function handleHealth(): Promise<Response> {
  const services = sandboxConfig?.services;
  const [vscode, opencode, sshd, ttyd, browser] = await Promise.all([
    checkPort(services?.vscode.port ?? 8080),
    checkPort(services?.opencode.port ?? 3000),
    checkPort(22),
    checkPort(services?.terminal.port ?? 7681),
    checkPort(services?.browser?.port ?? 6080),
  ]);
  return Response.json({
    status: "healthy",
    sandboxId: sandboxConfig?.sandboxId,
    services: { vscode, opencode, sshd, ttyd, browser },
    uptime: (performance.now() - startTime) / 1000,
  });
}

export function handleMetrics(): Response {
  return Response.json({
    cpu: getCpuUsage(),
    memory: getMemoryUsage(),
    disk: getDiskUsage(),
    timestamp: new Date().toISOString(),
  });
}
