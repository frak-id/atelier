import { mkdir, stat } from "node:fs/promises";
import { $ } from "bun";
import {
  getSocketPath,
  getVsockPath,
} from "../../infrastructure/firecracker/index.ts";
import { config } from "./config.ts";

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

interface InjectFileOptions {
  mountPoint: string;
  path: string;
  content: string | Buffer;
  contentType?: "text" | "binary";
  mode?: string;
  owner?: string;
}

export async function injectFile(options: InjectFileOptions): Promise<void> {
  const {
    mountPoint,
    path,
    content,
    contentType = "text",
    mode,
    owner = "1000:1000",
  } = options;

  const targetPath = path.replace(/^~/, "/home/dev");
  const fullPath = `${mountPoint}${targetPath}`;
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));

  await ensureDir(dir);

  if (contentType === "binary" && typeof content === "string") {
    const buffer = Buffer.from(content, "base64");
    await Bun.write(fullPath, buffer);
  } else {
    await Bun.write(fullPath, content);
  }

  if (mode) {
    await $`chmod ${mode} ${fullPath}`.quiet();
  }

  await $`chown ${owner} ${fullPath}`.quiet();
}

export async function killProcess(
  pid: number,
  gracePeriodMs = 500,
): Promise<void> {
  await $`kill ${pid} 2>/dev/null || true`.quiet().nothrow();
  await Bun.sleep(gracePeriodMs);
  await $`kill -9 ${pid} 2>/dev/null || true`.quiet().nothrow();
}

export async function cleanupSandboxFiles(sandboxId: string): Promise<void> {
  const socketPath = getSocketPath(sandboxId);
  const vsockPath = getVsockPath(sandboxId);
  const pidPath = `${config.paths.SOCKET_DIR}/${sandboxId}.pid`;
  const logPath = `${config.paths.LOG_DIR}/${sandboxId}.log`;
  await $`rm -f ${socketPath} ${vsockPath} ${pidPath} ${logPath}`
    .quiet()
    .nothrow();
}
