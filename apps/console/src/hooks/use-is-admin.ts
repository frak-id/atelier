import { useQuery } from "@tanstack/react-query";
import { currentUserQuery } from "@/api/queries/auth";

/** Server admin (owner of the default org): images, prebuild deletion, server
 * config and raw toolset publishing are theirs alone, so the console hides
 * those actions from everyone else. */
export function useIsAdmin(): boolean {
  return useAdminStatus().isAdmin;
}

/** `useIsAdmin` plus whether the current user is still loading, for pages
 * that must not flash "admins only" on a hard reload. */
export function useAdminStatus(): { isAdmin: boolean; isPending: boolean } {
  const { data: currentUser, isPending } = useQuery(currentUserQuery());
  return { isAdmin: currentUser?.admin === true, isPending };
}
