import type { Sandbox } from "../../schemas/index.ts";
import type { SandboxRepository } from "./sandbox.repository.ts";

export class SandboxService {
  constructor(private readonly sandboxRepository: SandboxRepository) {}

  getAll(): Sandbox[] {
    return this.sandboxRepository.getAll();
  }

  getById(id: string): Sandbox | undefined {
    return this.sandboxRepository.getById(id);
  }

  getByStatus(status: "creating" | "running" | "stopped" | "error"): Sandbox[] {
    return this.sandboxRepository.getByStatus(status);
  }

  getByWorkspaceId(workspaceId: string): Sandbox[] {
    return this.sandboxRepository.getByWorkspaceId(workspaceId);
  }

  create(sandbox: Sandbox): void {
    this.sandboxRepository.create(sandbox);
  }

  update(id: string, sandbox: Sandbox): void {
    this.sandboxRepository.update(id, sandbox);
  }

  updateStatus(
    id: string,
    status: "creating" | "running" | "stopped" | "error",
    errorMessage?: string,
  ): void {
    this.sandboxRepository.updateStatus(id, status, errorMessage);
  }

  delete(id: string): void {
    this.sandboxRepository.delete(id);
  }

  count(): number {
    return this.sandboxRepository.count();
  }

  countByStatus(status: "creating" | "running" | "stopped" | "error"): number {
    return this.sandboxRepository.countByStatus(status);
  }
}
