import pino from "pino";
import { config } from "./config.ts";

export const logger = pino({
  level: process.env.LOG_LEVEL || (config.isProduction() ? "info" : "debug"),
  transport: config.isProduction()
    ? undefined
    : {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      },
});

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
