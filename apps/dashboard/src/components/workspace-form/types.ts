export interface RepoEntry {
  url: string;
  branch: string;
  clonePath: string;
}

export function parseRepoFullName(fullName: string): {
  owner: string;
  repo: string;
} {
  const parts = fullName.split("/");
  return { owner: parts[0] || "", repo: parts[1] || "" };
}

export function serializeRepos(
  repos: RepoEntry[],
): Array<{ url: string; branch: string; clonePath: string }> {
  return repos.map((r) => ({
    url: r.url,
    branch: r.branch,
    clonePath: r.clonePath,
  }));
}

export function createEmptyRepo(): RepoEntry {
  return {
    url: "",
    branch: "main",
    clonePath: "/workspace",
  };
}
