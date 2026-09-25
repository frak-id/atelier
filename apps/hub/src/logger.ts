import pino from "pino";

/** JSON logs (no pretty transport: the hub may run as a bundled binary). */
const root = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: { error: pino.stdSerializers.err },
});

export function createLogger(name: string): pino.Logger {
  return root.child({ name });
}
