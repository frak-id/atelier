/**
 * The tools that act inside a running sandbox: exec, read/write files,
 * processes, ports. Each goes through `sandboxOps`, which resumes a paused
 * sandbox first. Registered by `registerSandboxTools` (sandbox.ts).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthUser } from "../../../control/index.ts";
import type { ServerContainer } from "../../container.ts";
import { requireSandboxAccess } from "../../sandbox-guard.ts";
import { keepHeadTail, safeTool, text } from "../format.ts";

/** `exec` default: a clean agent-side timeout rather than an MCP client one
 * (clients commonly give up on a request around 60s). */
const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
const EXEC_MAX_TIMEOUT_MS = 600_000;
const EXEC_DEFAULT_MAX_CHARS = 16_000;

const LOGS_DEFAULT_MAX_CHARS = 8_000;
/** The agent serves logs oldest-first in chunks; the tail needs a walk. */
const LOGS_CHUNK_BYTES = 1_000_000;
const LOGS_MAX_CHUNKS = 20;

const READ_MAX_FILES = 20;
const READ_DEFAULT_MAX_BYTES = 32_768;
const READ_MAX_BYTES = 1_000_000;
const READ_TIMEOUT_MS = 20_000;

/** `value` as one POSIX shell word: single-quoted, so nothing in it (spaces,
 * `$`, backticks, quotes, newlines) is interpreted. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Read a process's log tail: walk the oldest-first chunks, keep the end. */
async function readLogTail(
  read: (
    offset: number,
    limit: number,
  ) => Promise<{ content: string; nextOffset: number }>,
  maxChars: number,
) {
  let offset = 0;
  let content = "";
  let dropped = 0;
  for (let i = 0; i < LOGS_MAX_CHUNKS; i++) {
    const chunk = await read(offset, LOGS_CHUNK_BYTES);
    content += chunk.content;
    if (content.length > maxChars) {
      dropped += content.length - maxChars;
      content = content.slice(-maxChars);
    }
    const advanced = chunk.nextOffset > offset;
    offset = chunk.nextOffset;
    if (!advanced || Buffer.byteLength(chunk.content) < LOGS_CHUNK_BYTES) break;
  }
  return {
    content:
      dropped > 0
        ? `[… ${dropped} earlier chars truncated]\n${content}`
        : content,
    truncated: dropped > 0,
  };
}

export function registerSandboxIoTools(
  server: McpServer,
  container: ServerContainer,
  user: AuthUser,
): void {
  const { runtime, sandboxOps } = container;
  const guard = (id: string) => requireSandboxAccess(container, user.id, id);

  server.registerTool(
    "exec",
    {
      title: "Exec",
      description:
        "Run a one-shot shell command in a sandbox and return `{exitCode, " +
        "stdout, stderr, truncated, durationMs}`. A non-zero exit code is a " +
        "normal result. Runs as the `dev` user in its home by default. " +
        "Each stream keeps its beginning and end when over " +
        "`maxOutputChars` (`truncated: true`): write big output to a file " +
        "and fetch it with `read_files`. For anything long-running use " +
        "`manage_process` or `send_prompt`, not a long `timeoutMs`.",
      inputSchema: {
        id: z.string().describe("Sandbox id"),
        command: z.string().describe("Shell command line"),
        cwd: z.string().optional().describe("Absolute working directory"),
        timeoutMs: z
          .number()
          .int()
          .min(1)
          .max(EXEC_MAX_TIMEOUT_MS)
          .optional()
          .describe(
            `Kill the command after this many milliseconds (default ` +
              `${EXEC_DEFAULT_TIMEOUT_MS}, max ${EXEC_MAX_TIMEOUT_MS}). Your ` +
              "MCP client may give up on the call sooner.",
          ),
        user: z
          .enum(["dev", "root"])
          .optional()
          .describe("Run as this user (default dev)"),
        maxOutputChars: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe(
            `Keep at most this many characters of each of stdout and ` +
              `stderr (default ${EXEC_DEFAULT_MAX_CHARS}).`,
          ),
      },
      outputSchema: {
        exitCode: z.number(),
        stdout: z.string(),
        stderr: z.string(),
        truncated: z.boolean(),
        durationMs: z.number(),
        hint: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safeTool("exec", async ({ id, maxOutputChars, timeoutMs, ...req }) => {
      guard(id);
      const started = Date.now();
      const result = await sandboxOps.exec(id, {
        ...req,
        timeoutMs: timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS,
      });
      const durationMs = Date.now() - started;
      const max = maxOutputChars ?? EXEC_DEFAULT_MAX_CHARS;
      const stdout = keepHeadTail(result.stdout, max);
      const stderr = keepHeadTail(result.stderr, max);
      const truncated = stdout.truncated || stderr.truncated;
      return text({
        exitCode: result.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated,
        durationMs,
        ...(truncated
          ? {
              hint:
                "Output was cut in the middle. Redirect it to a file and " +
                "use read_files with a line range, or raise maxOutputChars.",
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    "read_files",
    {
      title: "Read files",
      description:
        "Read text files from a sandbox (the `dev` user's view; relative " +
        "paths are from its home). Per file: `content`, total `bytes`, " +
        "`truncated` when cut at `maxBytes`, or an `error`. Pass `fromLine`/" +
        "`toLine` (1-based, inclusive) for a slice of a big file. Binary " +
        "files: use `exec` with base64.",
      inputSchema: {
        id: z.string().describe("Sandbox id"),
        paths: z.array(z.string().min(1)).min(1).max(READ_MAX_FILES),
        fromLine: z.number().int().min(1).optional(),
        toLine: z.number().int().min(1).optional(),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(READ_MAX_BYTES)
          .optional()
          .describe(
            `Per file (default ${READ_DEFAULT_MAX_BYTES}, max ${READ_MAX_BYTES}).`,
          ),
      },
      outputSchema: { files: z.array(z.object({}).passthrough()) },
      // File content is untrusted input for the model.
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safeTool(
      "read_files",
      async ({ id, paths, fromLine, toLine, maxBytes }) => {
        guard(id);
        const cap = maxBytes ?? READ_DEFAULT_MAX_BYTES;
        const from = fromLine ?? 1;
        // Every path is one quoted shell word and the file is read through
        // `<`, so a path can never be taken for an option or a command.
        const slice =
          fromLine !== undefined || toLine !== undefined
            ? `sed -n '${from},${toLine ?? "$"}p'`
            : "cat";
        const files = [];
        for (const path of paths) {
          const p = shellQuote(path);
          const { exitCode, stdout, stderr } = await sandboxOps.exec(id, {
            command:
              `[ -f ${p} ] && [ -r ${p} ] || { echo "not a readable file" >&2; exit 2; }; ` +
              `wc -c < ${p}; ${slice} < ${p} | head -c ${cap + 1}`,
            timeoutMs: READ_TIMEOUT_MS,
          });
          if (exitCode !== 0) {
            files.push({ path, error: stderr.trim() || `exit ${exitCode}` });
            continue;
          }
          const newline = stdout.indexOf("\n");
          const bytes = Number(stdout.slice(0, newline).trim());
          const body = Buffer.from(stdout.slice(newline + 1));
          const truncated = body.length > cap;
          files.push({
            path,
            content: (truncated ? body.subarray(0, cap) : body).toString(),
            bytes,
            ...(truncated ? { truncated: true } : {}),
          });
        }
        return text({ files });
      },
    ),
  );

  server.registerTool(
    "write_files",
    {
      title: "Write files",
      description:
        "Write (create or overwrite) files in a sandbox. Returns how many " +
        "were `written` and a `failed` list with the reason for each file " +
        "that could not be written (an error result when any failed). " +
        "Running processes are not restarted: use `manage_process` " +
        "action=restart if they need to reload. Binary files go in as " +
        "base64 with encoding=base64.",
      inputSchema: {
        id: z.string().describe("Sandbox id"),
        files: z
          .array(
            z.object({
              path: z.string().describe("Absolute path in the sandbox"),
              content: z
                .string()
                .describe(
                  "Full file content: its text, or its bytes as base64 " +
                    "with encoding=base64",
                ),
              encoding: z
                .enum(["utf8", "base64"])
                .optional()
                .describe(
                  "utf8 (default) or base64 (binary content, e.g. an image)",
                ),
              mode: z
                .string()
                .optional()
                .describe('Octal permission string, e.g. "644" or "755"'),
              owner: z
                .enum(["dev", "root"])
                .optional()
                .describe(
                  "File owner (default dev), also of directories created for it",
                ),
            }),
          )
          .min(1),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeTool("write_files", async ({ id, files }) => {
      guard(id);
      const { results } = await sandboxOps.patchFiles(id, files);
      const failed = results
        .filter((r) => !r.success)
        .map((r) => ({ path: r.path, error: r.error ?? "unknown error" }));
      return text(
        { written: results.length - failed.length, failed },
        failed.length > 0,
      );
    }),
  );

  server.registerTool(
    "manage_process",
    {
      title: "Manage process",
      description:
        "Start, stop, restart, or read the logs of a supervised process in " +
        "a sandbox. `name` comes from `get_sandbox` `processes`. `start` " +
        "returns before the process is ready: poll `get_sandbox`. `logs` " +
        "returns the most recent output (`truncated: true` when older " +
        "output was cut).",
      inputSchema: {
        id: z.string().describe("Sandbox id"),
        name: z.string().describe("Process name (from get_sandbox)"),
        action: z.enum(["start", "stop", "restart", "logs"]),
        maxChars: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe(
            `action=logs only: trailing characters to return (default ` +
              `${LOGS_DEFAULT_MAX_CHARS}).`,
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    safeTool("manage_process", async ({ id, name, action, maxChars }) => {
      guard(id);
      switch (action) {
        case "logs":
          return text({
            name,
            ...(await readLogTail(
              (offset, limit) =>
                sandboxOps.processLogs(id, name, offset, limit),
              maxChars ?? LOGS_DEFAULT_MAX_CHARS,
            )),
          });
        case "start":
          await sandboxOps.processAction(id, name, "start");
          return text({ name, status: "started" });
        case "stop":
          await sandboxOps.processAction(id, name, "stop");
          return text({ name, status: "stopped" });
        case "restart":
          await sandboxOps.processAction(id, name, "stop");
          await sandboxOps.processAction(id, name, "start");
          return text({ name, status: "restarted" });
      }
    }),
  );

  server.registerTool(
    "expose_port",
    {
      title: "Expose port",
      description:
        "Expose a port of a running sandbox after boot as an https `url` " +
        "(`<name>-<id>.<domain>`). By default (`auth: forward`) opening it " +
        "requires an Atelier login; `auth: none` makes it open to anyone " +
        "with the link: only when asked for. On the local Docker backend " +
        "nothing is exposed and no `url` is returned.",
      inputSchema: {
        id: z.string().describe("Sandbox id"),
        name: z
          .string()
          .describe(
            "Port name; becomes the hostname prefix (lowercase, a-z0-9-)",
          ),
        port: z.number().int().min(1).max(65535),
        auth: z
          .enum(["forward", "none"])
          .optional()
          .describe("forward (default): login required. none: public."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safeTool("expose_port", async ({ id, name, port, auth }) => {
      guard(id);
      const mode = auth ?? "forward";
      await runtime.addPort(id, { name, port, public: true, auth: mode });
      const state = await runtime.get(id);
      const url = state.urls.find((u) => u.name === name)?.url;
      return text({ name, port, auth: mode, ...(url ? { url } : {}) });
    }),
  );
}
