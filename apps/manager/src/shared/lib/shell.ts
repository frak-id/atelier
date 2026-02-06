import { mkdir, stat } from "node:fs/promises";
import { PATHS, VM } from "@frak/atelier-shared/constants";
import { $ } from "bun";
import {
  getSocketPath,
  getVsockPath,
} from "../../infrastructure/firecracker/index.ts";

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

export async function ensureDirAsRoot(path: string): Promise<void> {
  await $`sudo -n mkdir -p ${path}`.quiet();
}

export async function writeFileAsRoot(
  path: string,
  content: string | Buffer,
): Promise<void> {
  const dir = path.substring(0, path.lastIndexOf("/"));
  await ensureDirAsRoot(dir);

  const base64 = Buffer.isBuffer(content)
    ? content.toString("base64")
    : Buffer.from(content).toString("base64");
  await $`echo ${base64} | base64 -d | sudo -n tee ${path} > /dev/null`.quiet();
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
    owner = VM.OWNER,
  } = options;

  const targetPath = path.replace(/^~/, VM.HOME);
  const fullPath = `${mountPoint}${targetPath}`;
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));

  await ensureDir(dir);
  await $`rm -f ${fullPath}`.quiet().nothrow();

  if (contentType === "binary" && typeof content === "string") {
    const buffer = Buffer.from(content, "base64");
    await Bun.write(fullPath, buffer);
  } else {
    await Bun.write(fullPath, content);
  }

  if (mode) {
    await $`chmod ${mode} ${fullPath}`.quiet();
  }

  await $`sudo -n chown ${owner} ${fullPath}`.quiet();
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
  const pidPath = `${PATHS.SOCKET_DIR}/${sandboxId}.pid`;
  const logPath = `${PATHS.LOG_DIR}/${sandboxId}.log`;
  await $`rm -f ${socketPath} ${vsockPath} ${pidPath} ${logPath}`
    .quiet()
    .nothrow();
}
