import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/client";
import { queryKeys } from "./keys";

interface CurrentUser {
  id: string;
  username: string;
  avatarUrl: string;
  email: string;
  /** Server admin (owner of the default org): may change server config,
   * manage images and delete prebuilds / raw toolsets. */
  admin: boolean;
}

/** sessionStorage flag: the server ended the session because GitHub no
 * longer accepts the person's token. The login page explains it once. */
export const GITHUB_SESSION_EXPIRED_KEY = "atelier_github_session_expired";

/** The `error` code of an Eden error body, if any. */
function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("value" in error)) return;
  const { value } = error;
  if (!value || typeof value !== "object" || !("error" in value)) return;
  return typeof value.error === "string" ? value.error : undefined;
}

async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const { data, error } = await api.auth.me.get();
  if (error) {
    if (errorCode(error) === "GITHUB_SESSION_EXPIRED") {
      sessionStorage.setItem(GITHUB_SESSION_EXPIRED_KEY, "1");
    }
    return null;
  }
  if (!data || !("id" in data)) return null;
  return data as CurrentUser;
}

export function currentUserQuery() {
  return queryOptions({
    queryKey: queryKeys.auth.me,
    queryFn: fetchCurrentUser,
    staleTime: 60_000,
    // The server checks the person's GitHub token on this call, so an open
    // tab notices a revoked one (polling pauses while the tab is hidden; a
    // focus refetches once stale).
    refetchInterval: 5 * 60_000,
    retry: false,
  });
}
