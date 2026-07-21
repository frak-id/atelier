import { queryOptions } from "@tanstack/react-query";
import { api } from "@/api/client";
import { queryKeys } from "./keys";

interface CurrentUser {
  id: string;
  username: string;
  avatarUrl: string;
  email: string;
}

async function fetchCurrentUser(): Promise<CurrentUser | null> {
  const { data, error } = await api.auth.me.get();
  if (error || !data || !("id" in data)) return null;
  return data as CurrentUser;
}

export function currentUserQuery() {
  return queryOptions({
    queryKey: queryKeys.auth.me,
    queryFn: fetchCurrentUser,
    staleTime: 60_000,
    retry: false,
  });
}
