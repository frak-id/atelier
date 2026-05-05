import type { PluginInput } from "@opencode-ai/plugin";
import type { AtelierClient } from "./client.ts";
import { unwrap } from "./client.ts";
import type { AtelierConfig } from "./config.ts";
import { logger } from "./logger.ts";

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
  $: PluginInput["$"],
): Promise<string | undefined> {
  if (config.workspaceId) {
    return config.workspaceId;
  }

  const remoteUrl = await getGitRemoteUrl($, projectDir);
  if (!remoteUrl) {
    logger.info("No git remote found, skipping workspace resolution");
    return undefined;
  }

  try {
    const client = getClient();
    const match = unwrap(
      await client.api.workspaces.match.get({
        query: { remoteUrl },
      }),
    );

    logger.info(
      `Resolved workspace: ${match.workspace.name} (${match.workspace.id})`,
    );
    return match.workspace.id;
  } catch {
    logger.info(`No workspace matched remote URL: ${remoteUrl}`);
    return undefined;
  }
}

async function getGitRemoteUrl(
  $: PluginInput["$"],
  cwd: string,
): Promise<string | null> {
  try {
    // BunShell is async and non-blocking; .nothrow() so we can detect "no remote"
    // (exit code 1 from git) without an exception.
    const result = await $`git remote get-url origin`
      .cwd(cwd)
      .nothrow()
      .quiet();
    if (result.exitCode !== 0) return null;
    const url = result.stdout.toString("utf-8").trim();
    return url || null;
  } catch (err) {
    logger.warn(`git remote lookup failed: ${err}`);
    return null;
  }
}
