import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat, readdir } from "node:fs/promises";
import { readFileSync as readFileSyncCallback } from "node:fs";
import { execSync, exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

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

interface ServiceStatus {
  name: string;
  running: boolean;
  pid?: number;
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

async function getServiceStatus(service: string): Promise<ServiceStatus> {
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
    const loadavg = readFileSyncCallback("/proc/loadavg", "utf-8");
    const [load1] = loadavg.split(" ");
    return parseFloat(load1 || "0");
  } catch {
    return 0;
  }
}

function getMemoryUsage(): { total: number; used: number; free: number } {
  try {
    const meminfo = readFileSyncCallback("/proc/meminfo", "utf-8");
    const lines = meminfo.split("\n");
    const values: Record<string, number> = {};

    for (const line of lines) {
      const [key, value] = line.split(":");
      if (key && value) {
        values[key.trim()] = parseInt(value.trim().split(" ")[0] || "0", 10);
      }
    }

    const total = values["MemTotal"] || 0;
    const free = values["MemFree"] || 0;
    const buffers = values["Buffers"] || 0;
    const cached = values["Cached"] || 0;

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

async function getServiceLogs(
  service: string,
  lines: number = 100,
): Promise<string> {
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

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function json(res: ServerResponse, data: any, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method || "GET";

  try {
    if (method === "GET" && path === "/health") {
      const config = await loadConfig();
      const [vscode, opencode, sshd] = await Promise.all([
        checkPort(8080),
        checkPort(3000),
        checkPort(22),
      ]);
      return json(res, {
        status: "healthy",
        sandboxId: config?.sandboxId,
        services: { vscode, opencode, sshd },
        uptime: process.uptime(),
      });
    }

    if (method === "GET" && path === "/metrics") {
      return json(res, {
        cpu: getCpuUsage(),
        memory: getMemoryUsage(),
        disk: getDiskUsage(),
        timestamp: new Date().toISOString(),
      });
    }

    if (method === "GET" && path === "/config") {
      const config = await loadConfig();
      return json(res, config ?? { error: "Config not found" });
    }

    if (method === "GET" && path === "/apps") {
      return json(res, registeredApps);
    }

    if (method === "POST" && path === "/apps") {
      const body = await parseBody(req);
      if (!body.port || !body.name) {
        return json(res, { error: "port and name required" }, 400);
      }
      const existing = registeredApps.find((a) => a.port === body.port);
      if (existing) {
        existing.name = body.name;
        return json(res, existing);
      }
      const app: AppPort = {
        port: body.port,
        name: body.name,
        registeredAt: new Date().toISOString(),
      };
      registeredApps.push(app);
      return json(res, app);
    }

    if (method === "DELETE" && path.startsWith("/apps/")) {
      const port = parseInt(path.split("/")[2], 10);
      const index = registeredApps.findIndex((a) => a.port === port);
      if (index === -1) return json(res, { success: false });
      registeredApps.splice(index, 1);
      return json(res, { success: true });
    }

    if (method === "POST" && path === "/exec") {
      const body = await parseBody(req);
      if (!body.command) {
        return json(res, { error: "command required" }, 400);
      }
      try {
        const { stdout, stderr } = await exec(body.command, {
          timeout: body.timeout ?? 30000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return json(res, { exitCode: 0, stdout, stderr });
      } catch (error: any) {
        return json(res, {
          exitCode: error.code ?? 1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? error.message,
        });
      }
    }

    if (method === "GET" && path.startsWith("/logs/")) {
      const service = path.split("/")[2];
      const lines = parseInt(url.searchParams.get("lines") || "100", 10);
      const content = await getServiceLogs(service, lines);
      return json(res, { service, content });
    }

    if (method === "GET" && path === "/services") {
      const [codeServer, opencode, sshd] = await Promise.all([
        getServiceStatus("code-server"),
        getServiceStatus("opencode"),
        getServiceStatus("sshd"),
      ]);
      return json(res, { services: [codeServer, opencode, sshd] });
    }

    json(res, { error: "Not found" }, 404);
  } catch (error: any) {
    json(res, { error: error.message }, 500);
  }
});

server.listen(AGENT_PORT, "0.0.0.0", () => {
  console.log(`Sandbox agent running at http://0.0.0.0:${AGENT_PORT}`);
});
