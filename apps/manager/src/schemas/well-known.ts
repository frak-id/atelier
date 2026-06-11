import type { Static } from "elysia";
import { t } from "elysia";

export const WellKnownSandboxRoutesSchema = t.Object({
  vscode: t.String(),
  opencode: t.String(),
  ssh: t.String(),
  browser: t.Optional(t.String()),
  dev: t.Optional(t.String()),
});
export type WellKnownSandboxRoutes = Static<
  typeof WellKnownSandboxRoutesSchema
>;

export const WellKnownAtelierConfigSchema = t.Object({
  baseDomain: t.String(),
  host: t.String(),
  sandboxId: t.Optional(t.String()),
  routes: t.Optional(WellKnownSandboxRoutesSchema),
});
export type WellKnownAtelierConfig = Static<
  typeof WellKnownAtelierConfigSchema
>;
