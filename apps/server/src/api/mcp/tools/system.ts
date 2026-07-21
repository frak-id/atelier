/**
 * `whoami` \u2014 lets an agent self-orient (identity, org memberships) before
 * calling any other tool. The MCP session is per-user (`mcp/index.ts`), so
 * this is the caller's own view, no lookup input needed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthUser } from "../../../control/index.ts";
import type { ServerContainer } from "../../container.ts";
import { text } from "../format.ts";

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
        "Get the authenticated caller's identity and organization " +
        "memberships. Use this first to orient before calling org-scoped " +
        "tools (create_sandbox, manage_toolbox).",
      inputSchema: {},
    },
    async () => {
      const { control } = container;
      const memberships = control.orgMemberService.getByUserId(user.id);
      const orgs = memberships.map((m) => ({
        orgId: m.orgId,
        role: m.role,
        name: control.organizationService.getById(m.orgId)?.name ?? null,
      }));
      const personalOrgId = control.userService.getById(user.id)?.personalOrgId;
      return text({
        user: { id: user.id, username: user.username, email: user.email },
        orgs,
        personalOrgId,
      });
    },
  );
}
