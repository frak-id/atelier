/**
 * System type definitions
 */

export interface SystemStats {
  /** CPU usage percentage (0-100) */
  cpuUsage: number;
  /** Memory usage in bytes */
  memoryUsed: number;
  /** Total memory in bytes */
  memoryTotal: number;
  /** Memory usage percentage */
  memoryPercent: number;
  /** Disk usage in bytes */
  diskUsed: number;
  /** Total disk in bytes */
  diskTotal: number;
  /** Disk usage percentage */
  diskPercent: number;
  /** Number of active sandboxes */
  activeSandboxes: number;
  /** Maximum allowed sandboxes */
  maxSandboxes: number;
  /** System uptime in seconds */
  uptime: number;
}

export interface HealthStatus {
  status: "ok" | "degraded" | "error";
  uptime: number;
  timestamp: number;
  checks: {
    firecracker: "ok" | "error";
    network: "ok" | "error";
    caddy: "ok" | "error";
    storage: "ok" | "error";
    lvm: "ok" | "unavailable";
  };
}

export interface CleanupResult {
  /** Number of orphaned sockets cleaned */
  socketsRemoved: number;
  /** Number of orphaned overlays cleaned */
  overlaysRemoved: number;
  /** Number of stale TAP devices cleaned */
  tapDevicesRemoved: number;
  /** Total disk space freed in bytes */
  spaceFreed: number;
}
