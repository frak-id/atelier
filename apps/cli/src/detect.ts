/** Best-effort setup-command detection from a local checkout. Pure filesystem
 * sniffing (lockfiles + manifests) — no network, no execution. The result is
 * only ever a *suggestion*: the caller lets the user trim it or add their own
 * commands before anything is baked. */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Ordered detectors: the first matching lockfile/manifest in each ecosystem
 * wins, so a repo yields at most one install step per stack it uses. */
export function detectSetupSteps(root: string): string[] {
  const has = (f: string): boolean => existsSync(join(root, f));
  const steps: string[] = [];

  // Node — pick the package manager from its lockfile, else a plain install.
  if (has("package.json")) {
    if (has("bun.lockb") || has("bun.lock")) steps.push("bun install");
    else if (has("pnpm-lock.yaml"))
      steps.push("pnpm install --frozen-lockfile");
    else if (has("yarn.lock")) steps.push("yarn install --frozen-lockfile");
    else if (has("package-lock.json")) steps.push("npm ci");
    else steps.push("npm install");
  }

  // Python — one of poetry / pipenv / pip, in that precedence.
  if (has("poetry.lock")) steps.push("poetry install");
  else if (has("Pipfile")) steps.push("pipenv install --deploy");
  else if (has("requirements.txt"))
    steps.push("pip install -r requirements.txt");
  else if (has("pyproject.toml")) steps.push("pip install .");

  if (has("Cargo.toml")) steps.push("cargo fetch");
  if (has("go.mod")) steps.push("go mod download");
  if (has("Gemfile")) steps.push("bundle install");
  if (has("composer.json")) steps.push("composer install");

  return steps;
}
