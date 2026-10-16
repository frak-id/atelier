/**
 * `patchFiles`: write files into a running sandbox. Text goes through the
 * agent's `files/write`; `encoding: "base64"` bytes through
 * `writeBase64Files`.
 *
 * A file belongs to `dev` unless its entry says otherwise: these are files
 * put in the workspace the coding agent and the user work in as `dev`, and
 * the agent (which runs as root) would otherwise leave them root's, so
 * nothing there could edit them. Directories created for a file are its
 * owner's too.
 */
import type { PatchFilesRequest } from "@atelier/spec";
import { createChildLogger } from "../shared/lib/logger.ts";
import {
  type AgentClient,
  type FileWriteResult,
  toFileWrites,
  type WriteFilesResult,
} from "./agent/index.ts";
import { writeBase64Files } from "./base64-files.ts";
import { MKDIRS_FN, OWNER_IDS, shellQuote } from "./file-owner.ts";

const log = createChildLogger("patch-files");

const DEFAULT_FILE_OWNER = "dev";

const MKDIRS_TIMEOUT_MS = 30_000;
/** Parent directories every sandbox has, so there's nothing to create. */
const EXISTING_DIRS = new Set(["/", "/tmp", "/home/dev"]);

type Agent = Pick<AgentClient, "writeFiles" | "exec">;
type Entry = PatchFilesRequest[number];

/** One result per file, in request order (a file can fail without failing
 * the call). */
export async function writePatchFiles(
  agent: Agent,
  sandboxId: string,
  files: PatchFilesRequest,
): Promise<WriteFilesResult> {
  const owned = files.map((f) => ({
    ...f,
    owner: f.owner ?? DEFAULT_FILE_OWNER,
  }));
  const isBinary = (f: Entry) => f.encoding === "base64";
  const text = owned.filter((f) => !isBinary(f));
  const binary = owned.filter(isBinary);
  const [written, decoded] = await Promise.all([
    text.length > 0 ? writeText(agent, sandboxId, text) : [],
    binary.length > 0 ? writeBase64Files(agent, sandboxId, binary) : [],
  ]);
  let t = 0;
  let b = 0;
  return {
    results: owned.map((f) => {
      const result = isBinary(f) ? decoded[b++] : written[t++];
      return result ?? { path: f.path, success: false, error: "no result" };
    }),
  };
}

async function writeText(
  agent: Agent,
  sandboxId: string,
  files: Entry[],
): Promise<FileWriteResult[]> {
  const script = ownedParentsScript(files);
  if (script) {
    // Best effort: if it fails, the agent still creates the directories
    // (root's) and reports any write that can't happen.
    try {
      const run = await agent.exec(sandboxId, script, {
        user: "root",
        timeout: MKDIRS_TIMEOUT_MS,
      });
      if (run.exitCode !== 0) {
        log.warn(
          { sandboxId, stderr: run.stderr.slice(-500) },
          "Creating owned parent directories failed",
        );
      }
    } catch (err) {
      log.warn({ sandboxId, err }, "Creating owned parent directories failed");
    }
  }
  return (await agent.writeFiles(sandboxId, toFileWrites(files))).results;
}

/** A root script creating the missing parent directories of the files a
 * non-root user owns, given to that user; `undefined` when there are none. */
export function ownedParentsScript(files: Entry[]): string | undefined {
  const calls = new Set<string>();
  for (const file of files) {
    const ids = file.owner && file.owner !== "root" && OWNER_IDS[file.owner];
    const slash = file.path.lastIndexOf("/");
    if (!ids || slash <= 0) continue;
    const dir = file.path.slice(0, slash);
    if (EXISTING_DIRS.has(dir)) continue;
    calls.add(`mkdirs ${shellQuote(dir)} ${ids} || status=1`);
  }
  if (calls.size === 0) return undefined;
  return [MKDIRS_FN, "status=0", ...calls, 'exit "$status"'].join("\n");
}
