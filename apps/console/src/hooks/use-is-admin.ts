import { useQuery } from "@tanstack/react-query";
import { currentUserQuery } from "@/api/queries/auth";

/** Server admin (owner of the default org): images, prebuild deletion, server
 * config and raw toolset publishing are theirs alone, so the console hides
 * those actions from everyone else. */
export function useIsAdmin(): boolean {
  const { data: currentUser } = useQuery(currentUserQuery());
  return currentUser?.admin === true;
}
