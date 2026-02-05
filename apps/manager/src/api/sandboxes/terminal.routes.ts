import { Elysia, t } from "elysia";
import { agentClient, sandboxService } from "../../container.ts";
import type { AuthUser } from "../../shared/lib/auth.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { sandboxIdGuard } from "./guard.ts";

const log = createChildLogger("terminal-routes");

const TERMINAL_WS_PORT = config.raw.services.terminal.port;

function getUser(store: { user?: AuthUser }): AuthUser {
  if (!store.user) throw new Error("User not authenticated");
  return store.user;
}

const TerminalSessionSchema = t.Object({
  id: t.String(),
  userId: t.String(),
  title: t.String(),
  status: t.Union([t.Literal("running"), t.Literal("exited")]),
  createdAt: t.String(),
});

const CreateSessionBodySchema = t.Object({
  title: t.Optional(t.String()),
  command: t.Optional(t.String()),
  workdir: t.Optional(t.String()),
});

export const terminalRoutes = new Elysia()
  .use(sandboxIdGuard)
  .get(
    "/:id/terminal/sessions",
    async ({ params, store }) => {
      const user = getUser(store as { user?: AuthUser });
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox || sandbox.status !== "running") {
        return [];
      }

      try {
        const sessions = await agentClient.terminalSessionList(params.id);
        return sessions.filter((s) => s.userId === user.id);
      } catch (error) {
        log.warn({ sandboxId: params.id, error }, "Failed to list sessions");
        return [];
      }
    },
    {
      response: t.Array(TerminalSessionSchema),
    },
  )
  .post(
    "/:id/terminal/sessions",
    async ({ params, body, store, set }) => {
      const user = getUser(store as { user?: AuthUser });
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox || sandbox.status !== "running") {
        set.status = 400;
        return { error: "Sandbox not running" };
      }

      try {
        const session = await agentClient.terminalSessionCreate(
          params.id,
          user.id,
          { title: body.title, command: body.command, workdir: body.workdir },
        );
        log.info(
          { sandboxId: params.id, sessionId: session.id, userId: user.id },
          "Created terminal session",
        );
        return session;
      } catch (error) {
        log.error({ sandboxId: params.id, error }, "Failed to create session");
        set.status = 500;
        return { error: "Failed to create session" };
      }
    },
    {
      body: CreateSessionBodySchema,
    },
  )
  .get("/:id/terminal/sessions/:sessionId", async ({ params, store, set }) => {
    const user = getUser(store as { user?: AuthUser });
    const sandbox = sandboxService.getById(params.id);
    if (!sandbox || sandbox.status !== "running") {
      set.status = 404;
      return { error: "Sandbox not running" };
    }

    try {
      const session = await agentClient.terminalSessionGet(
        params.id,
        params.sessionId,
      );
      if (session.userId !== user.id) {
        set.status = 403;
        return { error: "Access denied" };
      }
      return session;
    } catch {
      set.status = 404;
      return { error: "Session not found" };
    }
  })
  .delete(
    "/:id/terminal/sessions/:sessionId",
    async ({ params, store, set }) => {
      const user = getUser(store as { user?: AuthUser });
      const sandbox = sandboxService.getById(params.id);
      if (!sandbox || sandbox.status !== "running") {
        set.status = 404;
        return { error: "Sandbox not running" };
      }

      try {
        const session = await agentClient.terminalSessionGet(
          params.id,
          params.sessionId,
        );
        if (session.userId !== user.id) {
          set.status = 403;
          return { error: "Access denied" };
        }

        await agentClient.terminalSessionDelete(params.id, params.sessionId);
        log.info(
          {
            sandboxId: params.id,
            sessionId: params.sessionId,
            userId: user.id,
          },
          "Deleted terminal session",
        );
        set.status = 204;
        return null;
      } catch {
        set.status = 404;
        return { error: "Session not found" };
      }
    },
  )
  .ws("/:id/terminal/sessions/:sessionId/ws", {
    async open(ws) {
      const id = (ws.data.params as { id: string; sessionId: string }).id;
      const sessionId = (ws.data.params as { id: string; sessionId: string })
        .sessionId;
      const user = (ws.data as { store: { user?: AuthUser } }).store?.user;

      if (!user) {
        log.warn({ sandboxId: id }, "No user in WebSocket context");
        ws.close(4001, "Unauthorized");
        return;
      }

      const sandbox = sandboxService.getById(id);
      if (!sandbox || sandbox.status !== "running") {
        ws.close(4004, "Sandbox not running");
        return;
      }

      try {
        const session = await agentClient.terminalSessionGet(id, sessionId);
        if (session.userId !== user.id) {
          log.warn(
            { sandboxId: id, sessionId, userId: user.id },
            "User attempted to access another user's session",
          );
          ws.close(4003, "Access denied");
          return;
        }
      } catch {
        ws.close(4004, "Session not found");
        return;
      }

      const ip = sandbox.runtime.ipAddress;
      const upstream = new WebSocket(
        `ws://${ip}:${TERMINAL_WS_PORT}/${sessionId}`,
      );

      upstream.binaryType = "arraybuffer";

      upstream.onopen = () => {
        log.debug({ sandboxId: id, sessionId }, "Terminal upstream connected");
      };

      upstream.onmessage = (event) => {
        try {
          const data = event.data;
          if (data instanceof ArrayBuffer) {
            ws.send(Buffer.from(data));
          } else if (Buffer.isBuffer(data)) {
            ws.send(data);
          } else if (data instanceof Uint8Array) {
            ws.send(Buffer.from(data));
          } else if (typeof data === "string") {
            ws.send(data);
          }
        } catch (err) {
          log.error(
            { sandboxId: id, sessionId, error: String(err) },
            "Failed to forward upstream data",
          );
          upstream.close();
        }
      };

      upstream.onerror = () => {
        log.warn({ sandboxId: id, sessionId }, "Terminal upstream error");
        ws.close(1011, "Upstream error");
      };

      upstream.onclose = () => {
        ws.close();
      };

      (ws.data as Record<string, unknown>).upstream = upstream;
    },

    message(ws, message) {
      const upstream = (ws.data as Record<string, unknown>).upstream as
        | WebSocket
        | undefined;
      if (!upstream || upstream.readyState !== WebSocket.OPEN) return;

      if (typeof message === "string") {
        upstream.send(message);
      } else if (Buffer.isBuffer(message)) {
        upstream.send(message);
      } else if (message instanceof Uint8Array) {
        upstream.send(message);
      } else if (message instanceof ArrayBuffer) {
        upstream.send(new Uint8Array(message));
      } else if (typeof message === "object" && message !== null) {
        upstream.send(JSON.stringify(message));
      }
    },

    close(ws) {
      const upstream = (ws.data as Record<string, unknown>).upstream as
        | WebSocket
        | undefined;
      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.close();
      }
    },
  });
