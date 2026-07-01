import type { Static } from "elysia";
import { t } from "elysia";

export const PublicConfigSchema = t.Object({
  sshHostname: t.String(),
  sshPort: t.Number(),
  agentPort: t.Number(),
  mcp: t.Object({
    url: t.String(),
    hasToken: t.Boolean(),
  }),
});
export type PublicConfig = Static<typeof PublicConfigSchema>;
