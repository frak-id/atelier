import type { Sandbox, SandboxStatus } from "@frak-sandbox/shared/types";
import { createChildLogger } from "../lib/logger.ts";

const log = createChildLogger("store");

class SandboxStore {
  private sandboxes = new Map<string, Sandbox>();

  getAll(): Sandbox[] {
    return Array.from(this.sandboxes.values());
  }

  getById(id: string): Sandbox | undefined {
    return this.sandboxes.get(id);
  }

  getByStatus(status: SandboxStatus): Sandbox[] {
    return this.getAll().filter((s) => s.status === status);
  }

  getByProjectId(projectId: string): Sandbox[] {
    return this.getAll().filter((s) => s.projectId === projectId);
  }

  create(sandbox: Sandbox): Sandbox {
    if (this.sandboxes.has(sandbox.id)) {
      throw new Error(`Sandbox '${sandbox.id}' already exists`);
    }
    this.sandboxes.set(sandbox.id, sandbox);
    log.info({ sandboxId: sandbox.id }, "Sandbox created in store");
    return sandbox;
  }

  update(id: string, updates: Partial<Sandbox>): Sandbox {
    const sandbox = this.sandboxes.get(id);
    if (!sandbox) {
      throw new Error(`Sandbox '${id}' not found`);
    }

    const updated: Sandbox = {
      ...sandbox,
      ...updates,
      id: sandbox.id,
      createdAt: sandbox.createdAt,
      updatedAt: new Date().toISOString(),
    };

    this.sandboxes.set(id, updated);
    log.debug({ sandboxId: id, updates }, "Sandbox updated");
    return updated;
  }

  updateStatus(id: string, status: SandboxStatus, error?: string): Sandbox {
    return this.update(id, { status, error });
  }

  delete(id: string): boolean {
    const deleted = this.sandboxes.delete(id);
    if (deleted) {
      log.info({ sandboxId: id }, "Sandbox removed from store");
    }
    return deleted;
  }

  count(): number {
    return this.sandboxes.size;
  }

  countByStatus(status: SandboxStatus): number {
    return this.getByStatus(status).length;
  }

  clear(): void {
    this.sandboxes.clear();
    log.warn("Store cleared");
  }
}

export const sandboxStore = new SandboxStore();
