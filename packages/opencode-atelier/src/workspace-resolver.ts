import { execSync } from "node:child_process";
import type { AtelierClient } from "./client.ts";
import { unwrap } from "./client.ts";
import type { AtelierConfig } from "./config.ts";

/**
 * Resolve the Atelier workspace ID from git context.
 *
 * Priority:
 *   1. Explicit `workspaceId` in config → skip resolution
 *   2. Call `GET /workspaces/match?remoteUrl=<origin>` → auto-match
 *   3. Return undefined if nothing matches
 */
export async function resolveWorkspaceId(
  config: AtelierConfig,
  getClient: () => AtelierClient,
  projectDir: string,
): Promise<string | undefined> {
  // 1. Explicit config takes priority
  if (config.workspaceId) {
    return config.workspaceId;
  }

  // 2. Detect git remote
  const remoteUrl = getGitRemoteUrl(projectDir);
  if (!remoteUrl) {
    console.log("[atelier] No git remote found, skipping workspace resolution");
    return undefined;
  }

  // 3. Ask the manager to match
  try {
    const client = getClient();
    const match = unwrap(
      await client.api.workspaces.match.get({
        query: { remoteUrl },
      }),
    );

    console.log(
      `[atelier] Resolved workspace: ${match.workspace.name} (${match.workspace.id})`,
    );
    return match.workspace.id;
  } catch {
    console.log(`[atelier] No workspace matched remote URL: ${remoteUrl}`);
    return undefined;
  }
}

function getGitRemoteUrl(cwd: string): string | null {
  try {
    return execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}
