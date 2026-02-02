import { Elysia } from "elysia";
import { sandboxService } from "../container.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("terminal-proxy");

const TERMINAL_WS_PORT = 7681;

export const terminalRoutes = new Elysia({ prefix: "/sandboxes" }).ws(
  "/:id/terminal/ws",
  {
    open(ws) {
      const id = (ws.data.params as { id: string }).id;
      const sandbox = sandboxService.getById(id);
      if (!sandbox || sandbox.status !== "running") {
        ws.close(1008, "Sandbox not running");
        return;
      }

      const ip = sandbox.runtime.ipAddress;
      const upstream = new WebSocket(`ws://${ip}:${TERMINAL_WS_PORT}`);

      upstream.binaryType = "arraybuffer";

      upstream.onopen = () => {
        log.debug({ sandboxId: id }, "Terminal upstream connected");
      };

      upstream.onmessage = (event) => {
        try {
          ws.send(event.data as ArrayBuffer | string);
        } catch {
          upstream.close();
        }
      };

      upstream.onerror = () => {
        log.warn({ sandboxId: id }, "Terminal upstream error");
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

      if (message instanceof ArrayBuffer) {
        upstream.send(message);
      } else if (typeof message === "string") {
        upstream.send(message);
      } else {
        upstream.send(message as Uint8Array);
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
  },
);
