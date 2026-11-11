/**
 * The one sandbox access rule, applied wherever a sandbox id is addressed
 * (`/v1/sandboxes/:id/*`, `/sessions/sandboxes/:id/*`, the MCP tools, the
 * list endpoints) and, per key owner, to SSH.
 *
 * A caller may reach a sandbox when:
 *  - the caller created it (owner-id), or
 *  - the caller is a person and auth is bypassed (local single-user mode), or
 *  - the caller is a person (not a service account) in the org it was
 *    created in (org-id), or
 *  - the caller is a server admin and the sandbox's owner is a service
 *    account (to inspect and destroy what agents left behind).
 * A service account reaches only the sandboxes it owns (also when auth is
 * bypassed): another member's sandbox holds that person's git token. A
 * sandbox with neither label is reachable by nobody (every create path
 * records the owner).
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
  isServiceAccount: (userId: string) => boolean;
  isServerAdmin: (userId: string) => boolean;
}

/** The sandbox's recorded creator. */
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
  const ownerId = sandboxOwnerId(labels);
  // Before the bypass: a service account never reaches a person's sandbox,
  // local mode included.
  if (deps.isServiceAccount(userId)) return ownerId === userId;
  if (deps.isAuthBypassed()) return true;
  if (ownerId === userId) return true;
  if (isOwnerOrOrgMember(deps, userId, labels)) return true;
  return (
    ownerId !== undefined &&
    deps.isServiceAccount(ownerId) &&
    deps.isServerAdmin(userId)
  );
}

/**
 * The valid public keys whose owners may access the sandbox: the owner/org
 * half of the rule per key owner. It deliberately diverges from
 * `canAccessSandbox`: no auth bypass (SSH never had an open mode).
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
