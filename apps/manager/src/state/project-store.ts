import type { PrebuildStatus, Project } from "@frak-sandbox/shared/types";
import { ProjectRepository } from "./database.ts";

export const projectStore = {
  getAll(): Project[] {
    return ProjectRepository.getAll();
  },

  getById(id: string): Project | undefined {
    return ProjectRepository.getById(id);
  },

  getByPrebuildStatus(status: PrebuildStatus): Project[] {
    return ProjectRepository.getByPrebuildStatus(status);
  },

  create(project: Project): Project {
    return ProjectRepository.create(project);
  },

  update(id: string, updates: Partial<Project>): Project {
    return ProjectRepository.update(id, updates);
  },

  updatePrebuildStatus(
    id: string,
    status: PrebuildStatus,
    prebuildId?: string,
  ): Project {
    return ProjectRepository.updatePrebuildStatus(id, status, prebuildId);
  },

  delete(id: string): boolean {
    return ProjectRepository.delete(id);
  },

  count(): number {
    return ProjectRepository.count();
  },
};
