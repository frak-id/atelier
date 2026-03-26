import { eventBus } from "../infrastructure/events/index.ts";
import { kubeClient } from "../infrastructure/kubernetes/index.ts";
import type { Sandbox } from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { SandboxPorts } from "./ports/sandbox-ports.ts";
import {
  restartSystemSandbox,
  restartWorkspaceSandbox,
} from "./workflows/index.ts";

const log = createChildLogger("sandbox-lifecycle");

export class SandboxLifecycle {
  constructor(private readonly ports: SandboxPorts) {}

  async stop(sandboxId: string): Promise<Sandbox> {
    const sandbox = this.ports.sandbox.getById(sandboxId);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", sandboxId);
    }

    if (sandbox.status !== "running") {
      throw new Error(
        `Sandbox '${sandboxId}' is not running (status: ${sandbox.status})`,
      );
    }

    log.info({ sandboxId }, "Stopping sandbox");

    if (!isMock()) {
      const podName = `sandbox-${sandboxId}`;
      try {
        await kubeClient.deleteResource("Pod", podName);
      } catch (err) {
        log.warn({ sandboxId, err }, "Failed to delete pod during stop");
      }
    }

    this.ports.sandbox.updateStatus(sandboxId, "stopped");
    eventBus.emit({
      type: "sandbox.updated",
      properties: { id: sandboxId, status: "stopped" },
    });
    log.info({ sandboxId }, "Sandbox stopped");

    const updated = this.ports.sandbox.getById(sandboxId);
    if (!updated) {
      throw new Error(`Sandbox not found after stop: ${sandboxId}`);
    }
    return updated;
  }

  async recover(sandboxId: string): Promise<Sandbox> {
    const sandbox = this.ports.sandbox.getById(sandboxId);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", sandboxId);
    }

    if (sandbox.status !== "error") {
      throw new Error(
        `Sandbox '${sandboxId}' is not in error state (status: ${sandbox.status})`,
      );
    }

    log.info({ sandboxId }, "Recovering sandbox from error state");

    if (!isMock()) {
      await kubeClient.deleteLabeledResources(
        `atelier.dev/sandbox=${sandboxId}`,
      );
    }

    this.ports.sandbox.updateStatus(sandboxId, "stopped");
    eventBus.emit({
      type: "sandbox.updated",
      properties: { id: sandboxId, status: "stopped" },
    });
    log.info({ sandboxId }, "Stale resources cleaned up, restarting");

    return this.start(sandboxId);
  }

  async start(sandboxId: string): Promise<Sandbox> {
    const sandbox = this.ports.sandbox.getById(sandboxId);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", sandboxId);
    }

    if (sandbox.status !== "stopped") {
      throw new Error(
        `Sandbox '${sandboxId}' is not stopped (status: ${sandbox.status})`,
      );
    }

    log.info({ sandboxId }, "Starting sandbox");

    if (isMock()) {
      this.ports.sandbox.updateStatus(sandboxId, "running");
      eventBus.emit({
        type: "sandbox.updated",
        properties: { id: sandboxId, status: "running" },
      });
      const updated = this.ports.sandbox.getById(sandboxId);
      if (!updated) {
        throw new Error(`Sandbox not found after start: ${sandboxId}`);
      }
      return updated;
    }

    // Dispatch to the appropriate restart workflow
    const workspace = sandbox.workspaceId
      ? this.ports.workspaces.getById(sandbox.workspaceId)
      : undefined;

    if (workspace) {
      return restartWorkspaceSandbox(
        sandboxId,
        sandbox,
        workspace,
        this.ports,
        sandbox.createdBy,
      );
    }

    return restartSystemSandbox(sandboxId, sandbox, this.ports);
  }

  async getStatus(sandboxId: string): Promise<Sandbox | undefined> {
    const sandbox = this.ports.sandbox.getById(sandboxId);
    if (!sandbox) {
      return undefined;
    }
    if (isMock() || sandbox.status === "stopped") {
      return sandbox;
    }

    // Check pod status via K8s API
    const podName = `sandbox-${sandboxId}`;

    try {
      const phase = await kubeClient.getPodStatus(podName);

      if (phase === "Running") {
        if (sandbox.status !== "running") {
          this.ports.sandbox.updateStatus(sandboxId, "running");
        }
        // Clear stale runtime error if pod is healthy
        if (sandbox.runtime.error) {
          this.clearRuntimeError(sandboxId, sandbox);
        }
      } else if (phase === "Failed" || phase === "Unknown") {
        if (sandbox.status === "running") {
          log.warn({ sandboxId, phase }, "Pod not running, marking as error");
          this.ports.sandbox.updateStatus(
            sandboxId,
            "error",
            `Pod phase: ${phase}`,
          );
        }
      }
      // "Pending" → leave status as-is (might be starting up)
    } catch (err) {
      // Pod might not exist (404) — mark as error if was running
      if (sandbox.status === "running") {
        log.warn({ sandboxId, err }, "Pod not found, marking as error");
        this.ports.sandbox.updateStatus(sandboxId, "error", "Pod not found");
      }
    }

    return this.ports.sandbox.getById(sandboxId) ?? sandbox;
  }

  private clearRuntimeError(sandboxId: string, sandbox?: Sandbox): void {
    const current = sandbox ?? this.ports.sandbox.getById(sandboxId);
    if (!current?.runtime.error) return;
    const { error: _removed, ...cleanRuntime } = current.runtime;
    this.ports.sandbox.update(sandboxId, {
      runtime: cleanRuntime,
    });
    log.info({ sandboxId }, "Cleared stale runtime error");
  }
}
