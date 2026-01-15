import type { Project, PrebuildStatus } from "@frak-sandbox/shared/types";
import { createChildLogger } from "../lib/logger.ts";

const log = createChildLogger("project-store");

class ProjectStore {
  private projects = new Map<string, Project>();

  getAll(): Project[] {
    return Array.from(this.projects.values());
  }

  getById(id: string): Project | undefined {
    return this.projects.get(id);
  }

  getByPrebuildStatus(status: PrebuildStatus): Project[] {
    return this.getAll().filter((p) => p.prebuildStatus === status);
  }

  create(project: Project): Project {
    if (this.projects.has(project.id)) {
      throw new Error(`Project '${project.id}' already exists`);
    }
    this.projects.set(project.id, project);
    log.info({ projectId: project.id }, "Project created in store");
    return project;
  }

  update(id: string, updates: Partial<Project>): Project {
    const project = this.projects.get(id);
    if (!project) {
      throw new Error(`Project '${id}' not found`);
    }

    const updated: Project = {
      ...project,
      ...updates,
      id: project.id,
      createdAt: project.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.projects.set(id, updated);
    log.debug({ projectId: id, updates }, "Project updated");
    return updated;
  }

  updatePrebuildStatus(id: string, status: PrebuildStatus, prebuildId?: string): Project {
    return this.update(id, { 
      prebuildStatus: status,
      ...(prebuildId && { latestPrebuildId: prebuildId }),
    });
  }

  delete(id: string): boolean {
    const deleted = this.projects.delete(id);
    if (deleted) {
      log.info({ projectId: id }, "Project removed from store");
    }
    return deleted;
  }

  count(): number {
    return this.projects.size;
  }

  clear(): void {
    this.projects.clear();
    log.warn("Project store cleared");
  }
}

export const projectStore = new ProjectStore();
