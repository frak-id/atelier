import { config } from "./config.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function getLevel(): LogLevel {
  const env = process.env.LOG_LEVEL as LogLevel;
  if (env && LEVELS[env] !== undefined) return env;
  return config.isProduction() ? "info" : "debug";
}

const currentLevel = LEVELS[getLevel()];

function log(level: LogLevel, context: Record<string, unknown>, msg?: string) {
  if (LEVELS[level] < currentLevel) return;
  const entry = { level, time: Date.now(), ...context, ...(msg ? { msg } : {}) };
  console.log(JSON.stringify(entry));
}

interface Logger {
  debug: (ctx: Record<string, unknown> | string, msg?: string) => void;
  info: (ctx: Record<string, unknown> | string, msg?: string) => void;
  warn: (ctx: Record<string, unknown> | string, msg?: string) => void;
  error: (ctx: Record<string, unknown> | string, msg?: string) => void;
  child: (ctx: Record<string, unknown>) => Logger;
}

function createLogger(baseCtx: Record<string, unknown> = {}): Logger {
  const make = (level: LogLevel) => (ctx: Record<string, unknown> | string, msg?: string) => {
    if (typeof ctx === "string") {
      log(level, baseCtx, ctx);
    } else {
      log(level, { ...baseCtx, ...ctx }, msg);
    }
  };
  return {
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    child: (ctx) => createLogger({ ...baseCtx, ...ctx }),
  };
}

export const logger = createLogger();

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}
