/**
 * Who may reach a sandbox over SSH. `/v1` has no per-user sandbox rule (any
 * authenticated user can address any sandbox id), so this is the narrowest
 * one the records support: the sandbox's creator (its `atelier.dev/owner-id`
 * metadata) and every member of the org it was created in (its
 * `atelier.dev/org-id` annotation). A sandbox with neither admits nobody.
 */
import { SANDBOX_ORG_ANNOTATION } from "@atelier/spec";
import { OWNER_ID_METADATA } from "../shared/lib/git-attribution.ts";
import type { OrgMemberService } from "./modules/org-member/index.ts";
import type { SshKeyService } from "./modules/ssh-key/index.ts";

/** A sandbox's spec labels, as the runtime stores them. */
export interface SandboxLabels {
  metadata?: Record<string, string>;
  annotations?: Record<string, string>;
}

/** The valid public keys whose owners may access the sandbox. */
export function sandboxSshKeys(
  deps: { sshKeys: SshKeyService; orgMembers: OrgMemberService },
  labels: SandboxLabels,
): string[] {
  const ownerId = labels.metadata?.[OWNER_ID_METADATA];
  const orgId = labels.annotations?.[SANDBOX_ORG_ANNOTATION];
  return deps.sshKeys
    .getAllValidKeys()
    .filter(
      (key) =>
        key.userId === ownerId ||
        (orgId !== undefined &&
          deps.orgMembers.getMembership(orgId, key.userId) !== undefined),
    )
    .map((key) => key.publicKey);
}
