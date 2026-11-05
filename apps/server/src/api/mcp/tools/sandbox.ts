/**
 * Sandbox lifecycle tools: create, read, pause/resume/snapshot/fork, destroy.
 * Every tool calls the application layer (`sandboxOps`, api/app/), the same
 * one `/v1/*` uses: an MCP-spawned sandbox gets the same org secrets and
 * auto-injected toolboxes as the HTTP path, and every long op runs as a job in
 * the feed.
 *
 * Slow ops return at once (`create_sandbox`, `fork`) or after a bounded wait
 * (`pause`/`resume`/`snapshot`), never holding the call for minutes: MCP
 * clients commonly give up on a request around 60s, and a timed-out retry
 * must not boot a second sandbox. `get_sandbox` long-polls the outcome.
 *
 * Outputs are projections for an agent, not the runtime's wire types: the
 * generated credentials (agent password, pod IP, ssh host keys), annotation
 * maps and internal hashes never leave the server through this surface.
 * The tools that act inside a running sandbox are in `sandbox-io.ts`.
 */
import {
  CreateSandboxRequestSchema,
  SANDBOX_NAME_ANNOTATION,
  SANDBOX_NAME_MAX_LENGTH,
  type SandboxIdleSummary,
} from "@atelier/spec";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthUser } from "../../../control/index.ts";
import type { JobRecord } from "../../../runtime/index.ts";
import { ValidationError } from "../../../shared/errors.ts";
import type { BranchSetupResult } from "../../app/branch-setup.ts";
import { settledWithin } from "../../app/sandbox-ops.ts";
import type { ServerContainer } from "../../container.ts";
import {
  accessibleSandboxes,
  requireSandboxAccess,
} from "../../sandbox-guard.ts";
import { rejectParams, safeTool, text } from "../format.ts";
import { parseSpec } from "../validate.ts";
import { registerSandboxIoTools } from "./sandbox-io.ts";

/** MCP clients commonly time a request out at 60s; stay safely under it. */
const MAX_WAIT_SECONDS = 50;
/** `sandbox_lifecycle` waits this long for pause/resume/snapshot by default. */
const LIFECYCLE_DEFAULT_WAIT_SECONDS = 30;
const POLL_MS = 1000;

const STATUSES = ["creating", "running", "paused", "stopped", "error"] as const;

export interface RawUrl {
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

/** A branch switch's background build steps (`sandbox-setup` job), for an
 * agent: `running` means dependencies may still be stale. */
function setupView(job: JobRecord | undefined) {
  if (!job) return undefined;
  const warnings = (job.result as BranchSetupResult | undefined)?.warnings;
  const status =
    job.status === "queued" || job.status === "running"
      ? "running"
      : job.status === "succeeded"
        ? warnings?.length
          ? "warnings"
          : "done"
        : "failed";
  return {
    status,
    ...(job.metadata?.branch ? { branch: job.metadata.branch } : {}),
    jobId: job.id,
    ...(warnings?.length ? { warnings } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
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
    bootedFrom?: unknown;
  },
  verbose = false,
  idle?: SandboxIdleSummary,
  setup?: ReturnType<typeof setupView>,
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
    ...(state.bootedFrom ? { bootedFrom: state.bootedFrom } : {}),
    ...(idle ? { idle } : {}),
    ...(setup ? { setup } : {}),
    ...(verbose && state.metadata ? { metadata: state.metadata } : {}),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const waitSecondsSchema = (what: string, fallback: string) =>
  z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(
      `Block up to this many seconds (max ${MAX_WAIT_SECONDS}) ${what}. ` +
        `Default ${fallback}.`,
    );

export function registerSandboxTools(
  server: McpServer,
  container: ServerContainer,
  user: AuthUser,
): void {
  const { runtime, sandboxOps } = container;
  /** The access rule (control/sandbox-access.ts): a denied or unknown id is
   * a NOT_FOUND, like the HTTP routes. Every tool taking an id calls it. */
  const guard = (id: string) => requireSandboxAccess(container, user.id, id);

  server.registerTool(
    "get_sandbox",
    {
      title: "Get a sandbox, or list sandboxes",
      description:
        "With `id`: status, openable `urls` (`ready` = the process behind " +
        "it is up), `ssh` command, live `processes` (`manage_process` " +
        "takes their `name`) and `bootedFrom`. Only a `running` sandbox " +
        "accepts commands (exec/files/prompts resume a `paused` one on " +
        "their own). `waitSeconds` + `until` long-poll for a status, e.g. " +
        "after `create_sandbox`. `idle`: when the server auto-pauses it " +
        "(`pausesAt`; `mode: observe` = only would); " +
        "`sandbox_lifecycle` action=keep_awake postpones. `setup`: build " +
        "steps still running after a branch switch (status `running`: " +
        "dependencies may be stale, poll until `done`, or `warnings`). " +
        "Without `id`: " +
        "`{sandboxes}`, newest first (id, status, name, repos, createdAt, " +
        "idle), optionally filtered by `status` and `metadata`.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe(
            "Sandbox to read (from create_sandbox / this tool's list). " +
              "Omit to list sandboxes.",
          ),
        status: z
          .enum(STATUSES)
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
        waitSeconds: waitSecondsSchema(
          "until the sandbox reaches `until` (or settles elsewhere: error, " +
            "stopped, paused with no resume running); one sandbox only",
          "0 (return at once)",
        ),
        until: z
          .enum(STATUSES)
          .optional()
          .describe(
            "With waitSeconds: the status to wait for (default running)",
          ),
      },
      outputSchema: {
        id: z.string().optional(),
        status: z.string().optional(),
        sandboxes: z.array(z.object({}).passthrough()).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safeTool(
      "get_sandbox",
      async ({ id, status, metadata, verbose, waitSeconds, until }) => {
        if (id !== undefined) {
          rejectParams(
            { status, metadata },
            "only filters the sandbox list (omit `id` to list)",
          );
          // A create job that has not landed its record yet is `creating`,
          // not "not found".
          const pending = () => sandboxOps.pendingCreate(user.id, id);
          if (runtime.getLabels(id) !== undefined || !pending()) guard(id);

          const target = until ?? "running";
          const deadline = Date.now() + (waitSeconds ?? 0) * 1000;
          for (;;) {
            const current = runtime.getStatus(id);
            const settled =
              current === undefined
                ? !pending()
                : current === target ||
                  current === "error" ||
                  current === "stopped" ||
                  (current === "paused" && !sandboxOps.isResuming(id));
            if (settled || Date.now() >= deadline) break;
            await sleep(POLL_MS);
          }
          if (runtime.getStatus(id) === undefined) {
            if (pending()) return text({ id, status: "creating" });
            guard(id);
          }
          return text(
            sandboxView(
              await runtime.get(id),
              verbose,
              container.idle.summary(id),
              setupView(sandboxOps.latestSetup(id)),
            ),
          );
        }

        rejectParams(
          { verbose, waitSeconds, until },
          "only applies when reading one sandbox (pass `id`)",
        );
        const all = container.idle.decorate(
          accessibleSandboxes(container, user.id, runtime.list(metadata)),
        );
        const rows = (status ? all.filter((s) => s.status === status) : all)
          .map((s) => {
            const name = s.annotations?.[SANDBOX_NAME_ANNOTATION];
            return {
              id: s.id,
              status: s.status,
              ...(name ? { name } : {}),
              createdAt: s.createdAt,
              ...(s.repos?.length ? { repos: s.repos.map((r) => r.url) } : {}),
              ...(s.idle ? { idle: s.idle } : {}),
            };
          })
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return text({ sandboxes: rows });
      },
    ),
  );

  server.registerTool(
    "create_sandbox",
    {
      title: "Create sandbox",
      description:
        "Start booting a sandbox and return at once `{id, status: " +
        "'creating', jobId}` (a minute or more to boot). Then `get_sandbox` " +
        "with `waitSeconds` and `until=running`. Pass `name` to make a " +
        "retry safe: your existing sandbox with that name is returned " +
        "(`existing: true`) instead of a second one. Your org's secrets " +
        "and auto-included toolboxes apply automatically; see `whoami` for " +
        "images, toolboxes and prebuilds. Minimal: " +
        '`{"spec":{"source":{"image":"dev-base"}}}`.',
      inputSchema: {
        spec: z
          .record(z.string(), z.unknown())
          .describe(
            "SandboxSpec. `source` is required: {image} (a base image name) " +
              "or {snapshot} (a prebuild/snapshot `ref`). Optional: " +
              "`resources` {vcpus, memoryMb, diskGb} (server defaults when " +
              'omitted), `env` (name → string or {"$secret":"NAME"} — the ' +
              "only way to pass a secret), `files` [{path, content, mode?, " +
              "owner?}], `processes` [{name, command, cwd?, env?, primary?, " +
              "readiness?, restart?, lazy?}], `ports` [{name, port, " +
              "public?, auth?}], `hooks`, `caches`, `timeoutSeconds`, " +
              "`metadata`, `annotations`. Do NOT put `toolboxes`, `prebuild`, " +
              "`repo` or `orgId` in here; they are separate arguments.",
          ),
        name: z
          .string()
          .min(1)
          .max(SANDBOX_NAME_MAX_LENGTH)
          .optional()
          .describe("Display name; also the idempotency key for retries"),
        toolboxes: z
          .array(z.string())
          .optional()
          .describe(
            "Extra toolbox selectors to apply (`selector` from `whoami`, " +
              "e.g. tb/<toolboxId>). Auto-included toolboxes are applied " +
              "without listing them.",
          ),
        prebuild: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "A PrebuildSpec to bake (cached when unchanged) and use as the " +
              "boot source instead of `spec.source`.",
          ),
        repo: z
          .object({ url: z.string(), branch: z.string().optional() })
          .optional()
          .describe(
            "A git repo to boot from: a prebuild of that branch is reused; " +
              "else the repo's default-branch prebuild boots switched to the " +
              "branch, its build steps re-running in the background " +
              "(`get_sandbox` `setup`); else one is baked on " +
              "`spec.source.image`. Not with `prebuild` or a " +
              "`spec.source.snapshot`.",
          ),
        orgId: z
          .string()
          .optional()
          .describe(
            "Organization to run in (`orgs[].orgId` from `whoami`). " +
              "Default: `defaultOrgId`.",
          ),
      },
      outputSchema: {
        id: z.string(),
        status: z.string(),
        jobId: z.string().optional(),
        existing: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeTool(
      "create_sandbox",
      async ({ spec, name, toolboxes, prebuild, repo, orgId }) => {
        if (name) {
          const existing = sandboxOps.findNamed(user.id, name);
          if (existing) return text({ ...existing, existing: true });
        }
        const annotations = spec.annotations;
        if (
          annotations !== undefined &&
          (typeof annotations !== "object" || annotations === null)
        ) {
          throw new ValidationError("`spec.annotations` must be an object");
        }
        // Same boundary validation Elysia's schema guard gives the HTTP route.
        const body = parseSpec(
          CreateSandboxRequestSchema,
          {
            ...spec,
            ...(name
              ? {
                  annotations: {
                    ...annotations,
                    [SANDBOX_NAME_ANNOTATION]: name,
                  },
                }
              : {}),
            ...(toolboxes ? { toolboxes } : {}),
            ...(prebuild ? { prebuild } : {}),
            ...(repo ? { repo } : {}),
            ...(orgId ? { orgId } : {}),
          },
          "CreateSandboxRequest",
        );
        const job = sandboxOps.startCreate(user, body);
        return text({
          id: job.metadata?.sandboxId,
          status: "creating",
          jobId: job.id,
        });
      },
    ),
  );

  server.registerTool(
    "sandbox_lifecycle",
    {
      title: "Manage sandbox lifecycle",
      description:
        "`pause` snapshots the sandbox and releases its compute; `resume` " +
        "brings a paused (or errored) one back; `snapshot` saves the disk " +
        "without pausing (the ref is usable as `spec.source.snapshot`); " +
        "`fork` snapshots it and boots an independent copy owned by you, " +
        "same org, returning `{id, status:'creating', jobId}` at once " +
        "(then `get_sandbox` with `waitSeconds`); `keep_awake` exempts it " +
        "from idle auto-pause for `hours` (0 clears), within the server's " +
        "limit. pause/resume/snapshot wait up to `waitSeconds` and return " +
        "the result (`snapshot` ref, status); if still working you get " +
        "`{id, status:'working', jobId}`: poll `get_sandbox` with `until`.",
      inputSchema: {
        id: z.string().describe("Sandbox id"),
        action: z.enum(["pause", "resume", "snapshot", "fork", "keep_awake"]),
        name: z
          .string()
          .max(SANDBOX_NAME_MAX_LENGTH)
          .optional()
          .describe("fork only: display name of the copy (default: none)"),
        hours: z
          .number()
          .min(0)
          .optional()
          .describe("keep_awake only: how long, in hours (0 clears)"),
        waitSeconds: waitSecondsSchema(
          "for pause/resume/snapshot to finish",
          String(LIFECYCLE_DEFAULT_WAIT_SECONDS),
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeTool(
      "sandbox_lifecycle",
      async ({ id, action, name, hours, waitSeconds }) => {
        guard(id);
        if (action !== "fork") rejectParams({ name }, "only applies to `fork`");
        if (action !== "keep_awake") {
          rejectParams({ hours }, "only applies to `keep_awake`");
        }
        if (action === "fork" || action === "keep_awake") {
          rejectParams(
            { waitSeconds },
            "only applies to pause/resume/snapshot",
          );
        }
        switch (action) {
          case "keep_awake": {
            if (hours === undefined) {
              throw new ValidationError("keep_awake needs `hours` (0 clears)");
            }
            const until =
              hours === 0
                ? null
                : new Date(Date.now() + hours * 3_600_000).toISOString();
            const stored = sandboxOps.keepAwake(id, until);
            return text({ id, keepAwakeUntil: stored ?? null });
          }
          case "fork": {
            const job = sandboxOps.startFork(user, id, { name });
            return text({
              id: job.metadata?.sandboxId,
              status: "creating",
              jobId: job.id,
              forkOf: id,
            });
          }
          default: {
            const { job, done } = sandboxOps.startLifecycle(
              action,
              id,
              user.id,
            );
            const wait = (waitSeconds ?? LIFECYCLE_DEFAULT_WAIT_SECONDS) * 1000;
            const outcome = await settledWithin(done, wait);
            if (!outcome.settled) {
              return text({ id, status: "working", jobId: job.id });
            }
            if (action === "resume") {
              return text(sandboxView(await runtime.get(id)));
            }
            const { ref } = outcome.value as { ref: string };
            return text(
              action === "pause"
                ? { id, status: "paused", snapshot: ref }
                : { id, snapshot: ref },
            );
          }
        }
      },
    ),
  );

  server.registerTool(
    "destroy_sandbox",
    {
      title: "Destroy sandbox",
      description:
        "Delete a sandbox permanently and irreversibly, with no confirmation.",
      inputSchema: { id: z.string().describe("Sandbox id") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeTool("destroy_sandbox", async ({ id }) => {
      guard(id);
      await sandboxOps.destroy(id, user.id);
      return text({ id, status: "destroyed" });
    }),
  );

  registerSandboxIoTools(server, container, user);
}
