/**
 * Sandbox lifecycle + live-mutation tools — the MCP mirror of `/v1/*`
 * (atelier-v2 §4: "it grows the mutation tools ... so agents drive sandboxes
 * exactly like the CLI does"). `create_sandbox` reuses the exact enrichment
 * path `POST /v1/sandboxes` uses (`createSandboxForUser`), so an MCP-spawned
 * sandbox gets the same org secrets/policy/auto-injected toolboxes as the
 * HTTP/CLI/GUI path — no more "no identity in this context" gap.
 *
 * Outputs are projections for an agent, not the runtime's wire types: the
 * generated credentials (agent password, pod IP, ssh host keys), annotation
 * maps and internal hashes never leave the server through this surface.
 */
import {
  CreateSandboxRequestSchema,
  SANDBOX_NAME_ANNOTATION,
} from "@atelier/spec";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthUser } from "../../../control/index.ts";
import type { ServerContainer } from "../../container.ts";
import { createSandboxForUser } from "../../v1.routes.ts";
import { keepTail, rejectParams, safeTool, text } from "../format.ts";
import { parseSpec } from "../validate.ts";

/** `exec` default: a clean agent-side timeout rather than an MCP client one
 * (clients commonly give up on a request around 60s). */
const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
const EXEC_MAX_TIMEOUT_MS = 600_000;
const EXEC_DEFAULT_MAX_CHARS = 16_000;

const LOGS_DEFAULT_MAX_CHARS = 8_000;
/** The agent serves logs oldest-first in chunks; the tail needs a walk. */
const LOGS_CHUNK_BYTES = 1_000_000;
const LOGS_MAX_CHUNKS = 20;

interface RawUrl {
  name: string;
  url: string;
  ready?: boolean;
  processes?: string[];
}

/** The backend reports the ssh command as a pseudo-URL named `ssh`; split it
 * out so `urls` only holds things a browser/HTTP client can open. */
function splitUrls(raw: RawUrl[], verbose = false) {
  const ssh = raw.find((u) => u.name === "ssh")?.url;
  const urls = raw
    .filter((u) => u.name !== "ssh")
    .map((u) => ({
      name: u.name,
      url: u.url,
      ...(u.ready !== undefined ? { ready: u.ready } : {}),
      ...(verbose && u.processes?.length ? { processes: u.processes } : {}),
    }));
  return { urls, ssh };
}

/** The one agent-facing shape of a live sandbox (get_sandbox, resume). */
function sandboxView(
  state: {
    id: string;
    status: string;
    urls: RawUrl[];
    processes: unknown[];
    metadata?: Record<string, string>;
    annotations?: Record<string, string>;
  },
  verbose = false,
) {
  const { urls, ssh } = splitUrls(state.urls, verbose);
  const name = state.annotations?.[SANDBOX_NAME_ANNOTATION];
  return {
    id: state.id,
    status: state.status,
    ...(name ? { name } : {}),
    urls,
    ...(ssh ? { ssh } : {}),
    processes: state.processes,
    ...(verbose && state.metadata ? { metadata: state.metadata } : {}),
  };
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

export function registerSandboxTools(
  server: McpServer,
  container: ServerContainer,
  user: AuthUser,
): void {
  const { runtime } = container;

  server.registerTool(
    "create_sandbox",
    {
      title: "Create sandbox",
      description:
        "Boot a new sandbox and wait until it is up (can take a minute or " +
        "more). Returns its `id` and public `urls`; use `get_sandbox` for " +
        "process health and ssh, then `exec`, `patch_files` or " +
        "`send_prompt`. Your org's secrets and policy and your " +
        "auto-included toolboxes (see `list_toolboxes`) are applied " +
        "automatically. Minimal call: " +
        '`{"spec":{"source":{"image":"dev-base"}}}`.',
      inputSchema: {
        spec: z
          .record(z.string(), z.unknown())
          .describe(
            "SandboxSpec. `source` is required: {image} (a base image name, " +
              "see `manage_prebuilds` / server default `dev-base`) or " +
              "{snapshot} (a prebuild/snapshot `ref`). Optional: " +
              "`resources` {vcpus, memoryMb, diskGb} (server defaults when " +
              'omitted), `env` (name → string or {"$secret":"NAME"} — the ' +
              "only way to pass a secret), `files` [{path, content, mode?, " +
              "owner?}], `processes` [{name, command, cwd?, env?, primary?, " +
              "readiness?, restart?, lazy?}], `ports` [{name, port, " +
              "public?}], `hooks`, `caches`, `timeoutSeconds`, `metadata`, " +
              "`annotations`. Do NOT put `toolboxes`, `prebuild` or `orgId` " +
              "in here; they are separate arguments.",
          ),
        toolboxes: z
          .array(z.string())
          .optional()
          .describe(
            "Extra toolbox selectors to apply (`selector` from " +
              "`list_toolboxes`, e.g. tb/org/<orgId>/<slug>). Auto-included " +
              "toolboxes are applied without listing them.",
          ),
        prebuild: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "A PrebuildSpec to bake (cached when unchanged) and use as the " +
              "boot source instead of `spec.source`.",
          ),
        orgId: z
          .string()
          .optional()
          .describe(
            "Organization to run in (`orgs[].orgId` from `whoami`). " +
              "Default: `defaultOrgId` from `whoami`.",
          ),
      },
    },
    safeTool(async ({ spec, toolboxes, prebuild, orgId }) => {
      // Same boundary validation Elysia's schema guard gives the HTTP route.
      const body = parseSpec(
        CreateSandboxRequestSchema,
        {
          ...spec,
          ...(toolboxes ? { toolboxes } : {}),
          ...(prebuild ? { prebuild } : {}),
          ...(orgId ? { orgId } : {}),
        },
        "CreateSandboxRequest",
      );
      const created = await createSandboxForUser(container, user, body);
      // Only what the agent acts on next: the id and the openable URLs. The
      // generated credentials, pod IP and host keys stay server-side.
      return text({
        id: created.id,
        urls: splitUrls(created.urls).urls.map(({ name, url }) => ({
          name,
          url,
        })),
      });
    }),
  );

  server.registerTool(
    "get_sandbox",
    {
      title: "Get a sandbox, or list sandboxes",
      description:
        "With `id`: read that sandbox's status, openable `urls` (`ready` = " +
        "the process behind it is up), `ssh` command, and live `processes` " +
        "(their `name` is what `manage_process` takes). Check this before " +
        "`exec`: only a `running` sandbox accepts commands; `paused` or " +
        "`error` ones need `sandbox_lifecycle` action=resume. Without " +
        "`id`: list all sandboxes (id, status, name, repos, creation " +
        "date), newest first, optionally filtered by `status` and " +
        "`metadata`; summaries only, call again with an `id` for URLs and " +
        "process health.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe(
            "Sandbox to read (from create_sandbox / this tool's list). " +
              "Omit to list sandboxes.",
          ),
        status: z
          .enum(["creating", "running", "paused", "error"])
          .optional()
          .describe("List only: sandboxes in this status"),
        metadata: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "List only: sandboxes whose metadata holds every one of " +
              "these pairs",
          ),
        verbose: z
          .boolean()
          .optional()
          .describe(
            "One sandbox only: also return `metadata` and which processes " +
              "gate each URL. Rarely needed.",
          ),
      },
    },
    safeTool(async ({ id, status, metadata, verbose }) => {
      if (id !== undefined) {
        rejectParams(
          { status, metadata },
          "only filters the sandbox list (omit `id` to list)",
        );
        return text(sandboxView(await runtime.get(id), verbose));
      }

      rejectParams(
        { verbose },
        "only applies when reading one sandbox (pass `id`)",
      );
      const all = runtime.list(metadata);
      const rows = (status ? all.filter((s) => s.status === status) : all)
        .map((s) => {
          const name = s.annotations?.[SANDBOX_NAME_ANNOTATION];
          return {
            id: s.id,
            status: s.status,
            ...(name ? { name } : {}),
            createdAt: s.createdAt,
            ...(s.repos?.length ? { repos: s.repos.map((r) => r.url) } : {}),
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return text(rows);
    }),
  );

  server.registerTool(
    "sandbox_lifecycle",
    {
      title: "Manage sandbox lifecycle",
      description:
        "`pause` snapshots the sandbox and releases its compute (returns " +
        "the `snapshot` ref); `resume` brings a paused (or errored) one " +
        "back and returns it like `get_sandbox`; `snapshot` saves the disk " +
        "without pausing (returns `snapshot`, usable as `spec.source." +
        "snapshot`); `destroy` deletes it permanently and irreversibly, " +
        "with no confirmation. pause/resume can take minutes.",
      inputSchema: {
        id: z.string().describe("Sandbox id"),
        action: z.enum(["pause", "resume", "snapshot", "destroy"]),
      },
    },
    safeTool(async ({ id, action }) => {
      switch (action) {
        case "pause": {
          const { ref } = await runtime.pause(id);
          return text({ id, status: "paused", snapshot: ref });
        }
        case "resume":
          // No files/env overrides via MCP (unlike the HTTP route, which
          // also refreshes the owner's git credentials from a resume body) —
          // plain resume; the persisted spec + last-known files still apply.
          return text(sandboxView(await runtime.resume(id)));
        case "snapshot": {
          const { ref } = await runtime.snapshot(id);
          return text({ id, snapshot: ref });
        }
        case "destroy":
          await runtime.destroy(id);
          return text({ id, status: "destroyed" });
      }
    }),
  );

  server.registerTool(
    "exec",
    {
      title: "Exec",
      description:
        "Run a one-shot shell command in a running sandbox and return " +
        "`exitCode`, `stdout` and `stderr`. A non-zero exit code is a " +
        "normal result, not an error. Runs as the `dev` user in its home " +
        "by default. Output is cut to its last `maxOutputChars` " +
        "(`truncated: true` when so). For anything long-running or " +
        "that outlives the call, use `manage_process` or `send_prompt` " +
        "instead of a long `timeoutMs`.",
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
            `Keep at most this many trailing characters of each of stdout ` +
              `and stderr (default ${EXEC_DEFAULT_MAX_CHARS}).`,
          ),
      },
    },
    safeTool(async ({ id, maxOutputChars, timeoutMs, ...req }) => {
      const result = await runtime.exec(id, {
        ...req,
        timeoutMs: timeoutMs ?? EXEC_DEFAULT_TIMEOUT_MS,
      });
      const max = maxOutputChars ?? EXEC_DEFAULT_MAX_CHARS;
      const stdout = keepTail(result.stdout, max);
      const stderr = keepTail(result.stderr, max);
      return text({
        exitCode: result.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
      });
    }),
  );

  server.registerTool(
    "manage_process",
    {
      title: "Manage process",
      description:
        "Start, stop, restart, or read the logs of a supervised process in " +
        "a running sandbox. `name` comes from `get_sandbox` `processes`. " +
        "`start` returns before the process is ready: poll `get_sandbox`. " +
        "`logs` returns the most recent output (`truncated: true` when " +
        "older output was cut).",
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
    },
    safeTool(async ({ id, name, action, maxChars }) => {
      switch (action) {
        case "logs":
          return text({
            name,
            ...(await readLogTail(
              (offset, limit) => runtime.processLogs(id, name, offset, limit),
              maxChars ?? LOGS_DEFAULT_MAX_CHARS,
            )),
          });
        case "start":
          await runtime.processAction(id, name, "start");
          return text({ name, status: "started" });
        case "stop":
          await runtime.processAction(id, name, "stop");
          return text({ name, status: "stopped" });
        case "restart":
          await runtime.processAction(id, name, "stop");
          await runtime.processAction(id, name, "start");
          return text({ name, status: "restarted" });
      }
    }),
  );

  server.registerTool(
    "patch_files",
    {
      title: "Write files",
      description:
        "Write (create or overwrite) files in a running sandbox. Returns " +
        "how many were `written` and a `failed` list with the reason for " +
        "each file that could not be written (an error result when any " +
        "failed). Running processes are not restarted: use " +
        "`manage_process` action=restart if they need to reload.",
      inputSchema: {
        id: z.string().describe("Sandbox id"),
        files: z
          .array(
            z.object({
              path: z.string().describe("Absolute path in the sandbox"),
              content: z.string().describe("Full file content (UTF-8)"),
              mode: z
                .string()
                .optional()
                .describe('Octal permission string, e.g. "644" or "755"'),
              owner: z
                .enum(["dev", "root"])
                .optional()
                .describe("File owner (default dev)"),
            }),
          )
          .min(1),
      },
    },
    safeTool(async ({ id, files }) => {
      const { results } = await runtime.patchFiles(id, files);
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
    "expose_port",
    {
      title: "Expose port",
      description:
        "Expose a port of a running sandbox after boot. `public` defaults " +
        "to true: a public https `url` (`<name>-<id>.<domain>`) is created " +
        "that anyone with the link can open. Pass public=false to only " +
        "record the port. On the local Docker backend nothing is exposed " +
        "and no `url` is returned.",
      inputSchema: {
        id: z.string().describe("Sandbox id"),
        name: z
          .string()
          .describe(
            "Port name; becomes the hostname prefix (lowercase, a-z0-9-)",
          ),
        port: z.number().int().min(1).max(65535),
        public: z
          .boolean()
          .optional()
          .describe("Create a public URL (default true)"),
      },
    },
    safeTool(async ({ id, name, port, public: isPublic }) => {
      await runtime.addPort(id, { name, port, public: isPublic });
      const state = await runtime.get(id);
      const url = state.urls.find((u) => u.name === name)?.url;
      return text({
        name,
        port,
        public: isPublic ?? true,
        ...(url ? { url } : {}),
      });
    }),
  );
}
