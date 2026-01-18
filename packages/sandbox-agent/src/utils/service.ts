import { readFile, stat } from "node:fs/promises";
import { LOG_DIR } from "../constants";
import type { ServiceStatus } from "../types";
import { exec } from "./exec";

export async function checkPort(port: number): Promise<boolean> {
  try {
    const { stdout } = await exec(
      `ss -tlnp 'sport = :${port}' 2>/dev/null | grep -q LISTEN && echo yes || echo no`,
    );
    return stdout.trim() === "yes";
  } catch {
    return false;
  }
}

export async function getServiceStatus(
  service: string,
): Promise<ServiceStatus> {
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

export async function getServiceLogs(
  service: string,
  lines = 100,
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
