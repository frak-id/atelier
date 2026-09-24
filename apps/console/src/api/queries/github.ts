import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api/client";
import { errorMessage } from "./error";
import { queryKeys } from "./keys";

type ReposResponse = NonNullable<
  Awaited<ReturnType<typeof api.api.github.repos.get>>["data"]
>;
/** One GitHub repository the signed-in user can access (server-trimmed). */
export type GitHubRepo = ReposResponse["repos"][number];
type GitHubRepoList = ReposResponse;

async function fetchRepos(refresh: boolean): Promise<GitHubRepoList> {
  const { data, error } = await api.api.github.repos.get({
    query: { refresh },
  });
  if (error)
    throw new Error(errorMessage(error, "Failed to load GitHub repositories"));
  return data;
}

/**
 * The signed-in user's GitHub repos (GET /api/github/repos), most recently
 * pushed first. Uses their OWN token server-side; `connected: false` means
 * there is no token for this account (not an error).
 */
export function githubReposQuery() {
  return queryOptions({
    queryKey: queryKeys.github.repos(),
    queryFn: () => fetchRepos(false),
    staleTime: 60_000,
    // A missing/revoked token or a rate limit won't fix itself on retry.
    retry: false,
  });
}

async function fetchInspection(owner: string, name: string, ref?: string) {
  const { data, error } = await api.api.github
    .repos({ owner })({ name })
    .get({ query: ref ? { ref } : {} });
  if (error)
    throw new Error(errorMessage(error, "Failed to inspect the repository"));
  return data;
}

/**
 * Branches + detected setup steps for one repo
 * (GET /api/github/repos/:owner/:name). Prefills the quick-prebuild form and
 * the one-click create. `ref` picks the branch whose root files are sniffed.
 */
export function githubRepoInspectQuery(
  owner: string,
  name: string,
  ref?: string,
) {
  return queryOptions({
    queryKey: queryKeys.github.inspect(owner, name, ref),
    queryFn: () => fetchInspection(owner, name, ref),
    staleTime: 60_000,
    retry: false,
  });
}

/** Explicit "refresh" button: bypasses the server's one-minute cache and
 * writes the fresh list straight into the query cache. */
export function useRefreshGithubRepos() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchRepos(true),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.github.repos(), data);
    },
    onError: (error) => toast.error(error.message),
  });
}
