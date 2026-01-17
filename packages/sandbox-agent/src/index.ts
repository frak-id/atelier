import { exec as execCallback, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { node } from "@elysiajs/node";
import { Elysia, t } from "elysia";

const exec = promisify(execCallback);

const AGENT_PORT = 9999;
const CONFIG_PATH = "/etc/sandbox/config.json";
const LOG_DIR = "/var/log/sandbox";
const VSCODE_SETTINGS_PATH =
  "/home/dev/.local/share/code-server/User/settings.json";
const VSCODE_EXTENSIONS_PATH = "/etc/sandbox/vscode-extensions.json";
const OPENCODE_AUTH_PATH = "/home/dev/.config/opencode/auth.json";
const OPENCODE_CONFIG_PATH = "/home/dev/.config/opencode/config.json";

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

interface DiscoveredConfig {
  path: string;
  displayPath: string;
  category: "opencode" | "vscode" | "other";
  exists: boolean;
  size?: number;
}

const KNOWN_CONFIG_PATHS = [
  {
    path: "/home/dev/.config/opencode/auth.json",
    category: "opencode" as const,
  },
  {
    path: "/home/dev/.config/opencode/config.json",
    category: "opencode" as const,
  },
  {
    path: "/home/dev/.local/share/code-server/User/settings.json",
    category: "vscode" as const,
  },
];

const CONFIG_DIRECTORIES = [
  { dir: "/home/dev/.config/opencode", category: "opencode" as const },
  { dir: "/home/dev/.opencode", category: "opencode" as const },
];

function discoverConfigFiles(): DiscoveredConfig[] {
  const results: DiscoveredConfig[] = [];
  const seenPaths = new Set<string>();

  for (const { path, category } of KNOWN_CONFIG_PATHS) {
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);

    const exists = existsSync(path);
    let size: number | undefined;
    if (exists) {
      try {
        size = statSync(path).size;
      } catch {}
    }

    results.push({
      path,
      displayPath: path.replace("/home/dev", "~"),
      category,
      exists,
      size,
    });
  }

  for (const { dir, category } of CONFIG_DIRECTORIES) {
    if (!existsSync(dir)) continue;

    try {
      const files = readdirSync(dir);
      for (const file of files) {
        if (
          !file.endsWith(".json") &&
          !file.endsWith(".js") &&
          !file.endsWith(".ts")
        )
          continue;

        const fullPath = join(dir, file);
        if (seenPaths.has(fullPath)) continue;
        seenPaths.add(fullPath);

        try {
          const stats = statSync(fullPath);
          if (!stats.isFile()) continue;

          results.push({
            path: fullPath,
            displayPath: fullPath.replace("/home/dev", "~"),
            category,
            exists: true,
            size: stats.size,
          });
        } catch {}
      }
    } catch {}
  }

  return results.filter((r) => r.exists);
}

const app = new Elysia({ adapter: node() })
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
    const [codeServer, opencode, sshd, ttyd] = await Promise.all([
      getServiceStatus("code-server"),
      getServiceStatus("opencode"),
      getServiceStatus("sshd"),
      getServiceStatus("ttyd"),
    ]);
    return { services: [codeServer, opencode, sshd, ttyd] };
  })
  .get("/editor-config", async () => {
    const [vscodeSettings, vscodeExtensions, opencodeAuth, opencodeConfig] =
      await Promise.all([
        readFile(VSCODE_SETTINGS_PATH, "utf-8").catch(() => "{}"),
        readFile(VSCODE_EXTENSIONS_PATH, "utf-8").catch(() => "[]"),
        readFile(OPENCODE_AUTH_PATH, "utf-8").catch(() => "{}"),
        readFile(OPENCODE_CONFIG_PATH, "utf-8").catch(() => "{}"),
      ]);

    return {
      vscode: {
        settings: JSON.parse(vscodeSettings),
        extensions: JSON.parse(vscodeExtensions),
      },
      opencode: {
        auth: JSON.parse(opencodeAuth),
        config: JSON.parse(opencodeConfig),
      },
    };
  })
  .get("/config/discover", () => {
    return { configs: discoverConfigFiles() };
  })
  .get(
    "/config/read",
    async ({ query, set }) => {
      const path = query.path;
      if (!path) {
        set.status = 400;
        return { error: "path query parameter required" };
      }

      const normalizedPath = path.replace(/^~/, "/home/dev");

      if (
        !normalizedPath.startsWith("/home/dev/") &&
        !normalizedPath.startsWith("/etc/sandbox/")
      ) {
        set.status = 403;
        return {
          error: "Access denied - path must be under /home/dev or /etc/sandbox",
        };
      }

      try {
        const content = await readFile(normalizedPath, "utf-8");
        const stats = await stat(normalizedPath);

        let contentType: "json" | "text" = "text";
        if (normalizedPath.endsWith(".json")) {
          try {
            JSON.parse(content);
            contentType = "json";
          } catch {}
        }

        return {
          path: normalizedPath,
          displayPath: normalizedPath.replace("/home/dev", "~"),
          content,
          contentType,
          size: stats.size,
        };
      } catch (_error) {
        set.status = 404;
        return { error: "File not found or not readable" };
      }
    },
    {
      query: t.Object({
        path: t.String(),
      }),
    },
  )
  .get("/vscode/extensions/installed", async () => {
    try {
      const { stdout } = await exec(
        "code-server --list-extensions 2>/dev/null || true",
      );
      const extensions = stdout
        .trim()
        .split("\n")
        .filter((e) => e.length > 0);
      return { extensions };
    } catch {
      return { extensions: [] };
    }
  })
  .post(
    "/vscode/extensions/install",
    async ({ body }) => {
      try {
        const results: {
          extension: string;
          success: boolean;
          error?: string;
        }[] = [];
        for (const ext of body.extensions) {
          try {
            await exec(`code-server --install-extension ${ext}`, {
              timeout: 120000,
            });
            results.push({ extension: ext, success: true });
          } catch (error: unknown) {
            const err = error as { message?: string };
            results.push({
              extension: ext,
              success: false,
              error: err.message ?? "Unknown error",
            });
          }
        }
        return { results };
      } catch (error: unknown) {
        const err = error as { message?: string };
        return { error: err.message ?? "Failed to install extensions" };
      }
    },
    {
      body: t.Object({
        extensions: t.Array(t.String()),
      }),
    },
  )
  .listen(AGENT_PORT, () => {
    console.log(`Sandbox agent running at http://0.0.0.0:${AGENT_PORT}`);
  });

export type App = typeof app;
