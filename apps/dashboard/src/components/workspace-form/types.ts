export interface RepoEntry {
  url?: string;
  sourceId?: string;
  repo?: string;
  branch: string;
  clonePath: string;
}

export interface GitSourceInfo {
  id: string;
  type: string;
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
): Array<
  | { sourceId: string; repo: string; branch: string; clonePath: string }
  | { url: string; branch: string; clonePath: string }
> {
  return repos.map((r) => {
    if (r.sourceId && r.repo) {
      return {
        sourceId: r.sourceId,
        repo: r.repo,
        branch: r.branch,
        clonePath: r.clonePath,
      };
    }
    return {
      url: r.url ?? "",
      branch: r.branch,
      clonePath: r.clonePath,
    };
  });
}

export function createEmptyRepo(): RepoEntry {
  return {
    url: "",
    branch: "main",
    clonePath: "/workspace",
  };
}
