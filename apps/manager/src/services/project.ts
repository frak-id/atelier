import { nanoid } from "nanoid";
import type { Project, CreateProjectOptions, UpdateProjectOptions } from "@frak-sandbox/shared/types";
import { DEFAULT_BASE_IMAGE } from "@frak-sandbox/shared/types";
import { DEFAULTS } from "@frak-sandbox/shared/constants";
import { createChildLogger } from "../lib/logger.ts";
import { projectStore } from "../state/project-store.ts";
import { SecretsService } from "./secrets.ts";

const log = createChildLogger("project");

export const ProjectService = {
  async list(): Promise<Project[]> {
    return projectStore.getAll();
  },

  async getById(id: string): Promise<Project | null> {
    return projectStore.getById(id) ?? null;
  },

  async create(options: CreateProjectOptions): Promise<Project> {
    const projectId = nanoid(12);
    
    const project: Project = {
      id: projectId,
      name: options.name,
      gitUrl: options.gitUrl,
      defaultBranch: options.defaultBranch ?? "main",
      baseImage: options.baseImage ?? DEFAULT_BASE_IMAGE,
      vcpus: options.vcpus ?? DEFAULTS.VCPUS,
      memoryMb: options.memoryMb ?? DEFAULTS.MEMORY_MB,
      initCommands: options.initCommands ?? [],
      startCommands: options.startCommands ?? [],
      secrets: {},
      exposedPorts: options.exposedPorts ?? [],
      prebuildStatus: "none",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Encrypt secrets if provided
    if (options.secrets && Object.keys(options.secrets).length > 0) {
      project.secrets = await SecretsService.encryptSecrets(options.secrets);
    }

    projectStore.create(project);
    log.info({ projectId, name: project.name }, "Project created");
    
    return project;
  },

  async update(id: string, options: UpdateProjectOptions): Promise<Project> {
    const existing = projectStore.getById(id);
    if (!existing) {
      throw new Error(`Project '${id}' not found`);
    }

    const updates: Partial<Project> = {};
    
    if (options.name !== undefined) updates.name = options.name;
    if (options.gitUrl !== undefined) updates.gitUrl = options.gitUrl;
    if (options.defaultBranch !== undefined) updates.defaultBranch = options.defaultBranch;
    if (options.baseImage !== undefined) updates.baseImage = options.baseImage;
    if (options.vcpus !== undefined) updates.vcpus = options.vcpus;
    if (options.memoryMb !== undefined) updates.memoryMb = options.memoryMb;
    if (options.initCommands !== undefined) updates.initCommands = options.initCommands;
    if (options.startCommands !== undefined) updates.startCommands = options.startCommands;
    if (options.exposedPorts !== undefined) updates.exposedPorts = options.exposedPorts;
    
    // Handle secrets update
    if (options.secrets !== undefined) {
      updates.secrets = await SecretsService.encryptSecrets(options.secrets);
    }

    const updated = projectStore.update(id, updates);
    log.info({ projectId: id }, "Project updated");
    
    return updated;
  },

  async delete(id: string): Promise<void> {
    const project = projectStore.getById(id);
    if (!project) {
      throw new Error(`Project '${id}' not found`);
    }

    // TODO: Clean up prebuilds and sandboxes associated with this project
    
    projectStore.delete(id);
    log.info({ projectId: id }, "Project deleted");
  },

  async getDecryptedSecrets(id: string): Promise<Record<string, string>> {
    const project = projectStore.getById(id);
    if (!project) {
      throw new Error(`Project '${id}' not found`);
    }

    if (!project.secrets || Object.keys(project.secrets).length === 0) {
      return {};
    }

    return SecretsService.decryptSecrets(project.secrets);
  },

  async triggerPrebuild(id: string): Promise<void> {
    const project = projectStore.getById(id);
    if (!project) {
      throw new Error(`Project '${id}' not found`);
    }

    if (project.prebuildStatus === "building") {
      throw new Error(`Project '${id}' already has a prebuild in progress`);
    }

    projectStore.updatePrebuildStatus(id, "building");
    log.info({ projectId: id }, "Prebuild triggered");

    // TODO: Actually trigger the prebuild process
    // This will be implemented in the prebuild service
  },
};
