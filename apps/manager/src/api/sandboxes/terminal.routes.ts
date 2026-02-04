import { Elysia } from "elysia";
import { sandboxService } from "../../container.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { sandboxIdGuard } from "./guard.ts";

const log = createChildLogger("terminal-proxy");

const TERMINAL_WS_PORT = config.raw.services.terminal.port;

export const terminalRoutes = new Elysia()
  .use(sandboxIdGuard)
  .ws("/:id/terminal/ws", {
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
          const data = event.data;
          if (data instanceof ArrayBuffer) {
            ws.send(Buffer.from(data));
          } else if (Buffer.isBuffer(data)) {
            ws.send(data);
          } else if (data instanceof Uint8Array) {
            ws.send(Buffer.from(data));
          } else if (typeof data === "string") {
            ws.send(data);
          } else {
            log.warn(
              { sandboxId: id, dataType: typeof data },
              "Unknown upstream data type",
            );
          }
        } catch (err) {
          log.error(
            { sandboxId: id, error: String(err) },
            "Failed to forward upstream data",
          );
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

      if (Buffer.isBuffer(message)) {
        upstream.send(message);
      } else if (message instanceof Uint8Array) {
        upstream.send(message);
      } else if (message instanceof ArrayBuffer) {
        upstream.send(new Uint8Array(message));
      } else if (typeof message === "string") {
        upstream.send(message);
      } else {
        log.warn(
          { messageType: typeof message },
          "Unknown client message type",
        );
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
