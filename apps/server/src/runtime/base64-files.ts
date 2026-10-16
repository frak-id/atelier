/**
 * Binary file writes (`patchFiles` entries with `encoding: "base64"`), e.g.
 * an image someone wants in a workspace.
 *
 * The agent's `files/write` only takes UTF-8 text (`content` is a JSON
 * string), so each file's base64 text, which is plain ASCII, is staged in a
 * root-only temp file through `files/write` and decoded into place by one
 * exec. That needs no agent change, so it works on every image and every
 * prebuild already baked. The payload never rides argv (a single argument is
 * capped at 128 KiB): `base64 -d` reads the staged file.
 */
import { safeNanoid } from "../shared/lib/id.ts";
import type { AgentClient, FileWriteResult } from "./agent/index.ts";

export interface Base64FileWrite {
  path: string;
  /** Standard or URL-safe base64; whitespace and missing padding are fine. */
  content: string;
  mode?: string;
  owner?: string;
}

const STAGING_DIR = "/tmp";
const DECODE_TIMEOUT_MS = 60_000;
/** Same ids the agent's `files/write` uses for `owner`. */
const OWNER_IDS: Record<string, string> = { dev: "1000:1000", root: "0:0" };

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Normalize to standard, padded base64, or `null` when it isn't base64. */
export function normalizeBase64(content: string): string | null {
  const compact = content
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(compact) || compact.length % 4 === 1) {
    return null;
  }
  return compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
}

/** Why `file` can't be written, before anything touches the sandbox. */
function invalid(file: Base64FileWrite): string | undefined {
  if (!file.path.startsWith("/")) return "path must be absolute";
  if (file.mode !== undefined && !/^[0-7]{3,4}$/.test(file.mode)) {
    return `bad mode: ${file.mode}`;
  }
  if (file.owner !== undefined && !OWNER_IDS[file.owner]) {
    return `unknown owner: ${file.owner}`;
  }
  if (normalizeBase64(file.content) === null) {
    return "content is not valid base64";
  }
  return undefined;
}

/** The decode step: `staged` (base64 text) becomes `file.path`, replaced
 * atomically, with the requested mode/owner. The staged copy is removed
 * whatever happens. */
function decodeScript(staged: string, file: Base64FileWrite): string {
  const owner = file.owner ? OWNER_IDS[file.owner] : undefined;
  return [
    "set -eu",
    `src=${shellQuote(staged)}`,
    `dst=${shellQuote(file.path)}`,
    'tmp="$dst.atelier-$$"',
    'trap \'rm -f "$src" "$tmp"\' EXIT',
    'mkdir -p "$(dirname "$dst")"',
    'base64 -d "$src" > "$tmp"',
    ...(file.mode ? [`chmod ${file.mode} "$tmp"`] : []),
    ...(owner ? [`chown ${owner} "$tmp"`] : []),
    'mv -f "$tmp" "$dst"',
  ].join("\n");
}

/** Write base64 files into a running sandbox; one result per file, in
 * order (partial success is reported, like `files/write`). */
export async function writeBase64Files(
  agent: Pick<AgentClient, "writeFiles" | "exec">,
  sandboxId: string,
  files: Base64FileWrite[],
): Promise<FileWriteResult[]> {
  const results: FileWriteResult[] = files.map((file) => {
    const error = invalid(file);
    return error
      ? { path: file.path, success: false, error }
      : { path: file.path, success: true };
  });
  const staged = files
    .map((file, index) => ({
      file,
      index,
      at: `${STAGING_DIR}/.atelier-upload-${safeNanoid()}.b64`,
    }))
    .filter(({ index }) => results[index]?.success);
  if (staged.length === 0) return results;

  const { results: stagedWrites } = await agent.writeFiles(
    sandboxId,
    staged.map(({ file, at }) => ({
      path: at,
      content: normalizeBase64(file.content) ?? "",
      mode: "600",
      owner: "root",
    })),
  );
  await Promise.all(
    staged.map(async ({ file, index, at }, i) => {
      const write = stagedWrites[i];
      if (!write?.success) {
        results[index] = {
          path: file.path,
          success: false,
          error: `stage upload: ${write?.error ?? "not written"}`,
        };
        return;
      }
      try {
        const run = await agent.exec(sandboxId, decodeScript(at, file), {
          user: "root",
          timeout: DECODE_TIMEOUT_MS,
        });
        if (run.exitCode !== 0) {
          results[index] = {
            path: file.path,
            success: false,
            error: run.stderr.trim().slice(-500) || `exit ${run.exitCode}`,
          };
        }
      } catch (err) {
        results[index] = {
          path: file.path,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
  return results;
}
