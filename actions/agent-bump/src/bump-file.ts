/**
 * What the agent writes once its updates are committed (`BumpFile`): what it
 * updated and what that took, what it held back and why, and the checks it ran.
 * The job checks it before pushing anything, and builds the pull request's body
 * from it (pull-request.ts).
 */

const CHECK_STATUSES = ["passed", "failed", "pre-existing", "skipped"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface Update {
  name: string;
  /** npm, cargo, docker, github-actions, tool…: the agent's word. */
  ecosystem: string;
  from: string;
  to: string;
  /** Where the agent read what changed: a release, a changelog. */
  changelog?: string;
  /** What changed that matters to the repository, and what was done about it:
   * a config migrated, a deprecated API replaced. */
  notes?: string;
}

interface Held {
  name: string;
  ecosystem: string;
  from: string;
  /** The version it would have taken. */
  to?: string;
  reason: string;
}

interface Check {
  command: string;
  /** `pre-existing`: it fails at the base too, so no update is to blame. */
  status: CheckStatus;
  note?: string;
}

export interface BumpFile {
  title: string;
  summary: string;
  updates: Update[];
  held: Held[];
  checks: Check[];
}

/** A pull request's title, at most. */
const MAX_TITLE = 120;
/** A name or a version, at most: what goes in a table cell. */
const MAX_FIELD = 200;

type Fields = Record<string, unknown>;

/** The agent's file, checked: an error names what's wrong, for the agent to
 * write it again. */
export function parseBumpFile(text: string): BumpFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`not JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) throw new Error("not a JSON object");
  const title = required(parsed, "title", "title").split("\n")[0]?.trim();
  return {
    title: (title ?? "").slice(0, MAX_TITLE),
    summary: required(parsed, "summary", "summary"),
    updates: list(parsed, "updates", (item, at) => ({
      name: short(item, "name", at),
      ecosystem: short(item, "ecosystem", at),
      from: short(item, "from", at),
      to: short(item, "to", at),
      ...link(item, "changelog", at),
      ...optional(item, "notes", at),
    })),
    held: list(parsed, "held", (item, at) => ({
      name: short(item, "name", at),
      ecosystem: short(item, "ecosystem", at),
      from: short(item, "from", at),
      ...(item.to === undefined || item.to === ""
        ? {}
        : { to: short(item, "to", at) }),
      reason: required(item, "reason", at),
    })),
    checks: list(parsed, "checks", (item, at) => {
      const status = item.status;
      if (!CHECK_STATUSES.includes(status as CheckStatus))
        throw new Error(
          `\`${at}.status\` must be one of ${CHECK_STATUSES.join(", ")}`,
        );
      return {
        command: required(item, "command", at),
        status: status as CheckStatus,
        ...optional(item, "note", at),
      };
    }),
  };
}

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list<T>(
  parsed: Fields,
  key: string,
  read: (item: Fields, at: string) => T,
): T[] {
  const value = parsed[key];
  if (!Array.isArray(value)) throw new Error(`\`${key}\` must be an array`);
  return value.map((item, index) => {
    const at = `${key}[${index}]`;
    if (!isObject(item)) throw new Error(`\`${at}\` must be an object`);
    return read(item, at);
  });
}

function required(item: Fields, key: string, at: string): string {
  const value = item[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(
      `\`${at === key ? key : `${at}.${key}`}\` must be a non-empty string`,
    );
  return value.trim();
}

/** A name or a version: one line, for a table cell. */
function short(item: Fields, key: string, at: string): string {
  const value = required(item, key, at);
  if (value.includes("\n") || value.length > MAX_FIELD)
    throw new Error(
      `\`${at}.${key}\` must be one line of at most ${MAX_FIELD} characters`,
    );
  return value;
}

function optional<K extends string>(
  item: Fields,
  key: K,
  at: string,
): Partial<Record<K, string>> {
  const value = item[key];
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string")
    throw new Error(`\`${at}.${key}\` must be a string`);
  return { [key]: value.trim() } as Partial<Record<K, string>>;
}

/** An https link, or none: it goes in the body as a markdown link. */
function link<K extends string>(
  item: Fields,
  key: K,
  at: string,
): Partial<Record<K, string>> {
  const value = item[key];
  if (value === undefined || value === null || value === "") return {};
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value.trim()) : undefined;
  } catch {}
  if (url?.protocol !== "https:")
    throw new Error(`\`${at}.${key}\` must be an https URL`);
  return { [key]: url.href } as Partial<Record<K, string>>;
}

export type UpdateKind = "major" | "minor" | "patch";

/** A version's numbers, after a range operator or a `v`: `^2.6.4`, `v4`,
 * `26-trixie-slim`. */
const VERSION = /^[\s^~>=<v]*(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

/**
 * How big the update from `from` to `to` is, by their numbers: undefined when
 * either has none (a digest, a branch) or they're the same (a suffix changed).
 * Below 1.0.0, a change of the first non-zero number is a major one, as semver
 * ranges treat it.
 */
export function updateKind(from: string, to: string): UpdateKind | undefined {
  const a = VERSION.exec(from);
  const b = VERSION.exec(to);
  if (!a || !b) return undefined;
  const [x1, x2, x3] = a.slice(1).map((part) => Number(part ?? 0));
  const [y1, y2, y3] = b.slice(1).map((part) => Number(part ?? 0));
  if (x1 !== y1) return "major";
  if (x2 !== y2) return x1 === 0 ? "major" : "minor";
  if (x3 !== y3) return x1 === 0 && x2 === 0 ? "major" : "patch";
  return undefined;
}
