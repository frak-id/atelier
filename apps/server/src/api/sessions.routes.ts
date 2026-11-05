/**
 * `/sessions/*` — the agent app-tier HTTP surface (design.md §3.1 api/
 * table: "/sessions/* → sessions"). Thin Elysia binding over
 * `SessionService`/`TerminalService`; all mechanism lives in `sessions/`.
 * Agent sessions are read-only here (plus abort/delete): sandbox agents
 * auto-approve, so there is nothing to answer.
 */

import { repoCloneName, SANDBOX_NAME_ANNOTATION } from "@atelier/spec";
import { Elysia, sse, t } from "elysia";
import { VM } from "../config/constants.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import type { ServerContainer } from "./container.ts";
import {
  accessibleSandboxes,
  requireSandboxAccess,
  sandboxAccessGuard,
} from "./sandbox-guard.ts";
import {
  closeUpstream,
  isUserInput,
  openUpstreamRelay,
  relayMessage,
} from "./ws-relay.ts";

const log = createChildLogger("sessions-routes");

export function createSessionsRoutes(container: ServerContainer) {
  const { sessions, terminal, control } = container;
  const authPlugin = createAuthPlugin(control);
  // Both routers address `:id` as a sandbox id: the one access guard
  // (control/sandbox-access.ts) covers every agent and terminal route.
  const accessGuard = sandboxAccessGuard(container, "/sessions/sandboxes/");

  const agentRoutes = new Elysia({ prefix: "/sandboxes/:id/agent" })
    .use(authPlugin)
    .onBeforeHandle(accessGuard)
    .get("/sessions", ({ params }) => sessions.listSessions(params.id))
    .get("/sessions/:sessionId", ({ params }) =>
      sessions.getSession(params.id, params.sessionId),
    )
    .delete("/sessions/:sessionId", async ({ params }) => ({
      ok: await sessions.deleteSession(params.id, params.sessionId),
    }))
    .post("/sessions/:sessionId/abort", async ({ params }) => ({
      ok: await sessions.abortSession(params.id, params.sessionId),
    }))
    .get("/sessions/:sessionId/todos", ({ params }) =>
      sessions.getTodos(params.id, params.sessionId),
    )
    .get("/session-statuses", ({ params }) =>
      sessions.sessionStatuses(params.id),
    )
    .get("/events", async function* ({ params, request }) {
      const controller = new AbortController();
      const queue: { resource: string; sessionId?: string }[] = [];
      let notify: (() => void) | null = null;

      request.signal.addEventListener("abort", () => controller.abort());

      const pump = sessions
        .subscribeEvents(params.id, controller.signal, (event) => {
          queue.push(event);
          notify?.();
          notify = null;
        })
        .catch((err) => {
          log.warn({ sandboxId: params.id, err }, "Agent event stream ended");
        });

      request.signal.addEventListener(
        "abort",
        () => {
          notify?.();
          notify = null;
        },
        { once: true },
      );

      let eventId = 0;
      try {
        while (!request.signal.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            if (request.signal.aborted) break;
          }
          while (queue.length > 0) {
            const event = queue.shift();
            if (!event) continue;
            eventId++;
            yield sse({
              id: eventId,
              event: "agent",
              data: { ...event, sandboxId: params.id },
            });
          }
        }
      } finally {
        controller.abort();
        await pump;
      }
    });

  const terminalRoutes = new Elysia({ prefix: "/sandboxes/:id/terminal" })
    .use(authPlugin)
    .onBeforeHandle(accessGuard)
    .get("/sessions", ({ params, user }) =>
      terminal.listSessions(params.id, user.id),
    )
    .post(
      "/sessions",
      ({ params, user, body }) =>
        terminal.createSession(params.id, user.id, body),
      {
        body: t.Object({
          title: t.Optional(t.String()),
          command: t.Optional(t.String()),
          workdir: t.Optional(t.String()),
        }),
      },
    )
    .get("/sessions/:sessionId", ({ params, user }) =>
      terminal.getOwnedSession(params.id, params.sessionId, user.id),
    )
    .delete("/sessions/:sessionId", async ({ params, user, set }) => {
      await terminal.deleteSession(params.id, params.sessionId, user.id);
      set.status = 204;
    })
    .ws("/sessions/:sessionId/ws", {
      async open(ws) {
        const { id, sessionId } = ws.data.params;
        const user = (ws.data as { user?: { id: string } }).user;
        if (!user) {
          ws.close(4001, "Unauthorized");
          return;
        }
        try {
          // The upgrade carries no resolved user, so the guard defers here.
          requireSandboxAccess(container, user.id, id);
          await terminal.getOwnedSession(id, sessionId, user.id);
          const url = await terminal.bridgeUrl(id, sessionId);
          openUpstreamRelay(ws, url);
        } catch {
          ws.close(4003, "Access denied");
        }
      },
      message(ws, message) {
        if (isUserInput(message)) {
          container.runtime.touch(ws.data.params.id, "console");
        }
        if (relayMessage(ws, message)) return;
        // Elysia auto-parses JSON text frames into objects, so control
        // messages (e.g. `{type:"resize",cols,rows}`) never arrive as a
        // string. Re-serialize so the agent's PTY resize path still sees
        // them — otherwise resize is silently dropped (keystrokes, sent as
        // binary frames, are unaffected).
        const upstream = (ws.data as Record<string, unknown>).upstream as
          | WebSocket
          | undefined;
        if (
          upstream &&
          upstream.readyState === WebSocket.OPEN &&
          typeof message === "object" &&
          message !== null
        )
          upstream.send(JSON.stringify(message));
      },
      close(ws) {
        closeUpstream(ws);
      },
    });

  function taskDetail(taskId: string) {
    const task = container.tasks.describe(taskId);
    const name = container.runtime.getLabels(task.sandboxId)?.annotations[
      SANDBOX_NAME_ANNOTATION
    ];
    return { ...task, sandboxName: name };
  }

  function requireTaskAccess(taskId: string, userId: string): void {
    requireSandboxAccess(
      container,
      userId,
      container.tasks.describe(taskId).sandboxId,
    );
  }

  /** The first repo the sandbox booted with, cloned under the dev home by
   * its default clone name; the home itself for a sandbox with no repo. */
  function defaultTaskCwd(sandboxId: string): string {
    const repo = container.runtime.list().find((s) => s.id === sandboxId)
      ?.repos?.[0];
    return repo ? `${VM.HOME}/${repoCloneName(repo.url)}` : VM.HOME;
  }

  // Not under `/sandboxes/:id`, so no access guard: each handler applies the
  // sandbox access rule itself.
  const taskRoutes = new Elysia({ prefix: "/tasks" })
    .use(authPlugin)
    .get(
      "/",
      ({ user, query }) => {
        const names = new Map(
          accessibleSandboxes(container, user.id, container.runtime.list()).map(
            (s) => [s.id, s.annotations?.[SANDBOX_NAME_ANNOTATION]],
          ),
        );
        return container.tasks
          .listForSandboxes([...names.keys()], {
            status: query.status,
            limit: query.limit,
          })
          .map((task) => ({ ...task, sandboxName: names.get(task.sandboxId) }));
      },
      {
        query: t.Object({
          status: t.Optional(
            t.Union([
              t.Literal("running"),
              t.Literal("idle"),
              t.Literal("failed"),
              t.Literal("cancelled"),
            ]),
          ),
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 500 })),
        }),
      },
    )
    .post(
      "/",
      async ({ user, body }) => {
        requireSandboxAccess(container, user.id, body.sandboxId);
        const started = await container.tasks.dispatchTask(user.id, {
          sandboxId: body.sandboxId,
          prompt: body.prompt,
          cwd: body.cwd ?? defaultTaskCwd(body.sandboxId),
          source: "console",
        });
        return taskDetail(started.taskId);
      },
      {
        body: t.Object({
          sandboxId: t.String(),
          prompt: t.String(),
          cwd: t.Optional(t.String()),
        }),
      },
    )
    .get("/:taskId", ({ params, user }) => {
      const task = container.tasks.describe(params.taskId);
      // Same NotFound for "unknown" and "not yours".
      requireSandboxAccess(container, user.id, task.sandboxId);
      return taskDetail(params.taskId);
    })
    // Actions: sandbox access first (404 for strangers), then the service's
    // own ownership check (only the dispatching user drives a task).
    .post(
      "/:taskId/prompt",
      async ({ params, user, body }) => {
        requireTaskAccess(params.taskId, user.id);
        await container.tasks.sendPrompt(user.id, params.taskId, body.text);
        return taskDetail(params.taskId);
      },
      { body: t.Object({ text: t.String() }) },
    )
    .post("/:taskId/cancel", async ({ params, user }) => {
      requireTaskAccess(params.taskId, user.id);
      await container.tasks.cancel(user.id, params.taskId);
      return taskDetail(params.taskId);
    })
    .delete("/:taskId", async ({ params, user, set }) => {
      requireTaskAccess(params.taskId, user.id);
      await container.tasks.close(user.id, params.taskId);
      set.status = 204;
    });

  return new Elysia({ prefix: "/sessions" })
    .use(taskRoutes)
    .use(agentRoutes)
    .use(terminalRoutes);
}
