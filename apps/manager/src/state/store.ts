import type { Sandbox, SandboxStatus } from "../schemas/index.ts";
import { SandboxRepository } from "./database.ts";

export const sandboxStore = {
  getAll(): Sandbox[] {
    return SandboxRepository.getAll();
  },

  getById(id: string): Sandbox | undefined {
    return SandboxRepository.getById(id);
  },

  getByStatus(status: SandboxStatus): Sandbox[] {
    return SandboxRepository.getByStatus(status);
  },

  getByWorkspaceId(workspaceId: string): Sandbox[] {
    return SandboxRepository.getByWorkspaceId(workspaceId);
  },

  create(sandbox: Sandbox): Sandbox {
    return SandboxRepository.create(sandbox);
  },

  update(id: string, updates: Partial<Sandbox>): Sandbox {
    return SandboxRepository.update(id, updates);
  },

  updateStatus(id: string, status: SandboxStatus, error?: string): Sandbox {
    return SandboxRepository.updateStatus(id, status, error);
  },

  delete(id: string): boolean {
    return SandboxRepository.delete(id);
  },

  count(): number {
    return SandboxRepository.count();
  },

  countByStatus(status: SandboxStatus): number {
    return SandboxRepository.countByStatus(status);
  },
};
