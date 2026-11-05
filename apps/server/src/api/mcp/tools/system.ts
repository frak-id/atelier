/**
 * `whoami` — lets an agent self-orient (identity, orgs, what a sandbox can be
 * made from) before calling any other tool, so creating a sandbox never
 * needs the admin MCP. The MCP session is per-user (`mcp/index.ts`), so this
 * is the caller's own view, no lookup input needed.
 */
import { toolboxArtifactName } from "@atelier/spec";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthUser } from "../../../control/index.ts";
import { resolveOrgId } from "../../app/sandbox-ops.ts";
import type { ServerContainer } from "../../container.ts";
import { readableOrgIds } from "../../toolbox-access.ts";
import { safeTool, text } from "../format.ts";

/** The newest prebuilds listed; the rest is the admin MCP's `list`. */
const PREBUILD_SUMMARIES = 20;

export function registerSystemTools(
  server: McpServer,
  container: ServerContainer,
  user: AuthUser,
): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Your username, organizations, and what a new sandbox can be built " +
        "from. Call it first. `defaultOrgId` is where `create_sandbox` runs " +
        "without `orgId`; `defaultImage` is the base image; `toolboxes` " +
        "lists the `selector`s `create_sandbox` takes (`autoInclude` ones " +
        "are applied anyway); `prebuilds` the newest ready-made snapshots " +
        "(`ref` goes in `spec.source.snapshot`, or just pass `repo`).",
      inputSchema: {},
      outputSchema: {
        username: z.string(),
        orgs: z.array(z.object({}).passthrough()),
        defaultOrgId: z.string().optional(),
        defaultImage: z.string(),
        toolboxes: z.array(z.object({}).passthrough()),
        prebuilds: z.array(z.object({}).passthrough()),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safeTool("whoami", async () => {
      const { control, runtime } = container;
      const memberships = control.orgMemberService.getByUserId(user.id);
      const defaultOrgId = resolveOrgId(control, user.id);
      const orgs = memberships.map((m) => ({
        orgId: m.orgId,
        name: control.organizationService.getById(m.orgId)?.name ?? null,
        role: m.role,
        ...(m.orgId === defaultOrgId ? { default: true } : {}),
      }));
      const personalOrgId = control.userService.getById(user.id)?.personalOrgId;

      const toolboxes = readableOrgIds(control, user.id)
        .flatMap((orgId) => control.toolboxService.list(orgId))
        .sort(
          (a, b) =>
            Number(b.autoInject) - Number(a.autoInject) ||
            a.createdAt.localeCompare(b.createdAt),
        )
        .map((tb) => ({
          selector: toolboxArtifactName(tb),
          description: tb.description,
          orgId: tb.orgId,
          autoInclude: tb.autoInject,
        }));

      const prebuilds = runtime
        .listPrebuilds()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, PREBUILD_SUMMARIES)
        .map((p) => {
          const name = (p.metadata ?? p.spec?.metadata)?.name;
          return {
            ref: p.ref,
            ...(name ? { name } : {}),
            repos: (p.spec?.repos ?? []).map((r) => r.url),
            createdAt: p.createdAt,
          };
        });

      return text({
        username: user.username,
        orgs,
        ...(personalOrgId ? { personalOrgId } : {}),
        ...(defaultOrgId ? { defaultOrgId } : {}),
        defaultImage: runtime.defaultImage(),
        toolboxes,
        prebuilds,
      });
    }),
  );
}
