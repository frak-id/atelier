import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Elysia, t } from "elysia";
import { LOG_DIR, WORKSPACE_DIR } from "../constants";

interface DevProcess {
  pid: number;
  name: string;
  logFile: string;
  startedAt: string;
  port?: number;
  status: "running" | "stopped" | "error";
  exitCode?: number;
  process: ChildProcess;
  logStream: WriteStream;
}

const runningDevCommands = new Map<string, DevProcess>();

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function getDevLogs(
  name: string,
  offset = 0,
  limit = 10000,
): Promise<{ content: string; nextOffset: number }> {
  const logPath = `${LOG_DIR}/dev-${name}.log`;
  try {
    const fileInfo = await stat(logPath);
    if (!fileInfo.isFile()) return { content: "", nextOffset: 0 };

    const content = await readFile(logPath, "utf-8");
    const chunk = content.slice(offset, offset + limit);
    const nextOffset = offset + chunk.length;

    return { content: chunk, nextOffset };
  } catch {
    return { content: "", nextOffset: 0 };
  }
}

const StartDevCommandSchema = t.Object({
  command: t.String(),
  workdir: t.Optional(t.String()),
  env: t.Optional(t.Record(t.String(), t.String())),
  port: t.Optional(t.Number({ minimum: 1, maximum: 65535 })),
});

export const devRoutes = new Elysia({ prefix: "/dev" })
  .get("/", () => {
    const commands = Array.from(runningDevCommands.values()).map((proc) => {
      if (proc.status === "running" && !isProcessRunning(proc.pid)) {
        proc.status = "error";
      }
      return {
        name: proc.name,
        status: proc.status,
        pid: proc.pid,
        port: proc.port,
        startedAt: proc.startedAt,
        exitCode: proc.exitCode,
        logFile: proc.logFile,
      };
    });
    return { commands };
  })
  .post(
    "/:name/start",
    async ({ params, body, set }) => {
      const { name } = params;
      const { command, workdir, env, port } = body;

      const existing = runningDevCommands.get(name);
      if (existing && existing.status === "running") {
        if (isProcessRunning(existing.pid)) {
          set.status = 409;
          return {
            error: "Conflict",
            message: `Dev command '${name}' is already running with PID ${existing.pid}`,
          };
        }
        existing.status = "error";
      }

      const logFile = `${LOG_DIR}/dev-${name}.log`;
      const logStream = createWriteStream(logFile, { flags: "a" });

      const proc = spawn("/bin/sh", ["-c", command], {
        cwd: workdir || WORKSPACE_DIR,
        env: { ...process.env, ...env },
        detached: false,
      });

      if (!proc.pid) {
        logStream.end();
        set.status = 500;
        return { error: "Failed to spawn process" };
      }

      proc.stdout?.pipe(logStream);
      proc.stderr?.pipe(logStream);

      const devProc: DevProcess = {
        pid: proc.pid,
        name,
        logFile,
        startedAt: new Date().toISOString(),
        port,
        status: "running",
        process: proc,
        logStream,
      };

      proc.on("exit", (code) => {
        const storedProc = runningDevCommands.get(name);
        if (storedProc && storedProc.pid === proc.pid) {
          storedProc.status = code === 0 ? "stopped" : "error";
          storedProc.exitCode = code ?? undefined;
        }
        logStream.end();
      });

      proc.on("error", (err) => {
        const storedProc = runningDevCommands.get(name);
        if (storedProc && storedProc.pid === proc.pid) {
          storedProc.status = "error";
        }
        logStream.write(`Process error: ${err.message}\n`);
        logStream.end();
      });

      runningDevCommands.set(name, devProc);

      return {
        status: "running",
        pid: proc.pid,
        name,
        port,
        logFile,
        startedAt: devProc.startedAt,
      };
    },
    {
      body: StartDevCommandSchema,
    },
  )
  .post("/:name/stop", async ({ params }) => {
    const { name } = params;
    const devProc = runningDevCommands.get(name);

    if (!devProc) {
      return {
        status: "stopped",
        name,
        message: "Command not found or already stopped",
      };
    }

    if (devProc.status !== "running" || !isProcessRunning(devProc.pid)) {
      devProc.status = devProc.exitCode === 0 ? "stopped" : "error";
      return {
        status: devProc.status,
        name,
        exitCode: devProc.exitCode,
        message: "Command already stopped",
      };
    }

    try {
      devProc.process.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (isProcessRunning(devProc.pid)) {
        devProc.process.kill("SIGKILL");
      }

      devProc.status = "stopped";
      devProc.exitCode = devProc.exitCode ?? -1;

      return {
        status: "stopped",
        name,
        pid: devProc.pid,
        message: "Command stopped",
      };
    } catch (err) {
      devProc.status = "error";
      return {
        status: "error",
        name,
        message: `Failed to stop: ${err instanceof Error ? err.message : "Unknown error"}`,
      };
    }
  })
  .get(
    "/:name/logs",
    async ({ params, query }) => {
      const { name } = params;
      const offset = query.offset ? parseInt(query.offset, 10) : 0;
      const limit = query.limit ? parseInt(query.limit, 10) : 10000;

      const { content, nextOffset } = await getDevLogs(name, offset, limit);
      return { name, content, nextOffset };
    },
    {
      query: t.Object({
        offset: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  );
