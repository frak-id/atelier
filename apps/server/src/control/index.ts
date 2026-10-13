/**
 * The control module's public interface. BOUNDARY RULE (design.md §3.1):
 * control/ imports runtime/'s interface (index), never its internals; other
 * modules import control/'s interface (this barrel), never its internals.
 */

export { type AuthUser, signJwt, verifyJwt } from "./auth.ts";
export { isUserAuthorized } from "./authorization-policy.ts";
export { type ControlContainer, createControlContainer } from "./container.ts";
export { initDatabase } from "./db/client.ts";
export {
  buildOAuthRedirectUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
  generateCodeChallenge,
  generateCodeVerifier,
} from "./github-oauth.ts";
export {
  evaluateIdle,
  type IdleEvaluation,
  IdlePolicyService,
  type IdleRule,
} from "./modules/idle-policy/index.ts";
export type { WorkspaceRecord } from "./modules/launchpad/index.ts";
export { SecretService } from "./modules/secret/index.ts";
export { ServerConfigService } from "./modules/server-config/index.ts";
export { recipeFingerprint } from "./modules/toolbox-version/index.ts";
export type * from "./types.ts";
