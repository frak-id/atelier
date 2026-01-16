import pino from "pino";
import { config } from "./config.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

function getLevel(): LogLevel {
  const env = process.env.LOG_LEVEL as LogLevel;
  if (env && ["debug", "info", "warn", "error"].includes(env)) return env;
  return config.isProduction() ? "info" : "debug";
}

export const logger = pino({
  level: getLevel(),
  ...(config.isProduction()
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
