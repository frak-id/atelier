import { exec as execCallback, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { node } from "@elysiajs/node";
import { Elysia, t } from "elysia";

const exec = promisify(execCallback);

const AGENT_PORT = 9999;
const CONFIG_PATH = "/etc/sandbox/config.json";
const LOG_DIR = "/var/log/sandbox";

interface SandboxConfig {
  sandboxId: string;
  projectId?: string;
  projectName?: string;
  gitUrl?: string;
  createdAt: string;
}

interface AppPort {
  port: number;
  name: string;
  registeredAt: string;
}

const registeredApps: AppPort[] = [];

async function loadConfig(): Promise<SandboxConfig | null> {
  try {
    const content = await readFile(CONFIG_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

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

async function getServiceStatus(service: string) {
  try {
    const { stdout } = await exec(`pgrep -f "${service}" 2>/dev/null || true`);
    const pids = stdout.trim().split("\n").filter(Boolean);
    return {
      name: service,
      running: pids.length > 0,
      pid: pids.length > 0 ? parseInt(pids[0], 10) : undefined,
    };
  } catch {
    return { name: service, running: false };
  }
}

function getCpuUsage(): number {
  try {
    const loadavg = readFileSync("/proc/loadavg", "utf-8");
    const [load1] = loadavg.split(" ");
    return parseFloat(load1 || "0");
  } catch {
    return 0;
  }
}

function getMemoryUsage(): { total: number; used: number; free: number } {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf-8");
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
      total: Math.round(total / 1024),
      used: Math.round((total - free - buffers - cached) / 1024),
      free: Math.round((free + buffers + cached) / 1024),
    };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}

function getDiskUsage(): { total: number; used: number; free: number } {
  try {
    const output = execSync("df -m / | tail -1").toString();
    const [, total, used, free] = output.split(/\s+/);
    return {
      total: parseInt(total || "0", 10),
      used: parseInt(used || "0", 10),
      free: parseInt(free || "0", 10),
    };
  } catch {
    return { total: 0, used: 0, free: 0 };
  }
}

async function getServiceLogs(service: string, lines = 100): Promise<string> {
  const logPath = `${LOG_DIR}/${service}.log`;
  try {
    const fileInfo = await stat(logPath);
    if (!fileInfo.isFile()) return "";

    const content = await readFile(logPath, "utf-8");
    const allLines = content.split("\n");
    return allLines.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

const app = new Elysia({ adapter: node() })
  .get("/health", async () => {
    const config = await loadConfig();
    const [vscode, opencode, sshd] = await Promise.all([
      checkPort(8080),
      checkPort(3000),
      checkPort(22),
    ]);
    return {
      status: "healthy",
      sandboxId: config?.sandboxId,
      services: { vscode, opencode, sshd },
      uptime: process.uptime(),
    };
  })
  .get("/metrics", () => ({
    cpu: getCpuUsage(),
    memory: getMemoryUsage(),
    disk: getDiskUsage(),
    timestamp: new Date().toISOString(),
  }))
  .get("/config", async () => {
    const config = await loadConfig();
    return config ?? { error: "Config not found" };
  })
  .get("/apps", () => registeredApps)
  .post(
    "/apps",
    ({ body }) => {
      const existing = registeredApps.find((a) => a.port === body.port);
      if (existing) {
        existing.name = body.name;
        return existing;
      }
      const app: AppPort = {
        port: body.port,
        name: body.name,
        registeredAt: new Date().toISOString(),
      };
      registeredApps.push(app);
      return app;
    },
    {
      body: t.Object({
        port: t.Number({ minimum: 1, maximum: 65535 }),
        name: t.String(),
      }),
    },
  )
  .delete("/apps/:port", ({ params }) => {
    const port = parseInt(params.port, 10);
    const index = registeredApps.findIndex((a) => a.port === port);
    if (index === -1) return { success: false };
    registeredApps.splice(index, 1);
    return { success: true };
  })
  .post(
    "/exec",
    async ({ body }) => {
      try {
        const { stdout, stderr } = await exec(body.command, {
          timeout: body.timeout ?? 30000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { exitCode: 0, stdout, stderr };
      } catch (error: unknown) {
        const err = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
          message?: string;
        };
        return {
          exitCode: err.code ?? 1,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? err.message ?? "",
        };
      }
    },
    {
      body: t.Object({
        command: t.String(),
        timeout: t.Optional(t.Number({ minimum: 1000, maximum: 300000 })),
      }),
    },
  )
  .get("/logs/:service", async ({ params, query }) => {
    const lines = query.lines ? parseInt(query.lines, 10) : 100;
    const content = await getServiceLogs(params.service, lines);
    return { service: params.service, content };
  })
  .get("/services", async () => {
    const [codeServer, opencode, sshd] = await Promise.all([
      getServiceStatus("code-server"),
      getServiceStatus("opencode"),
      getServiceStatus("sshd"),
    ]);
    return { services: [codeServer, opencode, sshd] };
  })
  .listen(AGENT_PORT, () => {
    console.log(`Sandbox agent running at http://0.0.0.0:${AGENT_PORT}`);
  });

export type App = typeof app;
