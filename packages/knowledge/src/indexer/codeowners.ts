/**
 * CODEOWNERS: a small gitignore-style matcher (leading `/`, trailing `/`,
 * `*`, `**`, `?`) plus "last matching rule wins" resolution, the same
 * semantics GitHub uses to pick an owner for a path.
 */
import type { EntityInput, FactInput, Readers } from "../types.ts";
import { readRepoFile } from "./files.ts";

const CODEOWNERS_LOCATIONS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
];

export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

/** Finds the first present CODEOWNERS file, in GitHub's lookup order. */
export function codeownersCandidates(): readonly string[] {
  return CODEOWNERS_LOCATIONS;
}

export function parseCodeowners(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

/**
 * Converts a gitignore-style pattern into a regex that matches either the
 * exact repo-relative path or that path as a directory prefix (so testing
 * a directory and testing a file inside it both work with one matcher).
 */
function patternToRegex(pattern: string): RegExp {
  let p = pattern;
  if (p.endsWith("/")) p = p.slice(0, -1);
  const anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);

  let body = "";
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      if (p[i + 2] === "/") {
        body += "(?:.*/)?";
        i += 3;
        continue;
      }
      body += ".*";
      i += 2;
      continue;
    }
    if (c === "*") {
      body += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      body += "[^/]";
      i++;
      continue;
    }
    body += (c ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${body}(?:/.*)?$`);
}

/** Does `pattern` cover repo-relative `path` (a directory or a file)? */
export function matchesPattern(pattern: string, path: string): boolean {
  return patternToRegex(pattern).test(path);
}

/**
 * Resolves the winning rule for `dirPath` (a package/crate directory,
 * `""` for the repo root): tests both the directory itself and a probe
 * file inside it, last match wins — CODEOWNERS' own precedence rule.
 */
export function resolveOwners(
  rules: CodeownersRule[],
  dirPath: string,
): CodeownersRule | undefined {
  const probe = dirPath === "" ? "__probe__" : `${dirPath}/__probe__`;
  let winner: CodeownersRule | undefined;
  for (const rule of rules) {
    if (
      matchesPattern(rule.pattern, dirPath) ||
      matchesPattern(rule.pattern, probe)
    ) {
      winner = rule;
    }
  }
  return winner;
}

/** `"@org/slug"` → `team:slug`; `"@login"`/`"email"` → `person:<id>`. */
export function ownerEntityId(owner: string): string {
  if (owner.startsWith("@")) {
    const rest = owner.slice(1);
    const slash = rest.indexOf("/");
    if (slash >= 0) return `team:${rest.slice(slash + 1)}`;
    return `person:${rest}`;
  }
  return `person:${owner}`;
}

/** Human-readable name for an owner entity (last path segment / handle). */
export function ownerName(owner: string): string {
  return ownerEntityId(owner).split(":").slice(1).join(":");
}

export interface CodeownersFactsOpts {
  repo: string;
  readers: Readers;
  /** Package/crate directories to resolve owners for (`""` = root only). */
  dirs: { dir: string; entityId: string }[];
}

/**
 * Reads the first CODEOWNERS file present, resolves owners for every given
 * package/crate directory (`owns` facts, `{pattern}` attrs) and, if the
 * winning rule at repo root is a catch-all (`*` or `/**`), owner → repo too.
 */
export async function buildCodeownersFacts(
  root: string,
  files: Set<string>,
  opts: CodeownersFactsOpts,
): Promise<{ entities: EntityInput[]; facts: FactInput[] }> {
  const entities: EntityInput[] = [];
  const facts: FactInput[] = [];
  const location = CODEOWNERS_LOCATIONS.find((f) => files.has(f));
  if (!location) return { entities, facts };
  const content = await readRepoFile(root, location);
  if (content === undefined) return { entities, facts };
  const rules = parseCodeowners(content);

  const seenOwners = new Set<string>();
  const emitOwner = (owner: string): string => {
    const id = ownerEntityId(owner);
    if (!seenOwners.has(id)) {
      seenOwners.add(id);
      entities.push({
        id,
        type: id.startsWith("team:") ? "team" : "person",
        name: ownerName(owner),
        attrs: {},
        readers: opts.readers,
      });
    }
    return id;
  };

  for (const { dir, entityId } of opts.dirs) {
    const rule = resolveOwners(rules, dir);
    if (!rule) continue;
    for (const owner of rule.owners) {
      facts.push({
        type: "owns",
        from: emitOwner(owner),
        to: entityId,
        attrs: { pattern: rule.pattern },
        readers: opts.readers,
      });
    }
  }

  const rootRule = resolveOwners(rules, "");
  if (rootRule && (rootRule.pattern === "*" || rootRule.pattern === "/**")) {
    for (const owner of rootRule.owners) {
      facts.push({
        type: "owns",
        from: emitOwner(owner),
        to: `repo:${opts.repo}`,
        attrs: { pattern: rootRule.pattern },
        readers: opts.readers,
      });
    }
  }

  return { entities, facts };
}
