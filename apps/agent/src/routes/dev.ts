import { LOG_DIR, WORKSPACE_DIR } from "../constants.ts";

interface DevProcess {
  pid: number;
  name: string;
  logFile: string;
  startedAt: string;
  port?: number;
  status: "running" | "stopped" | "error";
  exitCode?: number;
  process: Deno.ChildProcess;
}

const runningDevCommands = new Map<string, DevProcess>();

function isProcessRunning(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT");
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
    const fileInfo = await Deno.stat(logPath);
    if (!fileInfo.isFile) return { content: "", nextOffset: 0 };

    const content = await Deno.readTextFile(logPath);
    const chunk = content.slice(offset, offset + limit);
    const nextOffset = offset + chunk.length;

    return { content: chunk, nextOffset };
  } catch {
    return { content: "", nextOffset: 0 };
  }
}

export function handleGetDev(): Response {
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
  return Response.json({ commands });
}

export async function handleDevStart(
  name: string,
  request: Request,
): Promise<Response> {
  const { command, workdir, env, port } = await request.json();

  const existing = runningDevCommands.get(name);
  if (existing && existing.status === "running") {
    if (isProcessRunning(existing.pid)) {
      return Response.json(
        {
          error: "Conflict",
          message: `Dev command '${name}' is already running with PID ${existing.pid}`,
        },
        { status: 409 },
      );
    }
    existing.status = "error";
  }

  const logFile = `${LOG_DIR}/dev-${name}.log`;
  const logHandle = await Deno.open(logFile, {
    write: true,
    create: true,
    append: true,
  });

  const cmd = new Deno.Command("/bin/sh", {
    args: ["-c", command],
    cwd: workdir || WORKSPACE_DIR,
    env: { ...Deno.env.toObject(), ...env },
    stdout: "piped",
    stderr: "piped",
  });

  const child = cmd.spawn();
  const pid = child.pid;

  const pumpStream = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await logHandle.write(value);
      }
    } catch {
      //
    }
  };

  const stdoutDone = pumpStream(child.stdout);
  const stderrDone = pumpStream(child.stderr);

  const devProc: DevProcess = {
    pid,
    name,
    logFile,
    startedAt: new Date().toISOString(),
    port,
    status: "running",
    process: child,
  };

  child.status.then((status: Deno.CommandStatus) => {
    const storedProc = runningDevCommands.get(name);
    if (storedProc && storedProc.pid === pid) {
      storedProc.status = status.code === 0 ? "stopped" : "error";
      storedProc.exitCode = status.code;
    }
    Promise.all([stdoutDone, stderrDone]).then(() => {
      try {
        logHandle.close();
      } catch {
        //
      }
    });
  });

  runningDevCommands.set(name, devProc);

  return Response.json({
    status: "running",
    pid,
    name,
    port,
    logFile,
    startedAt: devProc.startedAt,
  });
}

export async function handleDevStop(name: string): Promise<Response> {
  const devProc = runningDevCommands.get(name);

  if (!devProc) {
    return Response.json({
      status: "stopped",
      name,
      message: "Command not found or already stopped",
    });
  }

  if (devProc.status !== "running" || !isProcessRunning(devProc.pid)) {
    devProc.status = devProc.exitCode === 0 ? "stopped" : "error";
    return Response.json({
      status: devProc.status,
      name,
      exitCode: devProc.exitCode,
      message: "Command already stopped",
    });
  }

  try {
    devProc.process.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (isProcessRunning(devProc.pid)) {
      devProc.process.kill("SIGKILL");
    }

    devProc.status = "stopped";
    devProc.exitCode = devProc.exitCode ?? -1;

    return Response.json({
      status: "stopped",
      name,
      pid: devProc.pid,
      message: "Command stopped",
    });
  } catch (err) {
    devProc.status = "error";
    return Response.json({
      status: "error",
      name,
      message: `Failed to stop: ${err instanceof Error ? err.message : "Unknown error"}`,
    });
  }
}

export async function handleDevLogs(name: string, url: URL): Promise<Response> {
  const offsetParam = url.searchParams.get("offset");
  const limitParam = url.searchParams.get("limit");
  const offset = offsetParam ? parseInt(offsetParam, 10) : 0;
  const limit = limitParam ? parseInt(limitParam, 10) : 10000;

  const { content, nextOffset } = await getDevLogs(name, offset, limit);
  return Response.json({ name, content, nextOffset });
}
