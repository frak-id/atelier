import pino from "pino";
import { isProduction } from "./config.ts";
import { openRotatingLogFile } from "./log-file.ts";
import { appPaths } from "./paths.ts";

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
// in local mode. Gate on NODE_ENV (always
// "production" in the Docker image, unset under `bun run dev`) rather than the
// server *mode*, so pretty logging only turns on where node_modules exists.
const usePrettyTransport = process.env.NODE_ENV !== "production";

// Production also keeps a rotated file under DATA_DIR/logs, next to stdout.
// No pino transport (see above): `pino.multistream` over plain destinations.
const logFile =
  isProduction() && !usePrettyTransport
    ? openRotatingLogFile(`${appPaths.log}/server.log`)
    : undefined;

/** Rotate the log file if it grew past its limit (a periodic job calls it). */
export function rotateLogFile(): void {
  logFile?.rotateIfNeeded();
}

export const logger = pino(
  {
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
  },
  logFile
    ? pino.multistream([
        { level: getLevel(), stream: process.stdout },
        { level: getLevel(), stream: logFile.stream },
      ])
    : undefined,
);

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
