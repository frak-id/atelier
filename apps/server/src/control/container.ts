/**
 * Control's composition root. Manual-wiring convention (AGENTS.md "DI: Manual
 * wiring in container.ts"), scoped to exactly what atelier-v2 §3.1 assigns to
 * control/: identity, orgs, quotas, secrets, org policy, and the
 * enrichment pipeline.
 */

import { isAuthBypassed } from "../shared/lib/config.ts";
import { AuthService } from "./auth.ts";
import {
  type EnrichmentOptions,
  enrichSpec,
  reattributeSpec,
} from "./enrichment.ts";
import { GitHubRepoService } from "./github-repos.ts";
import { ApiKeyRepository, ApiKeyService } from "./modules/api-key/index.ts";
import {
  StarterRepository,
  StarterService,
  WorkspaceRepository,
  WorkspaceService,
} from "./modules/launchpad/index.ts";
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
  OwnershipTransferRepository,
  OwnershipTransferService,
} from "./modules/ownership-transfer/index.ts";
import { SecretRepository, SecretService } from "./modules/secret/index.ts";
import {
  ServerConfigRepository,
  ServerConfigService,
} from "./modules/server-config/index.ts";
import { SshKeyRepository, SshKeyService } from "./modules/ssh-key/index.ts";
import {
  SteeryNotifyRepository,
  SteeryNotifyService,
} from "./modules/steery-notify/index.ts";
import { ToolboxRepository, ToolboxService } from "./modules/toolbox/index.ts";
import {
  ToolboxVersionRepository,
  ToolboxVersionService,
} from "./modules/toolbox-version/index.ts";
import { UserRepository, UserService } from "./modules/user/index.ts";
import {
  canAccessSandbox,
  type SandboxAccessDeps,
  type SandboxLabels,
  sandboxSshKeys,
} from "./sandbox-access.ts";

export function createControlContainer() {
  const userRepository = new UserRepository();
  const organizationRepository = new OrganizationRepository();
  const orgMemberRepository = new OrgMemberRepository();
  const apiKeyRepository = new ApiKeyRepository();
  const sshKeyRepository = new SshKeyRepository();
  const secretRepository = new SecretRepository();
  const orgPolicyRepository = new OrgPolicyRepository();
  const serverConfigRepository = new ServerConfigRepository();
  const toolboxRepository = new ToolboxRepository();
  const toolboxVersionRepository = new ToolboxVersionRepository();

  const userService = new UserService(userRepository);
  const organizationService = new OrganizationService(organizationRepository);
  const orgMemberService = new OrgMemberService(
    orgMemberRepository,
    userRepository,
  );
  const apiKeyService = new ApiKeyService(apiKeyRepository);
  const sshKeyService = new SshKeyService(sshKeyRepository);
  const secretService = new SecretService(secretRepository);
  const orgPolicyService = new OrgPolicyService(orgPolicyRepository);
  const serverConfigService = new ServerConfigService(serverConfigRepository);
  const toolboxService = new ToolboxService(toolboxRepository);
  const toolboxVersionService = new ToolboxVersionService(
    toolboxVersionRepository,
  );
  const starterService = new StarterService(new StarterRepository());
  const workspaceService = new WorkspaceService(new WorkspaceRepository());
  const ownershipTransferService = new OwnershipTransferService(
    new OwnershipTransferRepository(),
  );
  const authService = new AuthService({ apiKeyService, userService });
  const gitHubRepoService = new GitHubRepoService({ userService });
  const steeryNotifyService = new SteeryNotifyService(
    new SteeryNotifyRepository(),
  );

  const accessDeps: SandboxAccessDeps = {
    isAuthBypassed,
    isOrgMember: (orgId, userId) =>
      orgMemberService.getMembership(orgId, userId) !== undefined,
  };

  return {
    userService,
    organizationService,
    orgMemberService,
    apiKeyService,
    sshKeyService,
    secretService,
    orgPolicyService,
    serverConfigService,
    toolboxService,
    toolboxVersionService,
    authService,
    gitHubRepoService,
    starterService,
    workspaceService,
    ownershipTransferService,
    steeryNotifyService,
    /** Bound seam-crossing enrichment \u2014 the only function `api/` calls
     * before handing a spec to `runtime.create()`. */
    enrichSpec: (
      spec: Parameters<typeof enrichSpec>[0],
      orgId?: string,
      opts?: EnrichmentOptions,
    ) =>
      enrichSpec(
        spec,
        orgId,
        {
          secrets: secretService,
          orgPolicy: orgPolicyService,
        },
        opts,
      ),
    /** Re-attribute a stored spec to a new owner (fork); pure, no deps. */
    reattributeSpec,
    /** The SSH public keys allowed into one sandbox (see sandbox-access.ts). */
    sandboxSshKeys: (labels: SandboxLabels) =>
      sandboxSshKeys({ ...accessDeps, sshKeys: sshKeyService }, labels),
    /** The one sandbox access rule (see sandbox-access.ts). */
    canAccessSandbox: (userId: string, labels: SandboxLabels) =>
      canAccessSandbox(accessDeps, userId, labels),
  };
}

export type ControlContainer = ReturnType<typeof createControlContainer>;
