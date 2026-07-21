import pino from "pino";
import { isProduction } from "./config.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

function getLevel(): LogLevel {
  const env = process.env.LOG_LEVEL as LogLevel;
  if (env && ["debug", "info", "warn", "error"].includes(env)) return env;
  return isProduction() ? "info" : "debug";
}

export const logger = pino({
  level: getLevel(),
  serializers: {
    // Codebase uses `{ error }` everywhere — register pino's Error
    // serializer on the `error` key so Error objects stop logging as `{}`.
    error: pino.stdSerializers.err,
    err: pino.stdSerializers.err,
  },
  ...(isProduction()
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
          },
        },
      }),
});

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
