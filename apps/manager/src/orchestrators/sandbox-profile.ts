import type { Workspace } from "../schemas/index.ts";

/**
 * Discriminated union replacing the `system?: boolean` flag.
 * Every sandbox spawn starts with an intent.
 */
export type SandboxIntent =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "system" };

/**
 * Resolved capability set — computed ONCE at spawn entry.
 * Drives all downstream behavior without branching on "is it system?"
 */
export interface SandboxProfile {
  intent: SandboxIntent;
  workspace?: Workspace;
  /** Services to start post-boot (e.g. ["vscode", "opencode"] or ["opencode"]) */
  services: string[];
  /** Whether to clone repos into the VM */
  cloneRepos: boolean;
  /** Whether to push workspace secrets */
  pushSecrets: boolean;
  /** Whether to push git credentials from git sources */
  pushGitCredentials: boolean;
  /** Whether to push file secrets */
  pushFileSecrets: boolean;
  /** Whether to push oh-my-opencode cache */
  pushOhMyOpenCodeCache: boolean;
  /** Whether to generate and push SANDBOX.md */
  pushSandboxMd: boolean;
  /** Whether to set up swap */
  setupSwap: boolean;
  /** Whether to expand the filesystem post-boot */
  expandFilesystem: boolean;
  /** Whether to resize volume before boot */
  resizeVolume: boolean;
  /** Route registration pattern */
  routePattern: "full" | "opencode-only";
}

/**
 * Resolve a spawn request into a capability profile.
 * Called once at the start of spawn — all downstream code reads the profile
 * instead of checking `isSystem` / `usedPrebuild` / `workspace` individually.
 */
export function resolveProfile(
  intent: SandboxIntent,
  workspace: Workspace | undefined,
  usedPrebuild: boolean,
): SandboxProfile {
  const isWorkspace = intent.kind === "workspace" && !!workspace;

  return {
    intent,
    workspace,
    services: intent.kind === "system" ? ["opencode"] : ["vscode", "opencode"],
    cloneRepos:
      isWorkspace &&
      !usedPrebuild &&
      (workspace?.config.repos?.length ?? 0) > 0,
    pushSecrets: isWorkspace,
    pushGitCredentials: isWorkspace,
    pushFileSecrets: isWorkspace,
    pushOhMyOpenCodeCache: isWorkspace,
    pushSandboxMd: isWorkspace,
    setupSwap: isWorkspace,
    expandFilesystem: !usedPrebuild,
    resizeVolume: !usedPrebuild,
    routePattern: intent.kind === "system" ? "opencode-only" : "full",
  };
}
