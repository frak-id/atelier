/**
 * `/sessions/*` — the agent app-tier HTTP surface (atelier-v2 §3.1 api/
 * table: "/sessions/* → sessions"). Thin Elysia binding over
 * `SessionService`/`TerminalService`; all mechanism lives in `sessions/`.
 */
import { Elysia, sse, t } from "elysia";
import { createChildLogger } from "../shared/lib/logger.ts";
import { createAuthPlugin } from "./auth.plugin.ts";
import type { ServerContainer } from "./container.ts";

const log = createChildLogger("sessions-routes");

export function createSessionsRoutes(container: ServerContainer) {
  const { sessions, terminal, control } = container;
  const authPlugin = createAuthPlugin(control);

  const agentRoutes = new Elysia({ prefix: "/sandboxes/:id/agent" })
    .use(authPlugin)
    .get("/sessions", ({ params }) => sessions.listSessions(params.id))
    .post(
      "/sessions",
      ({ params, body }) => sessions.createSession(params.id, body.directory),
      { body: t.Object({ directory: t.Optional(t.String()) }) },
    )
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
    .get("/permissions", ({ params }) => sessions.listPermissions(params.id))
    .post(
      "/permissions/:requestId/reply",
      ({ params, body }) =>
        sessions.replyPermission(params.id, params.requestId, body.reply),
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
    .get("/questions", ({ params }) => sessions.listQuestions(params.id))
    .post(
      "/questions/:requestId/reply",
      ({ params, body }) =>
        sessions.replyQuestion(params.id, params.requestId, body.answers),
      { body: t.Object({ answers: t.Array(t.Array(t.String())) }) },
    )
    .post("/questions/:requestId/reject", ({ params }) =>
      sessions.rejectQuestion(params.id, params.requestId),
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
          await terminal.getOwnedSession(id, sessionId, user.id);
          const url = await terminal.bridgeUrl(id, sessionId);
          const upstream = new WebSocket(url);
          upstream.binaryType = "arraybuffer";
          upstream.onmessage = (event) => {
            const data = event.data;
            if (data instanceof ArrayBuffer) ws.send(Buffer.from(data));
            else if (typeof data === "string") ws.send(data);
          };
          upstream.onclose = () => ws.close();
          upstream.onerror = () => ws.close(1011, "Upstream error");
          (ws.data as Record<string, unknown>).upstream = upstream;
        } catch {
          ws.close(4003, "Access denied");
        }
      },
      message(ws, message) {
        const upstream = (ws.data as Record<string, unknown>).upstream as
          | WebSocket
          | undefined;
        if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
        if (typeof message === "string") upstream.send(message);
        else if (message instanceof Uint8Array) upstream.send(message);
      },
      close(ws) {
        const upstream = (ws.data as Record<string, unknown>).upstream as
          | WebSocket
          | undefined;
        if (upstream?.readyState === WebSocket.OPEN) upstream.close();
      },
    });

  return new Elysia({ prefix: "/sessions" })
    .use(agentRoutes)
    .use(terminalRoutes);
}
