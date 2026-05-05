import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { xdgData } from "xdg-basedir";

// ---------------------------------------------------------------------------
// File-backed logger with rotation
//
// Why a dedicated file? Plugin output via console.log gets buried in OpenCode's
// own logs. A separate file (default ~/.local/share/opencode/log/atelier.log)
// makes `tail -f` debugging trivial.
// ---------------------------------------------------------------------------

type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

const MAX_BYTES = 3 * 1024 * 1024; // rotate above 3MB
const KEEP_BYTES = 1 * 1024 * 1024; // keep tail (last 1MB) on rotation

const DEFAULT_PATH = xdgData
  ? join(xdgData, "opencode", "log", "atelier.log")
  : null;

let logFilePath: string | null = DEFAULT_PATH;
let echoToConsole = false;

export function setLogFilePath(path: string | null): void {
  logFilePath = path;
}

export function setEchoToConsole(enabled: boolean): void {
  echoToConsole = enabled;
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

function rotateIfNeeded(path: string): void {
  try {
    const { size } = statSync(path);
    if (size <= MAX_BYTES) return;

    const content = readFileSync(path, "utf-8");
    const tail = content.slice(-KEEP_BYTES);
    // Drop partial first line so we don't start mid-record.
    const firstNewline = tail.indexOf("\n");
    writeFileSync(
      path,
      firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail,
    );
  } catch {
    // File may not exist yet — that's fine.
  }
}

function write(level: LogLevel, message: string): void {
  if (echoToConsole) {
    const fn =
      level === "ERROR"
        ? console.error
        : level === "WARN"
          ? console.warn
          : console.log;
    fn(`[atelier] ${message}`);
  }

  if (!logFilePath) return;

  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
  } catch {
    // Directory may already exist.
  }

  rotateIfNeeded(logFilePath);

  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    appendFileSync(logFilePath, line);
  } catch (err) {
    // Last-ditch fallback so we never lose visibility on broken filesystems.
    console.error(`[atelier] Failed to write log: ${err}`);
    console.error(`[atelier] ${line}`);
  }
}

export const logger = {
  info: (msg: string) => write("INFO", msg),
  warn: (msg: string) => write("WARN", msg),
  error: (msg: string) => write("ERROR", msg),
  debug: (msg: string) => write("DEBUG", msg),
};
