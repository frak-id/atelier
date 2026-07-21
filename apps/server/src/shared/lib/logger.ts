import pino from "pino";
import { isProduction } from "./config.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

function getLevel(): LogLevel {
  const env = process.env.LOG_LEVEL as LogLevel;
  if (env && ["debug", "info", "warn", "error"].includes(env)) return env;
  return isProduction() ? "info" : "debug";
}

// pino-pretty runs as a thread-stream worker thread that resolves its
// `worker.js` from node_modules at runtime. The bundled single-file production
// image (bun build → server.js) has no node_modules, so enabling it there
// crashes on boot with "the worker has exited" — including when the image runs
// in mock mode (e.g. `atelier local up`). Gate on NODE_ENV (always
// "production" in the Docker image, unset under `bun run dev`) rather than the
// server *mode*, so pretty logging only turns on where node_modules exists.
const usePrettyTransport = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: getLevel(),
  serializers: {
    // Codebase uses `{ error }` everywhere — register pino's Error
    // serializer on the `error` key so Error objects stop logging as `{}`.
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err,
  },
  ...(usePrettyTransport
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
          },
        },
      }
    : {}),
});

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
