/**
 * The admin MCP (`/mcp/admin`, server admins only): the tools for curating
 * the environment (prebuilds, toolboxes and their versions, base images,
 * server config). Agents doing everyday work never connect it; `whoami` on
 * the sandbox MCP already lists the toolboxes and prebuilds they can use.
 *
 * Several tools mix reads and writes (`list` next to `delete`), so they carry
 * the conservative annotations of their most dangerous action.
 *
 * `manage_toolbox` `action=refresh` runs a toolbox's update commands on the
 * server and returns at once; the outcome lands in `list` as `refresh.last`.
 * `manage_prebuilds` `create`/`refresh` return at once with a `jobId` too.
 */
import {
  type PrebuildRecord,
  PrebuildSpecSchema,
  type ToolboxConfig,
  ToolboxConfigInputSchema,
  ToolboxConfigPatchSchema,
  type ToolboxVersion,
  toolboxArtifactName,
} from "@atelier/spec";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthUser } from "../../../control/index.ts";
import { NotFoundError, ValidationError } from "../../../shared/errors.ts";
import type { ServerContainer } from "../../container.ts";
import { readableOrgIds, resolveToolboxOrg } from "../../toolbox-access.ts";
import {
  activeRefreshJob,
  startToolboxRefresh,
} from "../../toolbox-refresh.ts";
import { keepTail, safeTool, text } from "../format.ts";
import { parseSpec } from "../validate.ts";

/** The tail of an image build log returned by `manage_images`. */
const LOG_CHARS = 8_000;

const detailSchema = z
  .enum(["simple", "advanced"])
  .optional()
  .describe(
    "simple (default): what you need to pick and use an item. advanced: " +
      "also the build recipe, hashes, provenance and version history.",
  );

// ── prebuild views ──────────────────────────────────────────────────────

/** What an agent needs to pick a prebuild: its ref, what it contains, its
 * name and labels (`metadata`, e.g. `workspace`), the dev servers every
 * sandbox from it gets (`processes`, without their env) and the URLs they
 * serve (`ports`), and when it was baked. The base image, hash and build
 * recipe (and the env values / file contents in it, which can be literal
 * secrets) stay out; the console and `GET /v1/prebuilds` have the full
 * record. */
function prebuildView(p: PrebuildRecord) {
  const metadata = p.metadata ?? p.spec?.metadata;
  const processes = p.spec?.processes ?? [];
  const ports = p.spec?.ports ?? [];
  return {
    ref: p.ref,
    createdAt: p.createdAt,
    repos: (p.spec?.repos ?? []).map((r) => ({
      url: r.url,
      ...(r.branch ? { branch: r.branch } : {}),
    })),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(processes.length > 0
      ? {
          processes: processes.map((proc) => ({
            name: proc.name,
            command: proc.command,
            ...(proc.cwd ? { cwd: proc.cwd } : {}),
            ...(proc.lazy ? { lazy: true } : {}),
          })),
        }
      : {}),
    ...(ports.length > 0
      ? {
          ports: ports.map((port) => ({
            name: port.name,
            port: port.port,
            ...(port.public ? { public: true } : {}),
          })),
        }
      : {}),
  };
}

// ── toolbox views ───────────────────────────────────────────────────────

type Control = ServerContainer["control"];

/** orgId → the caller's role there. */
function rolesOf(control: Control, userId: string): Map<string, string> {
  return new Map(
    control.orgMemberService
      .getByUserId(userId)
      .map((m) => [m.orgId, m.role] as const),
  );
}

/** Where an auto-included toolbox lands (see `resolveSpawnToolboxes`): only
 * into sandboxes created in its org. */
/** The `versionId` an action needs, or a `ValidationError`. */
function requireVersionId(versionId: string | null | undefined): string {
  if (!versionId) throw new ValidationError("this action requires `versionId`");
  return versionId;
}

function appliesTo(tb: ToolboxConfig) {
  return tb.autoInject ? "sandboxes-in-org" : "explicit-only";
}

function versionView(v: ToolboxVersion) {
  return {
    id: v.id,
    label: v.label,
    ref: v.ref,
    kind: v.provenance.kind,
    description: v.description,
    createdAt: v.createdAt,
    ...(v.provenance.kind === "captured"
      ? { capturedFrom: v.provenance.capturedFrom }
      : {}),
    ...(v.provenance.sourceImage
      ? { sourceImage: v.provenance.sourceImage }
      : {}),
  };
}

/** A toolbox's refresh setup and last outcome, or undefined when it has
 * none (no update commands, schedule or past refresh). */
function refreshView(tb: ToolboxConfig, running: () => boolean) {
  if (tb.refresh.length === 0 && !tb.refreshSchedule && !tb.lastRefresh) {
    return undefined;
  }
  const last = tb.lastRefresh;
  return {
    commands: tb.refresh,
    ...(tb.refreshSchedule ? { schedule: tb.refreshSchedule } : {}),
    ...(tb.nextRefreshAt ? { nextRunAt: tb.nextRefreshAt } : {}),
    running: running(),
    ...(last
      ? {
          last: {
            at: last.at,
            trigger: last.trigger,
            outcome: last.outcome,
            ...(last.versionId ? { versionId: last.versionId } : {}),
            ...(last.pinned !== undefined ? { pinned: last.pinned } : {}),
            ...(last.error ? { error: last.error } : {}),
          },
        }
      : {}),
  };
}

function toolboxView(
  control: Control,
  tb: ToolboxConfig,
  roles: Map<string, string>,
  advanced: boolean,
  isRefreshing: (toolboxId: string) => boolean,
) {
  // Same visibility as `GET /api/toolboxes/:id/versions`: any member of the
  // toolbox's org (owners and members alike).
  const privileged = roles.has(tb.orgId);
  const versions = privileged
    ? control.toolboxVersionService.listByToolbox(tb.id)
    : undefined;
  const activeId = control.toolboxService.getActiveVersionId(tb.id);
  const active = activeId
    ? versions?.find((v) => v.id === activeId)
    : undefined;
  const refresh = refreshView(tb, () => isRefreshing(tb.id));

  return {
    selector: toolboxArtifactName(tb),
    id: tb.id,
    slug: tb.slug,
    description: tb.description,
    orgId: tb.orgId,
    autoInclude: tb.autoInject,
    appliesTo: appliesTo(tb),
    ...(tb.harness ? { harness: tb.harness } : {}),
    activeVersion: activeId
      ? { id: activeId, ...(active ? { label: active.label } : {}) }
      : null,
    ...(versions ? { versionCount: versions.length } : {}),
    canManage: privileged,
    ...(refresh ? { refresh } : {}),
    ...(advanced
      ? {
          ...(tb.source ? { source: tb.source } : {}),
          build: tb.build,
          paths: tb.paths,
          ...(tb.processes?.length ? { processes: tb.processes } : {}),
          ...(tb.ports?.length ? { ports: tb.ports } : {}),
          ...(tb.files?.length
            ? { files: tb.files.map(({ path }) => path) }
            : {}),
          createdAt: tb.createdAt,
          updatedAt: tb.updatedAt,
          ...(versions
            ? {
                versions: [...versions]
                  .sort((a, b) => b.label - a.label)
                  .map(versionView),
              }
            : {}),
        }
      : {}),
  };
}

/** Injection order: auto-included toolboxes (oldest first) before the
 * explicit-only ones. */
function injectionRank(tb: ToolboxConfig): number {
  return tb.autoInject ? 0 : 1;
}

export function registerAdminTools(
  server: McpServer,
  container: ServerContainer,
  user: AuthUser,
): void {
  const { runtime, control, toolboxOps, sandboxOps, images } = container;
  const isRefreshing = (toolboxId: string) =>
    activeRefreshJob(container, toolboxId) !== undefined;

  // ── prebuilds ────────────────────────────────────────────────────────
  server.registerTool(
    "manage_prebuilds",
    {
      title: "Manage prebuilds",
      description:
        "List, create, refresh or delete prebuilds: snapshots of a " +
        "sandbox's expensive one-time setup (cloned repos, installs), baked " +
        "once and shared server-wide (`ref` goes in `spec.source.snapshot` " +
        "of `create_sandbox`). `list` returns `{prebuilds}` newest first: " +
        "{ref, createdAt, repos, metadata?, processes?, ports?}. `create` " +
        "and `refresh` (rebuild `ref` from its recipe, ignoring the cache) " +
        "bake in the background: they return `{jobId}` at once, then `list` " +
        "shows the new `ref`. `delete` refuses a prebuild that a sandbox " +
        "boots from or another is chained on.",
      inputSchema: {
        action: z.enum(["list", "create", "refresh", "delete"]),
        repo: z
          .string()
          .optional()
          .describe(
            "action=list: only prebuilds with a repo URL containing this",
          ),
        spec: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "action=create: a PrebuildSpec. `source` is required ({image} " +
              "or {snapshot} to chain on another prebuild); optional " +
              "`repos` [{url, branch?, clonePath}], `build` (shell steps, " +
              "in order), `files`, `env` (build steps only), `processes` " +
              "and `ports` (dev servers every sandbox from it gets), " +
              "`metadata`.",
          ),
        ref: z
          .string()
          .optional()
          .describe("action=refresh|delete: the prebuild ref"),
        force: z
          .boolean()
          .optional()
          .describe(
            "action=create: rebuild even if an identical one is cached",
          ),
      },
      outputSchema: {
        prebuilds: z.array(z.object({}).passthrough()).optional(),
        jobId: z.string().optional(),
        status: z.string().optional(),
        ref: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    safeTool("manage_prebuilds", async ({ action, repo, spec, ref, force }) => {
      switch (action) {
        case "list":
          return text({
            prebuilds: runtime
              .listPrebuilds()
              .filter(
                (p) =>
                  !repo || p.spec?.repos?.some((r) => r.url.includes(repo)),
              )
              .map(prebuildView),
          });
        case "create": {
          if (!spec) {
            throw new ValidationError("action=create requires `spec`");
          }
          const prebuildSpec = parseSpec(
            PrebuildSpecSchema,
            spec,
            "PrebuildSpec",
          );
          const job = sandboxOps.startPrebuild(user, prebuildSpec, { force });
          return text({ jobId: job.id, status: "started" });
        }
        case "refresh": {
          if (!ref) throw new ValidationError("action=refresh requires `ref`");
          const recipe = runtime.listPrebuilds().find((p) => p.ref === ref);
          if (!recipe) throw new NotFoundError("Prebuild", ref);
          if (!recipe.spec) {
            throw new ValidationError(`prebuild ${ref} has no stored recipe`);
          }
          const job = sandboxOps.startPrebuild(user, recipe.spec, {
            force: true,
          });
          return text({ ref, jobId: job.id, status: "started" });
        }
        case "delete":
          if (!ref) throw new ValidationError("action=delete requires `ref`");
          await runtime.deletePrebuild(ref);
          return text({ ref, status: "deleted" });
      }
    }),
  );

  // ── toolboxes (+ versions — the toolset merge point) ──────────────────
  server.registerTool(
    "manage_toolbox",
    {
      title: "Manage toolbox",
      description:
        "A toolbox bundles tools and config baked into sandboxes. " +
        "`list` returns `{toolboxes}` of every org you belong to (narrow " +
        "with `owner`): `selector`, `autoInclude` (added to new sandboxes " +
        "of its org automatically; `explicit-only` ones only via " +
        "`create_sandbox` `toolboxes`), `activeVersion` (the pinned build; " +
        "null: built from the recipe at spawn), `refresh` state. " +
        "detail=advanced adds the recipe and version history (the " +
        "`versionId`s). Other actions: `create`/`update`/`delete`; " +
        "`capture` a sandbox's toolbox paths as a new private version; " +
        "`refresh` (the server runs `config.refresh` commands over the " +
        "current version in a throwaway pod, saves and pins the result; " +
        "returns `{jobId}` at once, outcome in `list` `refresh.last`); " +
        "`pin_version` (null unpins), `publish`, `delete_version`; " +
        "`transfer` moves toolboxes/secrets between orgs you own/belong to " +
        "(`dryRun` previews). To roll a captured version out org-wide: " +
        "`capture`, `publish`, `pin_version`.",
      inputSchema: {
        action: z.enum([
          "list",
          "create",
          "update",
          "delete",
          "capture",
          "refresh",
          "pin_version",
          "publish",
          "delete_version",
          "transfer",
        ]),
        owner: z
          .string()
          .optional()
          .describe(
            "list: all (default) | me | org:<orgId>. create: me (default, " +
              "your personal org) | org:<orgId>",
          ),
        detail: detailSchema,
        id: z
          .string()
          .optional()
          .describe(
            "Toolbox id (from list); every action but list, create, transfer",
          ),
        config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "create/update: the toolbox. create requires `slug` (lowercase-" +
              "kebab, immutable), `description` (max 200), `build` " +
              "(shell steps, max 100) and `paths` (home-relative paths to " +
              "capture, max 100); optional `source` ({image}|{snapshot}), " +
              "`harness` (e.g. pi, opencode), `processes`, `ports`, `files` " +
              "([{path, content|{$secret}, mode?, owner?}]), " +
              "`autoInject` (default true), `refresh` (update commands a " +
              "refresh runs, max 100), `refreshSchedule` (cron, UTC, e.g. " +
              "`0 4 * * *` or `@daily`, at most hourly; needs `refresh`). " +
              "update takes any of them except `slug`; `source`/`harness`/" +
              "`refreshSchedule` null clears.",
          ),
        sandboxId: z
          .string()
          .optional()
          .describe("action=capture: the sandbox to capture the paths from"),
        note: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("action=capture: what this version is (max 200 chars)"),
        versionId: z
          .union([z.string(), z.null()])
          .optional()
          .describe(
            "pin_version (null unpins), publish, delete_version: a version " +
              "id from `list` detail=advanced or `capture`",
          ),
        from: z.string().optional().describe("action=transfer: source orgId"),
        to: z.string().optional().describe("action=transfer: target orgId"),
        toolboxIds: z
          .array(z.string())
          .optional()
          .describe("action=transfer: toolbox ids to move"),
        secretIds: z
          .array(z.string())
          .optional()
          .describe(
            "action=transfer: secret ids to move (needs ownership of `to`)",
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe("action=transfer: only preview what could move"),
      },
      outputSchema: {
        toolboxes: z.array(z.object({}).passthrough()).optional(),
        id: z.string().optional(),
        status: z.string().optional(),
        jobId: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    safeTool(
      "manage_toolbox",
      async ({
        action,
        owner,
        detail,
        id,
        config,
        sandboxId,
        note,
        versionId,
        from,
        to,
        toolboxIds,
        secretIds,
        dryRun,
      }) => {
        const roles = rolesOf(control, user.id);

        if (action === "list") {
          const scopes =
            owner === undefined || owner === "all"
              ? readableOrgIds(control, user.id)
              : [resolveToolboxOrg(control, user.id, owner)];
          const advanced = detail === "advanced";
          return text({
            toolboxes: scopes
              .flatMap((scope) => control.toolboxService.list(scope))
              .sort(
                (a, b) =>
                  injectionRank(a) - injectionRank(b) ||
                  a.createdAt.localeCompare(b.createdAt),
              )
              .map((tb) =>
                toolboxView(control, tb, roles, advanced, isRefreshing),
              ),
          });
        }

        if (action === "transfer") {
          if (!from || !to) {
            throw new ValidationError(
              "action=transfer requires `from` and `to`",
            );
          }
          if (dryRun) {
            return text(toolboxOps.previewTransfer(user.id, from, to));
          }
          return text(
            toolboxOps.transfer(user.id, from, to, {
              toolboxes: toolboxIds ?? [],
              secrets: secretIds ?? [],
            }),
          );
        }

        if (action === "create") {
          if (!config) {
            throw new ValidationError("action=create requires `config`");
          }
          const input = parseSpec(
            ToolboxConfigInputSchema,
            config,
            "ToolboxConfigInput",
          );
          return text(
            toolboxView(
              control,
              toolboxOps.create(user.id, owner, input),
              roles,
              false,
              isRefreshing,
            ),
          );
        }

        if (!id) throw new ValidationError(`action=${action} requires \`id\``);
        const tb = toolboxOps.authorize(user.id, id);

        switch (action) {
          case "update": {
            if (!config) {
              throw new ValidationError("action=update requires `config`");
            }
            const patch = parseSpec(
              ToolboxConfigPatchSchema,
              config,
              "ToolboxConfigPatch",
            );
            return text(
              toolboxView(
                control,
                toolboxOps.update(user.id, id, patch),
                roles,
                false,
                isRefreshing,
              ),
            );
          }

          case "delete":
            toolboxOps.delete(user.id, id);
            return text({ id, status: "deleted" });

          case "refresh": {
            const { job, started } = startToolboxRefresh(container, tb.id, {
              trigger: "manual",
              userId: user.id,
            });
            return text({
              id,
              jobId: job.id,
              status: started ? "started" : "already-running",
            });
          }

          case "pin_version": {
            if (versionId === undefined) {
              throw new ValidationError(
                "action=pin_version requires `versionId` (or null to unpin)",
              );
            }
            return text({
              id,
              activeVersionId: toolboxOps.pin(user.id, id, versionId),
            });
          }

          case "publish":
            return text({
              id,
              ...toolboxOps.publish(user.id, id, requireVersionId(versionId)),
            });

          case "delete_version": {
            const vid = requireVersionId(versionId);
            toolboxOps.deleteVersion(user.id, id, vid);
            return text({ id, versionId: vid, status: "deleted" });
          }

          case "capture": {
            if (!sandboxId || !note) {
              throw new ValidationError(
                "action=capture requires `sandboxId` and `note`",
              );
            }
            const version = await toolboxOps.captureAndWait(user.id, id, {
              sandboxId,
              description: note,
            });
            return text({
              id,
              versionId: version.id,
              label: version.label,
              ref: version.ref,
              private: true,
            });
          }
        }
      },
    ),
  );

  // ── base images ───────────────────────────────────────────────────────
  server.registerTool(
    "manage_images",
    {
      title: "Manage base images",
      description:
        "Base images sandboxes boot from. `list` returns `{images, seeds}`: " +
        "the built/registered images (name, status, ref, error) and the " +
        "embedded seeds that `rebuild` takes (e.g. after a dependency " +
        "update; a seed's parents must be ready). `rebuild` starts the " +
        "build and returns the image record (`building`); poll with `logs` " +
        "or `list`. `logs` returns an image's build log tail.",
      inputSchema: {
        action: z.enum(["list", "rebuild", "logs"]),
        name: z
          .string()
          .optional()
          .describe("rebuild: the seed id; logs: the image name"),
        force: z
          .boolean()
          .optional()
          .describe("rebuild: rebuild even if the image is already built"),
      },
      outputSchema: {
        images: z.array(z.object({}).passthrough()).optional(),
        seeds: z.array(z.object({}).passthrough()).optional(),
        name: z.string().optional(),
        status: z.string().optional(),
        log: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safeTool("manage_images", async ({ action, name, force }) => {
      switch (action) {
        case "list":
          return text({
            images: images.listImages().map((i) => ({
              name: i.name,
              status: i.status,
              provenance: i.provenance,
              ...(i.ref ? { ref: i.ref } : {}),
              ...(i.error ? { error: i.error } : {}),
              updatedAt: i.updatedAt,
            })),
            seeds: images.listTemplates().map((seed) => ({
              id: seed.id,
              dependsOn: seed.dependsOn,
            })),
          });
        case "rebuild": {
          if (!name)
            throw new ValidationError("action=rebuild requires `name`");
          const record = await images.buildSeed(name, { force });
          return text({ name: record.name, status: record.status });
        }
        case "logs": {
          if (!name) throw new ValidationError("action=logs requires `name`");
          const record = images.getImage(name);
          if (!record) throw new NotFoundError("Image", name);
          return text({
            name,
            status: record.status,
            log: keepTail(images.getBuildLog(name), LOG_CHARS).text,
          });
        }
      }
    }),
  );

  // ── server config ─────────────────────────────────────────────────────
  server.registerTool(
    "server_config",
    {
      title: "Server config",
      description:
        "The server's runtime config. `list` returns `{entries}` (key, " +
        "description, type, value, default, `locked` when set by env/file); " +
        "`get` one `key`; `set` a `key` to `value` (a boolean, number or " +
        "string; takes effect live).",
      inputSchema: {
        action: z.enum(["list", "get", "set"]),
        key: z.string().optional().describe("get/set: the config key"),
        value: z
          .union([z.boolean(), z.number(), z.string()])
          .optional()
          .describe("set: the new value"),
      },
      outputSchema: {
        entries: z.array(z.object({}).passthrough()).optional(),
        key: z.string().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safeTool("server_config", async ({ action, key, value }) => {
      const service = control.serverConfigService;
      switch (action) {
        case "list":
          return text({ entries: service.list() });
        case "get": {
          if (!key) throw new ValidationError("action=get requires `key`");
          const entry = service.list().find((e) => e.key === key);
          if (!entry) throw new NotFoundError("Config key", key);
          return text({ ...entry });
        }
        case "set": {
          if (!key || value === undefined) {
            throw new ValidationError("action=set requires `key` and `value`");
          }
          return text({ key, value: service.set(key, value) });
        }
      }
    }),
  );
}
