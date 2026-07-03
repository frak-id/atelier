/**
 * Control's composition root. Mirrors v1 `container.ts`'s manual-wiring
 * convention (AGENTS.md "DI: Manual wiring in container.ts"), scoped to
 * exactly what atelier-v2 §3.1 assigns to control/: identity, orgs, quotas,
 * secrets, saved specs, org policy, and the enrichment pipeline.
 */

import { AuthService } from "./auth.ts";
import { enrichSpec } from "./enrichment.ts";
import { ApiKeyRepository, ApiKeyService } from "./modules/api-key/index.ts";
import { CliproxyService } from "./modules/cliproxy/index.ts";
import {
  OrgMemberRepository,
  OrgMemberService,
} from "./modules/org-member/index.ts";
import {
  OrgPolicyRepository,
  OrgPolicyService,
} from "./modules/org-policy/index.ts";
import {
  OrganizationRepository,
  OrganizationService,
} from "./modules/organization/index.ts";
import {
  SavedSpecRepository,
  SavedSpecService,
} from "./modules/saved-spec/index.ts";
import { SecretRepository, SecretService } from "./modules/secret/index.ts";
import { SshKeyRepository, SshKeyService } from "./modules/ssh-key/index.ts";
import { ToolboxRepository, ToolboxService } from "./modules/toolbox/index.ts";
import { UserRepository, UserService } from "./modules/user/index.ts";

export function createControlContainer() {
  const userRepository = new UserRepository();
  const organizationRepository = new OrganizationRepository();
  const orgMemberRepository = new OrgMemberRepository();
  const apiKeyRepository = new ApiKeyRepository();
  const sshKeyRepository = new SshKeyRepository();
  const savedSpecRepository = new SavedSpecRepository();
  const secretRepository = new SecretRepository();
  const orgPolicyRepository = new OrgPolicyRepository();
  const toolboxRepository = new ToolboxRepository();

  const userService = new UserService(userRepository);
  const organizationService = new OrganizationService(organizationRepository);
  const orgMemberService = new OrgMemberService(
    orgMemberRepository,
    userRepository,
  );
  const apiKeyService = new ApiKeyService(apiKeyRepository);
  const sshKeyService = new SshKeyService(sshKeyRepository);
  const savedSpecService = new SavedSpecService(savedSpecRepository);
  const secretService = new SecretService(secretRepository);
  const orgPolicyService = new OrgPolicyService(orgPolicyRepository);
  const toolboxService = new ToolboxService(toolboxRepository);
  const cliproxyService = new CliproxyService();
  const authService = new AuthService({ apiKeyService, userService });

  return {
    userService,
    organizationService,
    orgMemberService,
    apiKeyService,
    sshKeyService,
    savedSpecService,
    secretService,
    orgPolicyService,
    toolboxService,
    authService,
    /** Bound seam-crossing enrichment \u2014 the only function `api/` calls
     * before handing a spec to `runtime.create()`. */
    enrichSpec: (spec: Parameters<typeof enrichSpec>[0], orgId?: string) =>
      enrichSpec(spec, orgId, {
        secrets: secretService,
        orgPolicy: orgPolicyService,
        cliproxy: cliproxyService,
      }),
  };
}

export type ControlContainer = ReturnType<typeof createControlContainer>;
