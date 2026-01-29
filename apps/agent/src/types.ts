import type { DiscoverableConfigCategory } from "./constants.ts";

export interface AppPort {
  port: number;
  name: string;
  registeredAt: string;
}

export interface DiscoveredConfig {
  path: string;
  displayPath: string;
  category: DiscoverableConfigCategory | "other";
  exists: boolean;
  size?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
