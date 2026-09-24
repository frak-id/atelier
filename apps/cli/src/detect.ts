/** Best-effort setup-command detection from a local checkout. Pure filesystem
 * sniffing (lockfiles + manifests), with no network and no execution. The
 * result is only a *suggestion*: the caller lets the user trim it or add their
 * own commands before anything is baked. The rules themselves are shared with
 * the console's GitHub-backed detection (`@atelier/spec/repo-prebuild`). */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectSetupSteps as detectFrom } from "@atelier/spec/repo-prebuild";

export function detectSetupSteps(root: string): string[] {
  return detectFrom((f) => existsSync(join(root, f)));
}
