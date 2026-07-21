/**
 * The control module's public interface. BOUNDARY RULE (atelier-v2 §3.1):
 * control/ imports runtime/'s interface (index), never its internals; other
 * modules import control/'s interface (this barrel), never its internals.
 */

export { AuthService, type AuthUser, signJwt, verifyJwt } from "./auth.ts";
export { isUserAuthorized } from "./authorization-policy.ts";
export { type ControlContainer, createControlContainer } from "./container.ts";
export { getDatabase, initDatabase } from "./db/client.ts";
export { type EnrichmentDeps, enrichSpec } from "./enrichment.ts";
export {
  buildOAuthRedirectUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
  type GitHubUser,
  generateCodeChallenge,
  generateCodeVerifier,
} from "./github-oauth.ts";
export { ApiKeyService } from "./modules/api-key/index.ts";
export { OrgMemberService } from "./modules/org-member/index.ts";
export { OrgPolicyService } from "./modules/org-policy/index.ts";
export { OrganizationService } from "./modules/organization/index.ts";
export { SecretService } from "./modules/secret/index.ts";
export {
  CONFIG_REGISTRY,
  type ConfigEntry,
  type ConfigKey,
  type ConfigValue,
  type ConfigValues,
  ServerConfigService,
} from "./modules/server-config/index.ts";
export { SshKeyService } from "./modules/ssh-key/index.ts";
export { ToolboxService } from "./modules/toolbox/index.ts";
export {
  recipeFingerprint,
  ToolboxVersionService,
} from "./modules/toolbox-version/index.ts";
export { UserService } from "./modules/user/index.ts";
export type * from "./types.ts";
