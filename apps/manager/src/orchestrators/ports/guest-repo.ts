import { VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/index.ts";
import type { RepoConfig } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("guest-repo");

export function buildAuthenticatedGitUrl(
  repoUrl: string,
  githubAccessToken?: string,
): string {
  if (githubAccessToken && repoUrl.includes("github.com")) {
    return repoUrl.replace(
      "https://",
      `https://x-access-token:${githubAccessToken}@`,
    );
  }
  return repoUrl;
}

export async function cloneRepository(
  agent: AgentClient,
  sandboxId: string,
  repo: RepoConfig,
  githubAccessToken?: string,
): Promise<void> {
  const clonePath = `${VM.HOME}${repo.clonePath}`;
  const gitUrl = buildAuthenticatedGitUrl(repo.url, githubAccessToken);
  const branch = repo.branch;

  log.info({ sandboxId, branch, clonePath }, "Cloning repository");

  await agent.exec(sandboxId, `rm -rf ${clonePath}`);

  // Full clone (no `--depth 1`) so `git rev-list --max-parents=0 HEAD`
  // returns the same root commit hash as the user's local clone. OpenCode
  // hashes that into the project_id (see opencode `project/project.ts`
  // `fromDirectory`), and `/sync/replay` FK-fails on `session.project_id`
  // if the local and remote ids differ. Trade-off: bigger initial clone,
  // but git-pack stays small in practice and the cost only hits once at
  // sandbox spawn (and is short-circuited entirely when prebuild snapshots
  // are warm).
  const result = await agent.exec(
    sandboxId,
    `git clone -b ${branch} ${gitUrl} ${clonePath}`,
    { timeout: 120000 },
  );

  if (result.exitCode !== 0) {
    log.error({ sandboxId, stderr: result.stderr }, "Git clone failed");
    throw new Error(`Git clone failed: ${result.stderr}`);
  }

  await agent.exec(sandboxId, `chown -R dev:dev ${clonePath}`);
  await agent.exec(
    sandboxId,
    `git config --global --add safe.directory ${clonePath}`,
    { user: "dev" },
  );

  log.info({ sandboxId, clonePath }, "Repository cloned successfully");
}

export async function sanitizeGitRemoteUrls(
  agent: AgentClient,
  sandboxId: string,
  repos: RepoConfig[],
): Promise<void> {
  if (repos.length === 0) return;

  for (const repo of repos) {
    const clonePath = `${VM.HOME}${repo.clonePath}`;
    const result = await agent.exec(
      sandboxId,
      `git -C '${clonePath}' remote get-url origin 2>/dev/null`,
      { timeout: 5000, user: "dev" },
    );

    if (result.exitCode !== 0) continue;

    const currentUrl = result.stdout.trim();
    const cleanUrl = currentUrl.replace(/^(https?:\/\/)[^@]+@/, "$1");

    if (cleanUrl !== currentUrl) {
      await agent.exec(
        sandboxId,
        `git -C '${clonePath}' remote set-url origin '${cleanUrl}'`,
        { timeout: 5000, user: "dev" },
      );

      log.debug({ sandboxId, clonePath }, "Sanitized git remote URL");
    }
  }
}
