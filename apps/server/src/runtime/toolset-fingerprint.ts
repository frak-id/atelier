/**
 * Content fingerprint of a toolset's home path-sets, computed inside a pod
 * with the shell tools every base image has (GNU find, sort, sha256sum), so
 * it works with the agent already deployed. A toolset refresh hashes the
 * paths before and after its update steps: equal hashes mean the steps
 * changed nothing that a capture would save, so no artifact is pushed.
 *
 * What it hashes mirrors what `capture` stages (apps/agent/src/toolset.rs):
 * the same paths, minus the same default excludes, by type, mode, path,
 * symlink target and file content. Timestamps and owners are left out
 * because the artifact normalizes them anyway.
 */
import { ValidationError } from "../shared/errors.ts";

/** Mirror of the agent's `DEFAULT_EXCLUDES` (apps/agent/src/toolset.rs):
 * basenames/globs dropped from every capture at any depth. Keep in sync; a
 * drift only costs a spurious "changed" (an extra version), never a
 * missed change. */
const CAPTURE_EXCLUDES = [
  ".git",
  "auth.json",
  "credentials",
  ".credentials",
  ".git-credentials",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "*.pem",
  "*.key",
  ".env",
  ".env.*",
];

const HOME = "/home/dev";

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** A declared path made relative to `/home/dev`, with the agent's rules
 * (`rel_to_home`): `~/`, `$HOME/` and `/home/dev/` prefixes, nothing outside
 * the home, no `..`, never the whole home. */
export function homeRelative(path: string): string {
  const trimmed = path.trim();
  let rel: string;
  if (trimmed.startsWith("~/")) rel = trimmed.slice(2);
  else if (trimmed.startsWith("$HOME/")) rel = trimmed.slice(6);
  else if (trimmed.startsWith(`${HOME}/`)) rel = trimmed.slice(HOME.length + 1);
  else if (trimmed.startsWith("/")) {
    throw new ValidationError(`path '${trimmed}' is outside the home`);
  } else rel = trimmed;
  rel = rel.replace(/\/+$/, "");
  if (rel === "" || rel === "." || rel === "~" || rel === "$HOME") {
    throw new ValidationError("refusing to fingerprint the entire home");
  }
  if (rel.split("/").includes("..")) {
    throw new ValidationError(`path '${trimmed}' must not contain '..'`);
  }
  return rel;
}

/**
 * The bash script that prints one sha256 over `paths` (run as `dev`). Two
 * passes feed one hash: a sorted listing of every entry (type, mode, path,
 * symlink target), then the sorted per-file content hashes. Missing paths
 * simply list nothing, so a path appearing or disappearing changes the hash
 * too. `home` is only overridden by tests.
 */
export function fingerprintScript(paths: string[], home = HOME): string {
  const roots = paths.map((p) => shQuote(homeRelative(p))).join(" ");
  const prune = CAPTURE_EXCLUDES.map((name) => `-name ${shQuote(name)}`).join(
    " -o ",
  );
  const walk = `find ${roots} \\( ${prune} \\) -prune -o`;
  return [
    `cd ${shQuote(home)} || exit 1`,
    "{",
    `  ${walk} -printf '%y %m %p\\t%l\\n' 2>/dev/null | LC_ALL=C sort`,
    `  ${walk} -type f -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 -r sha256sum`,
    "} | sha256sum | cut -d' ' -f1",
  ].join("\n");
}

/** A fingerprint is one lowercase sha256 hex line; anything else (an exec
 * that printed nothing, a mock agent) is "unknown". */
export function parseFingerprint(stdout: string): string | undefined {
  const value = stdout.trim();
  return /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}
