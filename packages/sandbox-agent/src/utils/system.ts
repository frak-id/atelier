import { readFileSync } from "node:fs";
import type { ResourceUsage } from "../types";
import { execSync } from "./exec";

export function getCpuUsage(): number {
  try {
    const loadavg = readFileSync("/proc/loadavg", "utf-8");
    const [load1] = loadavg.split(" ");
    return parseFloat(load1 || "0");
  } catch {
    return 0;
  }
}

export function getMemoryUsage(): ResourceUsage {
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

export function getDiskUsage(): ResourceUsage {
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
