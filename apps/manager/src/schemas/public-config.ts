import type { Static } from "elysia";
import { t } from "elysia";

export const PublicConfigSchema = t.Object({
  sshHostname: t.String(),
  sshPort: t.Number(),
  opencodePort: t.Number(),
});
export type PublicConfig = Static<typeof PublicConfigSchema>;
