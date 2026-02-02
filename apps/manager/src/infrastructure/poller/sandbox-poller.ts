import { createChildLogger } from "../../shared/lib/logger.ts";
import type { AgentOperations } from "../agent/agent.operations.ts";
import { eventBus } from "../events/event-bus.ts";
import { internalBus } from "../events/internal-bus.ts";

interface SandboxInfo {
  id: string;
  workspaceId?: string;
  status: string;
}

interface PollerDeps {
  agentOperations: AgentOperations;
  getSandboxes: () => SandboxInfo[];
  getWorkspaceRepos: (workspaceId: string) => { clonePath: string }[];
}

const POLL_INTERVAL_MS = 10_000;
const OPTIMISTIC_DELAY_MS = 2_000;

class SandboxPollerService {
  private log = createChildLogger("sandbox-poller");
  private timer: Timer | null = null;
  private servicesHashes = new Map<string, number>();
  private gitHashes = new Map<string, number>();
  private deps: PollerDeps | null = null;

  start(deps: PollerDeps): void {
    this.deps = deps;
    this.timer = setInterval(() => this.pollAll(), POLL_INTERVAL_MS);

    // Optimistic poll triggers from route handlers
    internalBus
      .on("sandbox.poll-services", (sandboxId) => {
        this.scheduleOptimisticPoll(sandboxId, "services");
      })
      .on("sandbox.poll-git", (sandboxId) => {
        this.scheduleOptimisticPoll(sandboxId, "git");
      })
      .on("sandbox.poll-all", (sandboxId) => {
        this.scheduleOptimisticPoll(sandboxId, "all");
      });

    // React to sandbox lifecycle events
    eventBus.subscribe((event) => {
      switch (event.type) {
        case "sandbox.created":
          // New sandbox — schedule initial poll after boot
          this.scheduleOptimisticPoll(event.properties.id, "all");
          break;
        case "sandbox.updated":
          // Status change (e.g. running → stopped)
          if (event.properties.status !== "running") {
            this.cleanupSandbox(event.properties.id);
          }
          break;
        case "sandbox.deleted":
          this.cleanupSandbox(event.properties.id);
          break;
      }
    });

    this.log.info("Sandbox poller started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.servicesHashes.clear();
    this.gitHashes.clear();
    this.log.info("Sandbox poller stopped");
  }

  private cleanupSandbox(sandboxId: string): void {
    this.servicesHashes.delete(sandboxId);
    this.gitHashes.delete(sandboxId);
  }

  private scheduleOptimisticPoll(
    sandboxId: string,
    scope: "services" | "git" | "all",
  ): void {
    setTimeout(() => this.pollSandbox(sandboxId, scope), OPTIMISTIC_DELAY_MS);
  }

  private async pollAll(): Promise<void> {
    if (!this.deps) return;
    const sandboxes = this.deps
      .getSandboxes()
      .filter((s) => s.status === "running");

    // Clean up hashes for sandboxes no longer running
    for (const id of this.servicesHashes.keys()) {
      if (!sandboxes.find((s) => s.id === id)) {
        this.cleanupSandbox(id);
      }
    }

    await Promise.allSettled(
      sandboxes.map((s) => this.pollSandbox(s.id, "all")),
    );
  }

  private async pollSandbox(
    sandboxId: string,
    scope: "services" | "git" | "all",
  ): Promise<void> {
    if (!this.deps) return;

    const promises: Promise<void>[] = [];
    if (scope === "services" || scope === "all") {
      promises.push(this.pollServices(sandboxId));
    }
    if (scope === "git" || scope === "all") {
      promises.push(this.pollGit(sandboxId));
    }
    await Promise.allSettled(promises);
  }

  private async pollServices(sandboxId: string): Promise<void> {
    if (!this.deps) return;
    try {
      const result = await this.deps.agentOperations.services(sandboxId);
      const hash = Number(Bun.hash(JSON.stringify(result)));
      const prev = this.servicesHashes.get(sandboxId);

      if (prev !== undefined && prev !== hash) {
        eventBus.emit({
          type: "sandbox.services.changed",
          properties: { id: sandboxId },
        });
      }
      this.servicesHashes.set(sandboxId, hash);
    } catch (error) {
      this.log.debug({ sandboxId, error }, "Failed to poll services");
    }
  }

  private async pollGit(sandboxId: string): Promise<void> {
    if (!this.deps) return;
    try {
      const sandbox = this.deps.getSandboxes().find((s) => s.id === sandboxId);
      if (!sandbox?.workspaceId) return;

      const repos = this.deps.getWorkspaceRepos(sandbox.workspaceId);
      if (repos.length === 0) return;

      const result = await this.deps.agentOperations.gitStatus(
        sandboxId,
        repos,
      );
      const hash = Number(Bun.hash(JSON.stringify(result)));
      const prev = this.gitHashes.get(sandboxId);

      if (prev !== undefined && prev !== hash) {
        eventBus.emit({
          type: "sandbox.git.changed",
          properties: { id: sandboxId },
        });
      }
      this.gitHashes.set(sandboxId, hash);
    } catch (error) {
      this.log.debug({ sandboxId, error }, "Failed to poll git status");
    }
  }
}

export const sandboxPoller = new SandboxPollerService();
