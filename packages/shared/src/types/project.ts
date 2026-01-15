/**
 * Project type definitions
 */

import type { BaseImageId } from "./image.ts";

export type PrebuildStatus = "none" | "building" | "ready" | "failed";

export interface Project {
  id: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;

  /** Base image to use for sandboxes */
  baseImage: BaseImageId;

  /** Default vCPU count for sandboxes */
  vcpus: number;

  /** Default memory in MB for sandboxes */
  memoryMb: number;

  /** Commands to run once during prebuild (e.g., npm install, build) */
  initCommands: string[];

  /** Commands to run on every sandbox start (e.g., start dev server) */
  startCommands: string[];

  /** Secret environment variables (encrypted at rest) */
  secrets: Record<string, string>;

  /** Ports to expose via Caddy (besides default 8080, 3000) */
  exposedPorts: number[];

  /** Latest prebuild volume ID */
  latestPrebuildId?: string;

  /** Current prebuild status */
  prebuildStatus: PrebuildStatus;

  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectOptions {
  name: string;
  gitUrl: string;
  defaultBranch?: string;
  baseImage?: BaseImageId;
  vcpus?: number;
  memoryMb?: number;
  initCommands?: string[];
  startCommands?: string[];
  secrets?: Record<string, string>;
  exposedPorts?: number[];
}

export interface UpdateProjectOptions {
  name?: string;
  gitUrl?: string;
  defaultBranch?: string;
  baseImage?: BaseImageId;
  vcpus?: number;
  memoryMb?: number;
  initCommands?: string[];
  startCommands?: string[];
  secrets?: Record<string, string>;
  exposedPorts?: number[];
}

export interface ProjectListFilters {
  prebuildStatus?: PrebuildStatus;
}
