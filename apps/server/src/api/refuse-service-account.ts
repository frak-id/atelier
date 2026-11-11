import type { AuthUser } from "../control/index.ts";
import { ForbiddenError } from "../shared/errors.ts";

/** Keys, orgs and shared artefacts (toolboxes, toolsets, images) are managed
 * by people: a service account never does, whatever its key scope or role.
 * It can still use what exists. */
export function refuseServiceAccount(user: AuthUser, what: string): void {
  if (user.kind === "service") {
    throw new ForbiddenError(
      `A service account can't manage ${what}: ask a server admin (Settings > Service accounts)`,
    );
  }
}
