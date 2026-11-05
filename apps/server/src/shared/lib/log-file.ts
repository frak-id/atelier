/**
 * A size-rotated log file for pino, without transports: the bundled
 * single-file image has no node_modules, so a worker-thread transport can't
 * load. `pino.destination` writes the file; rotation renames the files aside
 * and has the destination reopen the path (`server.log` → `.1` → `.2`).
 */
import { existsSync, renameSync, rmSync, statSync } from "node:fs";
import pino from "pino";

/** Rotate once the live file reaches this size. */
const MAX_BYTES = 20 * 1024 * 1024;
/** Files kept in total: the live one plus the rotated ones. */
const FILES = 3;

export interface RotatingLogFile {
  stream: ReturnType<typeof pino.destination>;
  /** Rotate when the live file is over the size limit. Cheap enough to call
   * from a periodic job; never throws. */
  rotateIfNeeded: () => void;
}

/** Move `path` → `path.1` → … dropping the oldest, so `path` is free. */
function shiftFiles(path: string, files: number): void {
  rmSync(`${path}.${files - 1}`, { force: true });
  for (let n = files - 2; n >= 1; n--) {
    if (existsSync(`${path}.${n}`))
      renameSync(`${path}.${n}`, `${path}.${n + 1}`);
  }
  renameSync(path, `${path}.1`);
}

function oversized(path: string, maxBytes: number): boolean {
  try {
    return statSync(path).size >= maxBytes;
  } catch {
    return false;
  }
}

export function openRotatingLogFile(
  path: string,
  { maxBytes = MAX_BYTES, files = FILES } = {},
): RotatingLogFile {
  // On startup, before the file is opened: a restart loop must not grow it
  // without bound.
  if (oversized(path, maxBytes)) shiftFiles(path, files);
  const stream = pino.destination({ dest: path, mkdir: true, sync: false });
  return {
    stream,
    rotateIfNeeded() {
      try {
        if (!oversized(path, maxBytes)) return;
        shiftFiles(path, files);
        stream.reopen();
      } catch {
        // Logging must never take the process down; try again next tick.
      }
    },
  };
}
