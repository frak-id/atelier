/**
 * Routes an agent's permission prompt to the integrations the sandbox
 * OWNER connected (an org member driving the owner's sandbox pings the
 * owner — accepted, documented). Structurally implements sessions/'s
 * `PermissionNotifier`; integrations/ never imports sessions/, the
 * composition root (api/container.ts) joins them.
 *
 * Dispatch does not abort the prompt's `signal` when an integration answers
 * (it only does when the prompt settles elsewhere: console, closed
 * connection), so the hub tracks "settled" itself: the first valid answer
 * calls `answer` and aborts every integration's signal; later answers and
 * option ids the agent did not offer are ignored.
 */
import {
  PERMISSION_RISKS,
  type PermissionConnection,
  permissionPresentation,
} from "@frak/atelier-shared";
import type { createChildLogger } from "../shared/lib/logger.ts";
import type {
  Integration,
  PermissionContext,
  PermissionRequest,
} from "./integration.ts";
import type { IntegrationRegistry } from "./registry.ts";

/** One ACP `session/request_permission`, as dispatch hands it over. */
export interface HubPrompt {
  sandboxId: string;
  sessionId: string;
  requestId: string;
  title: string;
  kind?: string;
  options: PermissionRequest["options"];
}

export interface HubDeps {
  registry: Pick<IntegrationRegistry, "enabled" | "serverSettings">;
  /** The sandbox's owner user id; undefined for an unowned/unknown one. */
  ownerOf(sandboxId: string): string | undefined;
  /** The sandbox's display name, else its id. */
  sandboxName(sandboxId: string): string;
  /** The user's enabled connections, credentials decrypted. */
  connectionsOf(userId: string): Promise<PermissionConnection[]>;
  /** Rejects when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log: ReturnType<typeof createChildLogger>;
}

export class IntegrationHub {
  constructor(private readonly deps: HubDeps) {}

  /**
   * Never rejects: the prompt stays pending for the console on any failure.
   * Resolves once every integration is done (dispatch ignores it; tests
   * await it).
   */
  notify(
    prompt: HubPrompt,
    answer: (optionId: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return this.fanOut(prompt, answer, signal).catch((err) => {
      this.deps.log.warn({ err, sandboxId: prompt.sandboxId }, "notify failed");
    });
  }

  private async fanOut(
    prompt: HubPrompt,
    answer: (optionId: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const { deps } = this;
    const listeners = deps.registry
      .enabled()
      .filter((integration) => integration.onPermission);
    const ownerId = deps.ownerOf(prompt.sandboxId);
    if (listeners.length === 0 || !ownerId || signal.aborted) return;
    const connections = await deps.connectionsOf(ownerId);
    if (signal.aborted) return;

    const { risk } = permissionPresentation(prompt.title, prompt.kind);
    const request: PermissionRequest = {
      requestId: prompt.requestId,
      sandboxId: prompt.sandboxId,
      sandboxName: deps.sandboxName(prompt.sandboxId),
      title: prompt.title,
      kind: prompt.kind,
      risk,
      options: prompt.options,
    };

    // One child signal for every integration: the parent's abort or the
    // first answer ends them all.
    const children = new AbortController();
    const abortChildren = () => children.abort();
    signal.addEventListener("abort", abortChildren, { once: true });
    const offered = new Set(prompt.options.map((o) => o.optionId));
    const settle = (optionId: string) => {
      if (children.signal.aborted || !offered.has(optionId)) return;
      children.abort();
      answer(optionId);
    };

    const runs: Promise<void>[] = [];
    for (const integration of listeners) {
      const { id } = integration.manifest;
      const connection = connections.find((c) => c.integrationId === id);
      if (
        !connection ||
        PERMISSION_RISKS.indexOf(risk) <
          PERMISSION_RISKS.indexOf(connection.minRisk)
      ) {
        continue;
      }
      runs.push(
        this.run(integration, connection, {
          request,
          signal: children.signal,
          settle,
        }),
      );
    }
    await Promise.all(runs);
    signal.removeEventListener("abort", abortChildren);
  }

  private async run(
    integration: Integration,
    connection: { credential?: string; delaySeconds: number },
    call: {
      request: PermissionRequest;
      signal: AbortSignal;
      settle: (optionId: string) => void;
    },
  ): Promise<void> {
    const { id } = integration.manifest;
    const log = this.deps.log.child({ integration: id });
    try {
      // Ask elsewhere only if nobody answered by then.
      if (connection.delaySeconds > 0) {
        await this.deps.sleep(connection.delaySeconds * 1000, call.signal);
      }
      if (call.signal.aborted) return;
      const ctx: PermissionContext = {
        answer: call.settle,
        signal: call.signal,
        serverSettings: this.deps.registry.serverSettings(id),
        connection: {
          credential: connection.credential,
        },
        log,
      };
      await integration.onPermission?.(call.request, ctx);
    } catch (err) {
      // An abort during the delay or the call is the normal end.
      if (!call.signal.aborted) {
        log.warn(
          { err, sandboxId: call.request.sandboxId },
          "onPermission failed",
        );
      }
    }
  }
}
