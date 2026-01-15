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
  /** Overall health status */
  status: "ok" | "degraded" | "error";
  /** Server uptime in seconds */
  uptime: number;
  /** Current timestamp */
  timestamp: number;
  /** Individual component checks */
  checks: {
    /** Firecracker availability */
    firecracker: "ok" | "error";
    /** Network bridge status */
    network: "ok" | "error";
    /** Caddy proxy status */
    caddy: "ok" | "error";
    /** Storage availability */
    storage: "ok" | "error";
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
