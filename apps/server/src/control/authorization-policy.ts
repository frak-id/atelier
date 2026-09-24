/**
 * Post-GitHub-OAuth authorization gate: is this GitHub user allowed to use
 * the platform at all (org membership or a static allowlist).
 */
import { config, isAuthBypassed } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { githubApiGet } from "./github-api.ts";

const log = createChildLogger("authorization-policy");

interface GitHubOrg {
  login: string;
  id: number;
}

export async function isUserAuthorized(
  accessToken: string,
  username: string,
): Promise<boolean> {
  if (isAuthBypassed()) return true;

  if (config.auth.allowedOrg) {
    try {
      const isOrgMember = await checkOrgMembership(
        accessToken,
        config.auth.allowedOrg,
      );
      if (isOrgMember) return true;
    } catch (error) {
      log.warn(
        { error, username },
        "Org membership check failed, falling back to username allowlist",
      );
    }
  }

  const isAllowed = config.auth.allowedUsers.includes(username);
  if (!isAllowed) log.warn({ username }, "User not authorized");
  return isAllowed;
}

async function checkOrgMembership(
  accessToken: string,
  orgName: string,
): Promise<boolean> {
  const response = await githubApiGet(accessToken, "/user/orgs");
  if (!response.ok) {
    throw new Error(`GitHub orgs fetch failed: ${response.status}`);
  }
  const orgs = (await response.json()) as GitHubOrg[];
  return orgs.some((org) => org.login.toLowerCase() === orgName.toLowerCase());
}
