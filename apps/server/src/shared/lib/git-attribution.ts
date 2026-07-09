/**
 * Pure git-attribution builders — the neutral zone shared by control/ (which
 * injects owner identity + credentials into a `SandboxSpec` at the seam) and
 * runtime/ (which injects credentials transiently into a prebuild pod). Lives
 * in shared/ so both modules can import it without crossing the control↔runtime
 * boundary (`scripts/check-boundaries.ts`).
 *
 * Reshaped from v1 `orchestrators/ports/guest-secrets.ts`
 * (`buildGitConfigFiles`). No config or identity-table dependency: the caller
 * resolves the identity/token and passes plain values.
 *
 * Mount note: the PVC mounts at `/home/dev` only. These files land on the
 * container's ephemeral rootfs (`/etc/…`), so a PVC snapshot never captures
 * them — but the prebuild path still scrubs them explicitly before snapshot
 * (`GIT_CREDENTIALS_PATH`) as defense-in-depth.
 */
import type { FileEntry } from "@atelier/spec";

/** Display hint: the human owner of a sandbox (the git user). */
export const OWNER_ANNOTATION = "atelier.dev/owner";
/** Display hint: the owner's git email. */
export const OWNER_EMAIL_ANNOTATION = "atelier.dev/owner-email";
/** Opaque metadata: the owner's user id, so resume can re-resolve their token
 * regardless of who triggers the resume. */
export const OWNER_ID_METADATA = "atelier.dev/owner-id";

/** Credential store file — the ONLY token-bearing file; scrubbed pre-snapshot. */
export const GIT_CREDENTIALS_PATH = "/etc/sandbox/secrets/git-credentials";
const GITCONFIG_PATH = "/etc/gitconfig";

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Build the guest git files: a global `/etc/gitconfig` (`[user]` identity and,
 * when a token is present, a `store` credential helper) plus the credential
 * store itself. Returns `[]` when there is neither identity nor token to write.
 */
export function buildGitAttributionFiles(opts: {
  identity?: GitIdentity;
  githubToken?: string;
}): FileEntry[] {
  const sections: string[] = [];
  if (opts.githubToken) {
    sections.push(
      "[credential]",
      `\thelper = store --file=${GIT_CREDENTIALS_PATH}`,
    );
  }
  if (opts.identity) {
    sections.push(
      "[user]",
      `\temail = ${opts.identity.email}`,
      `\tname = ${opts.identity.name}`,
    );
  }
  if (sections.length === 0) return [];
  sections.push("");

  const files: FileEntry[] = [
    { path: GITCONFIG_PATH, content: sections.join("\n"), owner: "root" },
  ];
  if (opts.githubToken) {
    files.push({
      path: GIT_CREDENTIALS_PATH,
      content: `https://x-access-token:${opts.githubToken}@github.com\n`,
      mode: "0600",
      owner: "dev",
    });
  }
  return files;
}
