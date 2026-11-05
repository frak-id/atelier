/**
 * Control's composition root. Manual-wiring convention (AGENTS.md "DI: Manual
 * wiring in container.ts"), scoped to exactly what docs/archive/design.md §3.1 assigns to
 * control/: identity, orgs, secrets, toolboxes, and the enrichment
 * pipeline.
 */

import { isAuthBypassed } from "../shared/lib/config.ts";
import { AuthService } from "./auth.ts";
import { createDefaultOrg } from "./default-org.ts";
import {
  type EnrichmentOptions,
  enrichSpec,
  reattributeSpec,
  resolveBootSpec,
} from "./enrichment.ts";
import { GitHubRepoService } from "./github-repos.ts";
import { ApiKeyRepository, ApiKeyService } from "./modules/api-key/index.ts";
import { IdlePolicyService } from "./modules/idle-policy/index.ts";
import {
  OrgMemberRepository,
  OrgMemberService,
} from "./modules/org-member/index.ts";
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
  const serverConfigService = new ServerConfigService(serverConfigRepository);
  const idlePolicyService = new IdlePolicyService(serverConfigService);
  const toolboxService = new ToolboxService(toolboxRepository);
  const toolboxVersionService = new ToolboxVersionService(
    toolboxVersionRepository,
  );
  const ownershipTransferService = new OwnershipTransferService(
    new OwnershipTransferRepository(),
  );
  const authService = new AuthService({ apiKeyService, userService });
  const gitHubRepoService = new GitHubRepoService({ userService });

  const defaultOrg = createDefaultOrg({
    organizationService,
    orgMemberService,
  });

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
    serverConfigService,
    idlePolicyService,
    toolboxService,
    toolboxVersionService,
    authService,
    gitHubRepoService,
    ownershipTransferService,
    /** `auth.defaultOrg`: default spawn org, auto-join, server admins. */
    defaultOrg,
    /** Create-time enrichment: what `api/` hands to `runtime.create()` and
     * the runtime stores (`$secret` refs and no credentials in it). */
    enrichSpec: (
      spec: Parameters<typeof enrichSpec>[0],
      opts?: EnrichmentOptions,
    ) => enrichSpec(spec, opts),
    /** Boot-time resolution, injected into the runtime: a stored spec in,
     * the spec a boot runs with (secrets and fresh git files) out. */
    resolveBootSpec: (spec: Parameters<typeof resolveBootSpec>[0]) =>
      resolveBootSpec(spec, { secrets: secretService, users: userService }),
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
