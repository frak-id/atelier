/**
 * `whoami` — lets an agent self-orient (identity, org memberships) before
 * calling any other tool. The MCP session is per-user (`mcp/index.ts`), so
 * this is the caller's own view, no lookup input needed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthUser } from "../../../control/index.ts";
import type { ServerContainer } from "../../container.ts";
import { resolveOrgId } from "../../v1.routes.ts";
import { safeTool, text } from "../format.ts";

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
        "Get your username and organization memberships. Use this first " +
        "to orient before org-scoped tools: `defaultOrgId` is the org " +
        "`create_sandbox` runs in when you pass no `orgId`, and `orgs[]." +
        "orgId` are the values `orgId` and `list_toolboxes` (as " +
        "`org:<orgId>`) accept.",
      inputSchema: {},
    },
    safeTool(async () => {
      const { control } = container;
      const memberships = control.orgMemberService.getByUserId(user.id);
      const orgs = memberships.map((m) => ({
        orgId: m.orgId,
        name: control.organizationService.getById(m.orgId)?.name ?? null,
        role: m.role,
      }));
      const personalOrgId = control.userService.getById(user.id)?.personalOrgId;
      return text({
        username: user.username,
        orgs,
        ...(personalOrgId ? { personalOrgId } : {}),
        defaultOrgId: resolveOrgId(control, user.id),
      });
    }),
  );
}
