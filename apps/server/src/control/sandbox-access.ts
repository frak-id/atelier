/**
 * The one sandbox access rule, applied wherever a sandbox id is addressed
 * (`/v1/sandboxes/:id/*`, `/sessions/sandboxes/:id/*`, the MCP tools, the
 * list endpoints) and, per key owner, to SSH.
 *
 * A caller may reach a sandbox when:
 *  - auth is bypassed (local/mock single-user modes), or
 *  - the sandbox is unowned: it has neither an `atelier.dev/owner-id`
 *    metadata nor an `atelier.dev/org-id` annotation (a legacy sandbox from
 *    before ownership was recorded keeps its pre-rule behaviour: open to any
 *    authenticated caller), or
 *  - the caller created it (owner-id) or belongs to the org it was created
 *    in (org-id).
 * Callers turn a denial into `NotFoundError` so a sandbox's existence is not
 * revealed.
 */
import { SANDBOX_ORG_ANNOTATION } from "@atelier/spec";
import { OWNER_ID_METADATA } from "../shared/lib/git-attribution.ts";
import type { SshKeyService } from "./modules/ssh-key/index.ts";

/** A sandbox's spec labels, as the runtime stores them. */
export interface SandboxLabels {
  metadata?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface SandboxAccessDeps {
  /** Evaluated per call: auth is bypassed in `local`/`mock` modes. */
  isAuthBypassed: () => boolean;
  isOrgMember: (orgId: string, userId: string) => boolean;
}

/** The sandbox's recorded creator, or undefined for a legacy sandbox. */
function sandboxOwnerId(labels: SandboxLabels): string | undefined {
  return labels.metadata?.[OWNER_ID_METADATA];
}

/** Owner or member of the sandbox's org (the non-trivial half of the rule). */
function isOwnerOrOrgMember(
  deps: Pick<SandboxAccessDeps, "isOrgMember">,
  userId: string,
  labels: SandboxLabels,
): boolean {
  const orgId = labels.annotations?.[SANDBOX_ORG_ANNOTATION];
  return (
    sandboxOwnerId(labels) === userId ||
    (orgId !== undefined && deps.isOrgMember(orgId, userId))
  );
}

export function canAccessSandbox(
  deps: SandboxAccessDeps,
  userId: string,
  labels: SandboxLabels,
): boolean {
  if (deps.isAuthBypassed()) return true;
  const unowned =
    sandboxOwnerId(labels) === undefined &&
    labels.annotations?.[SANDBOX_ORG_ANNOTATION] === undefined;
  return unowned || isOwnerOrOrgMember(deps, userId, labels);
}

/**
 * The valid public keys whose owners may access the sandbox: the owner/org
 * half of the rule per key owner. It deliberately diverges from
 * `canAccessSandbox`: no auth bypass, and a legacy unowned sandbox admits no
 * key (SSH never had an open mode).
 */
export function sandboxSshKeys(
  deps: Pick<SandboxAccessDeps, "isOrgMember"> & { sshKeys: SshKeyService },
  labels: SandboxLabels,
): string[] {
  return deps.sshKeys
    .getAllValidKeys()
    .filter((key) => isOwnerOrOrgMember(deps, key.userId, labels))
    .map((key) => key.publicKey);
}
