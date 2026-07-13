/**
 * Control-plane config tools: prebuilds, toolboxes (+ their versions, the
 * toolbox/toolset merge point \u2014 see `list_toolboxes`), and saved specs. The
 * "configure your prebuilt/toolbox from your own dev env" surface.
 */
import {
  PrebuildSpecSchema,
  SandboxSpecSchema,
  ToolboxConfigInputSchema,
  ToolboxConfigPatchSchema,
} from "@atelier/spec";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthUser } from "../../../control/index.ts";
import { recipeFingerprint } from "../../../control/index.ts";
import { ValidationError } from "../../../shared/errors.ts";
import { pruneToolboxVersions, type ServerContainer } from "../../container.ts";
import {
  requireToolboxOwnerAccess,
  resolveOwner,
} from "../../toolbox-access.ts";
import { safeTool, text } from "../format.ts";
import { parseSpec } from "../validate.ts";

export function registerConfigTools(
  server: McpServer,
  container: ServerContainer,
  user: AuthUser,
): void {
  const { runtime, control } = container;

  // ── server config (the config plane) ─────────────────────────────────
  server.registerTool(
    "server_config",
    {
      title: "Server config",
      description:
        "Read or change server-wide runtime config (e.g. prebuild git " +
        "tracking and prebuild retention). action=list returns every key " +
        "with its value, type, and default; action=set updates one key.",
      inputSchema: {
        action: z.enum(["list", "set"]),
        key: z.string().optional().describe("Config key (required for set)"),
        value: z
          .union([z.boolean(), z.number()])
          .optional()
          .describe("New value (required for set)"),
      },
    },
    safeTool(async ({ action, key, value }) => {
      if (action === "list") return text(control.serverConfigService.list());
      if (key === undefined || value === undefined) {
        throw new ValidationError("action=set requires `key` and `value`");
      }
      const stored = control.serverConfigService.set(key, value);
      return text({ key, value: stored });
    }),
  );

  // ── prebuilds ────────────────────────────────────────────────────────
  server.registerTool(
    "manage_prebuilds",
    {
      title: "Manage prebuilds",
      description:
        "List, create, or delete layered prebuild snapshots (a sandbox's " +
        "expensive one-time setup, baked and reused across spawns).",
      inputSchema: {
        action: z.enum(["list", "create", "delete"]),
        spec: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Required for action=create: a PrebuildSpec"),
        ref: z.string().optional().describe("Required for action=delete"),
        force: z.boolean().optional(),
      },
    },
    safeTool(async ({ action, spec, ref, force }) => {
      switch (action) {
        case "list":
          return text(runtime.listPrebuilds());
        case "create":
          if (!spec) {
            throw new ValidationError("action=create requires `spec`");
          }
          return text(
            await runtime.prebuild(
              parseSpec(PrebuildSpecSchema, spec, "PrebuildSpec"),
              {
                force,
                githubToken: control.userService.resolveGitHubToken(user.id),
              },
            ),
          );
        case "delete":
          if (!ref) throw new ValidationError("action=delete requires `ref`");
          await runtime.deletePrebuild(ref);
          return text({ ok: true });
      }
    }),
  );

  // ── toolboxes (+ inlined versions \u2014 the toolset merge point) ────────
  server.registerTool(
    "list_toolboxes",
    {
      title: "List toolboxes",
      description:
        "List toolboxes for an owner scope (`me` [default], `user`, or " +
        "`org:<id>`), each with its version history and active pin " +
        "inlined \u2014 the single place to see what's built for a toolbox " +
        "(no separate toolset listing needed).",
      inputSchema: {
        owner: z
          .string()
          .optional()
          .describe("me | user | org:<id>. Defaults to your own toolboxes."),
      },
    },
    safeTool(async ({ owner }) => {
      const ownerRef = resolveOwner(control, user.id, owner, false);
      const toolboxes = control.toolboxService.list(ownerRef);
      // Version history parity with HTTP (`GET /api/toolboxes/:id/versions`
      // is owner/admin-gated): inline versions only when the caller could
      // read them there — own toolboxes always, org toolboxes only for
      // owner/admin members.
      const canSeeVersions =
        ownerRef.type === "user" ||
        ["owner", "admin"].includes(
          control.orgMemberService.requireMembership(ownerRef.id, user.id).role,
        );
      return text(
        toolboxes.map((tb) => ({
          ...tb,
          activeVersionId: control.toolboxService.getActiveVersionId(tb.id),
          ...(canSeeVersions
            ? { versions: control.toolboxVersionService.listByToolbox(tb.id) }
            : {}),
        })),
      );
    }),
  );

  server.registerTool(
    "manage_toolbox",
    {
      title: "Manage toolbox",
      description:
        "Create, update, delete a toolbox; pin/unpin an active version; " +
        "or capture a running sandbox's toolbox paths as a new version. " +
        "Mirrors the /api/toolboxes HTTP surface's authorization exactly " +
        "(org toolboxes need owner/admin; user toolboxes are self-only).",
      inputSchema: {
        action: z.enum([
          "create",
          "update",
          "delete",
          "pin_version",
          "capture",
        ]),
        owner: z
          .string()
          .optional()
          .describe("me | user | org:<id>. Only used for action=create."),
        id: z
          .string()
          .optional()
          .describe("Toolbox id. Required for all actions but create."),
        config: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "ToolboxConfigInput for create, ToolboxConfigPatch for update",
          ),
        versionId: z
          .union([z.string(), z.null()])
          .optional()
          .describe("Required for action=pin_version (null to unpin)"),
        sandboxId: z
          .string()
          .optional()
          .describe("Required for action=capture"),
        description: z
          .string()
          .optional()
          .describe("Required for action=capture"),
      },
    },
    safeTool(
      async ({
        action,
        owner,
        id,
        config,
        versionId,
        sandboxId,
        description,
      }) => {
        if (action === "create") {
          if (!config)
            throw new ValidationError("action=create requires `config`");
          const ownerRef = resolveOwner(control, user.id, owner, true);
          return text(
            control.toolboxService.create(
              ownerRef,
              parseSpec(ToolboxConfigInputSchema, config, "ToolboxConfigInput"),
            ),
          );
        }

        if (!id) throw new ValidationError(`action=${action} requires \`id\``);
        const tb = control.toolboxService.get(id);
        requireToolboxOwnerAccess(control, tb, user.id);

        switch (action) {
          case "update":
            if (!config) {
              throw new ValidationError("action=update requires `config`");
            }
            return text(
              control.toolboxService.update(
                id,
                parseSpec(
                  ToolboxConfigPatchSchema,
                  config,
                  "ToolboxConfigPatch",
                ),
              ),
            );

          case "delete":
            control.toolboxService.delete(id);
            return text({ ok: true });

          case "pin_version": {
            if (versionId === undefined) {
              throw new ValidationError(
                "action=pin_version requires `versionId` (or null to unpin)",
              );
            }
            if (versionId === null) {
              control.toolboxService.setActiveVersionId(id, null);
              return text({ activeVersionId: null });
            }
            const version = control.toolboxVersionService.get(versionId);
            if (version.toolboxId !== tb.id) {
              throw new ValidationError(
                "version does not belong to this toolbox",
              );
            }
            // Org publish-before-pin guard (docs/toolbox-versions.md \u00a75):
            // a private capture pinned org-wide would replay one user's
            // config (and possibly secrets) into every future spawn.
            if (tb.ownerType === "org") {
              const entry = runtime.getToolsetEntry(version.ref);
              if (entry?.private === true) {
                throw new ValidationError(
                  "publish this toolset before pinning an org toolbox org-wide",
                );
              }
            }
            control.toolboxService.setActiveVersionId(id, version.id);
            return text({ activeVersionId: version.id });
          }

          case "capture": {
            if (!sandboxId || !description) {
              throw new ValidationError(
                "action=capture requires `sandboxId` and `description`",
              );
            }
            if (tb.paths.length === 0) {
              throw new ValidationError("toolbox has no paths to capture");
            }
            // Server-authoritative capture inputs (docs/toolbox-versions.md
            // \u00a72 invariant): capture the toolbox's OWN paths[], never
            // caller-supplied ones.
            const { ref } = await runtime.captureToolset(sandboxId, {
              name: `tb/${tb.ownerType}/${tb.ownerId}/${tb.slug}`,
              paths: tb.paths,
              exclude: [],
              overrides: [],
            });
            const sourceImage = await runtime
              .getSandboxImage(sandboxId)
              .catch(() => undefined);
            const version = control.toolboxVersionService.create(tb.id, {
              ref,
              description,
              provenance: {
                kind: "captured",
                capturedFrom: sandboxId,
                capturedBy: user.id,
                ...(sourceImage ? { sourceImage } : {}),
              },
              recipeFingerprint: recipeFingerprint(tb),
            });
            pruneToolboxVersions(container, tb.id);
            return text(version);
          }
        }
      },
    ),
  );

  // ── saved specs ──────────────────────────────────────────────────────
  server.registerTool(
    "saved_specs",
    {
      title: "Saved specs",
      description:
        "List your saved specs/templates, get one by id, or save a new " +
        "one \u2014 the config-from-your-dev-env loop for reusable sandbox " +
        "shapes.",
      inputSchema: {
        action: z.enum(["list", "get", "save"]),
        id: z.string().optional().describe("Required for action=get"),
        name: z.string().optional().describe("Required for action=save"),
        spec: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Required for action=save: a SandboxSpec"),
        orgId: z
          .string()
          .optional()
          .describe("Org to save under (must be one you belong to)"),
      },
    },
    safeTool(async ({ action, id, name, spec, orgId }) => {
      switch (action) {
        case "list": {
          const orgIds = control.orgMemberService
            .getByUserId(user.id)
            .map((m) => m.orgId);
          return text(control.savedSpecService.getByOrgIds(orgIds));
        }
        case "get": {
          if (!id) throw new ValidationError("action=get requires `id`");
          const saved = control.savedSpecService.getByIdOrThrow(id);
          // Org-scoped specs are readable by members only (the HTTP GET
          // /api/saved-specs/:id lacks this check — pre-existing gap, not
          // mirrored here). Specs without an orgId are global by design
          // (getByOrgIds lists them for everyone).
          if (saved.orgId) {
            control.orgMemberService.requireMembership(saved.orgId, user.id);
          }
          return text(saved);
        }
        case "save":
          if (!name || !spec) {
            throw new ValidationError("action=save requires `name` and `spec`");
          }
          if (orgId) control.orgMemberService.requireMembership(orgId, user.id);
          return text(
            control.savedSpecService.create(
              name,
              parseSpec(SandboxSpecSchema, spec, "SandboxSpec"),
              orgId,
            ),
          );
      }
    }),
  );
}
