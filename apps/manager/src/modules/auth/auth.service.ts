import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("auth-service");

const GITHUB_USER_ORGS_URL = "https://api.github.com/user/orgs";

interface GitHubOrg {
  login: string;
  id: number;
}

export async function isUserAuthorized(
  accessToken: string,
  username: string,
): Promise<boolean> {
  if (config.auth.allowedOrg) {
    try {
      const isOrgMember = await checkOrgMembership(
        accessToken,
        config.auth.allowedOrg,
      );
      if (isOrgMember) {
        log.info(
          { username, org: config.auth.allowedOrg },
          "User authorized via org membership",
        );
        return true;
      }
    } catch (error) {
      log.warn(
        { error, username },
        "Org membership check failed, falling back to username allowlist",
      );
    }
  }

  const isAllowed = config.auth.allowedUsers.includes(username);
  if (isAllowed) {
    log.info({ username }, "User authorized via username allowlist");
  } else {
    log.warn({ username }, "User not authorized");
  }
  return isAllowed;
}

async function checkOrgMembership(
  accessToken: string,
  orgName: string,
): Promise<boolean> {
  const response = await fetch(GITHUB_USER_ORGS_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub orgs fetch failed: ${response.status}`);
  }

  const orgs = (await response.json()) as GitHubOrg[];
  return orgs.some((org) => org.login.toLowerCase() === orgName.toLowerCase());
}
