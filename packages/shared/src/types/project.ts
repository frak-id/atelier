import type { BaseImageId } from "./image.ts";

export type PrebuildStatus = "none" | "building" | "ready" | "failed";

export interface Project {
  id: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  baseImage: BaseImageId;
  vcpus: number;
  memoryMb: number;
  initCommands: string[];
  startCommands: string[];
  secrets: Record<string, string>;
  exposedPorts: number[];
  latestPrebuildId?: string;
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
