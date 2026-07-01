import type {
  AgentPermissionRequest,
  AgentQuestionRequest,
  AgentSession,
  AgentSessionStatus,
  AgentTodo,
} from "@frak/atelier-shared";
import { Elysia, sse, t } from "elysia";
import { orgMemberService } from "../../container.ts";
import type { Sandbox } from "../../schemas/index.ts";
import { resolveHarness } from "../../shared/agent/harness-adapter.ts";
import { resolveSessionSurface } from "../../shared/agent/session-surface.registry.ts";
import { ForbiddenError, NotFoundError } from "../../shared/errors.ts";
import { authPlugin } from "../../shared/lib/auth.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { sandboxIdGuard } from "./guard.ts";

const log = createChildLogger("agent-facade");

/** Resolve the harness session surface for a sandbox (auth applied server-side). */
function surfaceFor(sandbox: Sandbox) {
  const harness = resolveHarness(undefined);
  return resolveSessionSurface(harness.id, {
    ipAddress: sandbox.runtime.ipAddress,
    password: sandbox.runtime.agentPassword,
  });
}

/**
 * Manager facade for the dashboard's agent session surface. Keyed by sandboxId;
 * the manager attaches the pod's Basic-auth server-side so the dashboard never
 * sees pod URLs or the agent password. Returns neutral Agent* shapes.
 */
export const agentFacadeRoutes = new Elysia({ prefix: "/sandboxes/:id/agent" })
  .use(authPlugin)
  .use(sandboxIdGuard)
  // Enforce org ownership: existence (sandboxIdGuard) is not authorization, and
  // these routes control the pod's coding agent. Mirrors the sandbox list
  // endpoint's membership filter.
  .resolve(({ sandbox, user }) => {
    if (sandbox.orgId !== undefined) {
      const orgIds = new Set(
        orgMemberService.getByUserId(user.id).map((m) => m.orgId),
      );
      if (!orgIds.has(sandbox.orgId)) {
        throw new ForbiddenError("Sandbox not accessible");
      }
    }
    return {};
  })
  .get("/sessions", async ({ sandbox }): Promise<AgentSession[]> => {
    const sessions = await surfaceFor(sandbox).listSessions();
    return sessions.map((s) => ({ ...s, sandboxId: sandbox.id }));
  })
  .post(
    "/sessions",
    async ({ sandbox, body }) => {
      return surfaceFor(sandbox).createSession(body.directory);
    },
    { body: t.Object({ directory: t.Optional(t.String()) }) },
  )
  .get(
    "/sessions/:sessionId",
    async ({ sandbox, params }): Promise<AgentSession> => {
      const session = await surfaceFor(sandbox).getSession(params.sessionId);
      if (!session) throw new NotFoundError("Session", params.sessionId);
      return { ...session, sandboxId: sandbox.id };
    },
  )
  .delete("/sessions/:sessionId", async ({ sandbox, params }) => {
    return { ok: await surfaceFor(sandbox).deleteSession(params.sessionId) };
  })
  .post("/sessions/:sessionId/abort", async ({ sandbox, params }) => {
    return { ok: await surfaceFor(sandbox).abortSession(params.sessionId) };
  })
  .get(
    "/sessions/:sessionId/todos",
    async ({ sandbox, params }): Promise<AgentTodo[]> => {
      return surfaceFor(sandbox).getTodos(params.sessionId);
    },
  )
  .get(
    "/session-statuses",
    async ({ sandbox }): Promise<Record<string, AgentSessionStatus>> => {
      return surfaceFor(sandbox).sessionStatuses();
    },
  )
  .get(
    "/permissions",
    async ({ sandbox }): Promise<AgentPermissionRequest[]> => {
      return surfaceFor(sandbox).listPermissions();
    },
  )
  .post(
    "/permissions/:requestId/reply",
    async ({ sandbox, params, body }) => {
      const result = await surfaceFor(sandbox).replyPermission(
        params.requestId,
        body.reply,
      );
      if (!result.ok && result.status === 404) {
        throw new NotFoundError("Permission request", params.requestId);
      }
      return { ok: result.ok };
    },
    {
      body: t.Object({
        reply: t.Union([
          t.Literal("once"),
          t.Literal("always"),
          t.Literal("reject"),
        ]),
      }),
    },
  )
  .get("/questions", async ({ sandbox }): Promise<AgentQuestionRequest[]> => {
    return surfaceFor(sandbox).listQuestions();
  })
  .post(
    "/questions/:requestId/reply",
    async ({ sandbox, params, body }) => {
      const result = await surfaceFor(sandbox).replyQuestion(
        params.requestId,
        body.answers,
      );
      if (!result.ok && result.status === 404) {
        throw new NotFoundError("Question", params.requestId);
      }
      return { ok: result.ok };
    },
    { body: t.Object({ answers: t.Array(t.Array(t.String())) }) },
  )
  .post("/questions/:requestId/reject", async ({ sandbox, params }) => {
    const result = await surfaceFor(sandbox).rejectQuestion(params.requestId);
    if (!result.ok && result.status === 404) {
      throw new NotFoundError("Question", params.requestId);
    }
    return { ok: result.ok };
  })
  .get("/events", async function* ({ sandbox, request }) {
    const controller = new AbortController();
    const queue: { resource: string; sessionId?: string }[] = [];
    let notify: (() => void) | null = null;

    request.signal.addEventListener("abort", () => controller.abort());

    const pump = surfaceFor(sandbox)
      .subscribeEvents(controller.signal, (event) => {
        queue.push(event);
        notify?.();
        notify = null;
      })
      .catch((err) => {
        log.warn({ sandboxId: sandbox.id, err }, "Agent event stream ended");
      });

    let eventId = 0;
    try {
      while (!request.signal.aborted) {
        if (queue.length === 0) {
          // Cancellable by abort so an idle client disconnect runs `finally`
          // and tears down the upstream subscription (no leak).
          await new Promise<void>((resolve) => {
            notify = resolve;
            request.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
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
            data: { ...event, sandboxId: sandbox.id },
          });
        }
      }
    } finally {
      controller.abort();
      await pump;
    }
  });
