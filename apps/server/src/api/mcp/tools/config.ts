/**
 * Control-plane config tools: prebuilds and toolboxes (+ their versions, the
 * toolbox/toolset merge point — see `list_toolboxes`). The "configure your
 * prebuilt/toolbox from your own dev env" surface.
 *
 * Server-wide config is deliberately not exposed: it is operator business
 * (console / CLI), and no agent flow needs it.
 *
 * `list_toolboxes` comes in two sizes: the default ("simple") is what an
 * agent needs to pick and act on a toolbox; `detail: "advanced"` adds the
 * recipe and version history (ids that `pin_version` takes).
 */
import {
  type PrebuildRecord,
  PrebuildSpecSchema,
  type ToolboxConfig,
  ToolboxConfigInputSchema,
  ToolboxConfigPatchSchema,
  type ToolboxOwner,
  type ToolboxVersion,
} from "@atelier/spec";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthUser } from "../../../control/index.ts";
import { recipeFingerprint } from "../../../control/index.ts";
import { ValidationError } from "../../../shared/errors.ts";
import { pruneToolboxVersions, type ServerContainer } from "../../container.ts";
import {
  requireSandboxAccess,
  requireSourceAccess,
} from "../../sandbox-guard.ts";
import {
  readableOwners,
  requireToolboxOwnerAccess,
  resolveOwner,
} from "../../toolbox-access.ts";
import { safeTool, text } from "../format.ts";
import { parseSpec } from "../validate.ts";

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
 * secrets) stay out; the console, CLI and `GET /v1/prebuilds` have the full
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

function toolboxSelector(
  tb: Pick<ToolboxConfig, "ownerType" | "ownerId" | "slug">,
) {
  return `tb/${tb.ownerType}/${tb.ownerId}/${tb.slug}`;
}

/** Where an auto-included toolbox lands (see `resolveToolboxRefs`): a user's
 * own toolboxes go into every sandbox they create; an org's only into
 * sandboxes created in that org. */
function appliesTo(tb: ToolboxConfig) {
  if (!tb.autoInject) return "explicit-only";
  return tb.ownerType === "org" ? "sandboxes-in-org" : "every-sandbox";
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

function toolboxView(
  control: Control,
  tb: ToolboxConfig,
  roles: Map<string, string>,
  advanced: boolean,
) {
  const isOrg = tb.ownerType === "org";
  const role = isOrg ? roles.get(tb.ownerId) : undefined;
  // Same visibility as `GET /api/toolboxes/:id/versions`: your own
  // toolboxes always, an org's only for its owners/admins.
  const privileged = !isOrg || role === "owner" || role === "admin";
  const versions = privileged
    ? control.toolboxVersionService.listByToolbox(tb.id)
    : undefined;
  const activeId = control.toolboxService.getActiveVersionId(tb.id);
  const active = activeId
    ? versions?.find((v) => v.id === activeId)
    : undefined;

  return {
    selector: toolboxSelector(tb),
    id: tb.id,
    slug: tb.slug,
    description: tb.description,
    scope: tb.ownerType,
    ...(isOrg ? { orgId: tb.ownerId } : {}),
    autoInclude: tb.autoInject,
    appliesTo: appliesTo(tb),
    ...(tb.harness ? { harness: tb.harness } : {}),
    activeVersion: activeId
      ? { id: activeId, ...(active ? { label: active.label } : {}) }
      : null,
    ...(versions ? { versionCount: versions.length } : {}),
    canManage: privileged,
    ...(advanced
      ? {
          ...(tb.source ? { source: tb.source } : {}),
          build: tb.build,
          paths: tb.paths,
          ...(tb.processes?.length ? { processes: tb.processes } : {}),
          ...(tb.ports?.length ? { ports: tb.ports } : {}),
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

/** Injection order of `resolveToolboxRefs`: org baseline, then the user's
 * overlay, oldest first; toolboxes that are not auto-included last. */
function injectionRank(tb: ToolboxConfig): number {
  if (!tb.autoInject) return 2;
  return tb.ownerType === "org" ? 0 : 1;
}

export function registerConfigTools(
  server: McpServer,
  container: ServerContainer,
  user: AuthUser,
): void {
  const { runtime, control } = container;

  // ── prebuilds ────────────────────────────────────────────────────────
  server.registerTool(
    "manage_prebuilds",
    {
      title: "Manage prebuilds",
      description:
        "List, create, or delete prebuilds: snapshots of a sandbox's " +
        "expensive one-time setup (cloned repos, installs, build steps), " +
        "baked once and reused by every sandbox booted from them (pass " +
        "`ref` as `spec.source.snapshot` to `create_sandbox`). Prebuilds are " +
        "shared server-wide. `list` returns {ref, createdAt, repos, " +
        "metadata?, processes?, ports?} newest first: `metadata` names the " +
        "prebuild (e.g. `workspace`), `processes` are the dev servers a " +
        "sandbox from it gets and `ports` the URLs they serve. `create` " +
        "bakes and blocks until done (minutes on a cold " +
        "cache) and returns {ref}. `delete` refuses a prebuild that a " +
        "sandbox boots from or another prebuild is chained on.",
      inputSchema: {
        action: z.enum(["list", "create", "delete"]),
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
        ref: z.string().optional().describe("action=delete: the prebuild ref"),
        force: z
          .boolean()
          .optional()
          .describe(
            "action=create: rebuild even if an identical one is cached",
          ),
      },
    },
    safeTool(async ({ action, repo, spec, ref, force }) => {
      switch (action) {
        case "list":
          return text(
            runtime
              .listPrebuilds()
              .filter(
                (p) =>
                  !repo || p.spec?.repos?.some((r) => r.url.includes(repo)),
              )
              .map(prebuildView),
          );
        case "create": {
          if (!spec) {
            throw new ValidationError("action=create requires `spec`");
          }
          const prebuildSpec = parseSpec(
            PrebuildSpecSchema,
            spec,
            "PrebuildSpec",
          );
          requireSourceAccess(container, user.id, prebuildSpec.source);
          const { ref: created, parent } = await runtime.prebuild(
            prebuildSpec,
            {
              force,
              githubToken: control.userService.resolveGitHubToken(user.id),
              createdBy: user.id,
              saveSurface: true,
            },
          );
          return text({ ref: created, ...(parent ? { parent } : {}) });
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
    "list_toolboxes",
    {
      title: "List toolboxes",
      description:
        "List the toolboxes you can use: your own AND those of every " +
        "organization you belong to (narrow with `owner`). A toolbox " +
        "bundles tools and config baked into sandboxes. `autoInclude: true` " +
        "ones are added to new sandboxes automatically: `appliesTo` " +
        "`every-sandbox` for your own, `sandboxes-in-org` for an org's " +
        "(only sandboxes created in that org, `orgId`; your default org is " +
        "in `whoami`). `explicit-only` ones apply only when passed to " +
        "`create_sandbox` as `toolboxes: [selector]`. Auto-included ones " +
        "come first, in application order. `activeVersion` is the pinned " +
        "build (null: built from the recipe at spawn). `canManage` says " +
        "whether `manage_toolbox` works on it. detail=advanced adds the " +
        "recipe (source, build, paths, processes, ports) and version " +
        "history (visible to org owners/admins and for your own).",
      inputSchema: {
        owner: z
          .string()
          .optional()
          .describe(
            "all (default) | me | org:<orgId>. `me` is only your own " +
              "toolboxes.",
          ),
        detail: detailSchema,
      },
    },
    safeTool(async ({ owner, detail }) => {
      const scopes: ToolboxOwner[] =
        owner === undefined || owner === "all"
          ? readableOwners(control, user.id)
          : [resolveOwner(control, user.id, owner, false)];
      const roles = rolesOf(control, user.id);
      const advanced = detail === "advanced";
      const toolboxes = scopes
        .flatMap((scope) => control.toolboxService.list(scope))
        .sort(
          (a, b) =>
            injectionRank(a) - injectionRank(b) ||
            a.createdAt.localeCompare(b.createdAt),
        );
      return text(
        toolboxes.map((tb) => toolboxView(control, tb, roles, advanced)),
      );
    }),
  );

  server.registerTool(
    "manage_toolbox",
    {
      title: "Manage toolbox",
      description:
        "Create, update or delete a toolbox; capture a running sandbox's " +
        "toolbox paths as a new version; pin/unpin the active version; " +
        "publish or delete a version. Your own toolboxes are yours alone; " +
        "an org's need you to be its owner or admin (see `canManage` in " +
        "`list_toolboxes`). New toolboxes are auto-included by default " +
        "(`config.autoInject`). To roll out a captured version org-wide: " +
        "`capture`, `publish`, then `pin_version`. create/update return " +
        "the toolbox like `list_toolboxes`.",
      inputSchema: {
        action: z.enum([
          "create",
          "update",
          "delete",
          "capture",
          "pin_version",
          "publish",
          "delete_version",
        ]),
        owner: z
          .string()
          .optional()
          .describe(
            "action=create: me (default) | org:<orgId> (needs owner/admin)",
          ),
        id: z
          .string()
          .optional()
          .describe(
            "Toolbox id (from list_toolboxes); every action but create",
          ),
        config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "create/update: the toolbox. create requires `slug` (lowercase-" +
              "kebab, immutable), `description` (max 200), `build` " +
              "(shell steps, max 100) and `paths` (home-relative paths to " +
              "capture, max 100); optional `source` ({image}|{snapshot}), " +
              "`harness` (e.g. pi, opencode), `processes`, `ports`, " +
              "`autoInject` (default true). update takes any of them " +
              "except `slug`; `source`/`harness` null clears.",
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
              "id from `list_toolboxes` detail=advanced or `capture`",
          ),
      },
    },
    safeTool(
      async ({ action, owner, id, config, sandboxId, note, versionId }) => {
        const roles = rolesOf(control, user.id);

        if (action === "create") {
          if (!config) {
            throw new ValidationError("action=create requires `config`");
          }
          const ownerRef = resolveOwner(control, user.id, owner, true);
          const input = parseSpec(
            ToolboxConfigInputSchema,
            config,
            "ToolboxConfigInput",
          );
          requireSourceAccess(container, user.id, input.source);
          return text(
            toolboxView(
              control,
              control.toolboxService.create(ownerRef, input),
              roles,
              false,
            ),
          );
        }

        if (!id) throw new ValidationError(`action=${action} requires \`id\``);
        const tb = control.toolboxService.get(id);
        requireToolboxOwnerAccess(control, tb, user.id);

        /** A version of THIS toolbox, or a ValidationError. */
        const versionOf = (vid: string | null | undefined) => {
          if (!vid) {
            throw new ValidationError(
              `action=${action} requires \`versionId\``,
            );
          }
          const version = control.toolboxVersionService.get(vid);
          if (version.toolboxId !== tb.id) {
            throw new ValidationError(
              "version does not belong to this toolbox",
            );
          }
          return version;
        };

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
            requireSourceAccess(container, user.id, patch.source);
            return text(
              toolboxView(
                control,
                control.toolboxService.update(id, patch),
                roles,
                false,
              ),
            );
          }

          case "delete":
            control.toolboxService.delete(id);
            return text({ id, status: "deleted" });

          case "pin_version": {
            if (versionId === undefined) {
              throw new ValidationError(
                "action=pin_version requires `versionId` (or null to unpin)",
              );
            }
            if (versionId === null) {
              control.toolboxService.setActiveVersionId(id, null);
              return text({ id, activeVersionId: null });
            }
            const version = versionOf(versionId);
            // Org publish-before-pin guard (docs/toolbox-versions.md §5):
            // a private capture pinned org-wide would replay one user's
            // config (and possibly secrets) into every future spawn.
            if (tb.ownerType === "org") {
              const entry = runtime.getToolsetEntry(version.ref);
              if (entry?.private === true) {
                throw new ValidationError(
                  "publish this version (action=publish) before pinning an " +
                    "org toolbox org-wide",
                );
              }
            }
            control.toolboxService.setActiveVersionId(id, version.id);
            return text({ id, activeVersionId: version.id });
          }

          case "publish": {
            const version = versionOf(versionId);
            const entry = runtime.publishToolset(version.ref);
            return text({
              id,
              versionId: version.id,
              private: entry.private === true,
            });
          }

          case "delete_version": {
            const version = versionOf(versionId);
            if (
              control.toolboxService.getActiveVersionId(tb.id) === version.id
            ) {
              throw new ValidationError(
                "cannot delete the active version; unpin it first " +
                  "(action=pin_version with versionId null)",
              );
            }
            control.toolboxVersionService.delete(version.id);
            return text({ id, versionId: version.id, status: "deleted" });
          }

          case "capture": {
            if (!sandboxId || !note) {
              throw new ValidationError(
                "action=capture requires `sandboxId` and `note`",
              );
            }
            if (tb.paths.length === 0) {
              throw new ValidationError("toolbox has no paths to capture");
            }
            // Server-authoritative capture inputs (docs/toolbox-versions.md
            // §2 invariant): capture the toolbox's OWN paths[], never
            // caller-supplied ones.
            requireSandboxAccess(container, user.id, sandboxId);
            const { ref } = await runtime.captureToolset(sandboxId, {
              name: toolboxSelector(tb),
              paths: tb.paths,
              exclude: [],
              overrides: [],
            });
            const sourceImage = await runtime
              .getSandboxImage(sandboxId)
              .catch(() => undefined);
            const version = control.toolboxVersionService.create(tb.id, {
              ref,
              description: note,
              provenance: {
                kind: "captured",
                capturedFrom: sandboxId,
                capturedBy: user.id,
                ...(sourceImage ? { sourceImage } : {}),
              },
              recipeFingerprint: recipeFingerprint(tb),
            });
            pruneToolboxVersions(container, tb.id);
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
}
