/**
 * Codebase recaps: LLM-written docs about a repo, produced by a headless
 * `pi` that explores the checkout and decides its own granularity ("areas"
 * — one per package/app, or one for a small repo). See
 * `docs/proposals/company-knowledge.md` §"Codebase recaps".
 *
 * Three kinds of agent call (the `agent` seam, injectable for tests):
 * - `plan`: pi explores the checkout and returns `{"areas":[...]}` JSON.
 * - `area`: pi writes one area's markdown recap.
 * - `overview`: no tools — synthesises the repo overview from the areas'
 *   recaps it is given in the prompt.
 *
 * Recaps are stored twice: full bodies in `hub_recap_areas` (so the next
 * incremental run has something to diff against and to keep on a failed
 * regeneration), and split into `## `-heading chunks as documents in the
 * `recap:<repo>` collection (what search actually serves).
 */
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DocumentInput,
  DocumentStore,
  EntityInput,
  KnowledgeDb,
  RepositoryIndex,
} from "@atelier/knowledge";
import { githubSlug, listRepoFiles, sha256 } from "@atelier/knowledge";
import type { LlmConfig, RepoConfig } from "../config.ts";
import { createLogger } from "../logger.ts";
import { runPi } from "./pi.ts";

const log = createLogger("recaps");

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const OVERVIEW_ID = "overview";
const MAX_DIFF_BYTES = 60 * 1024;
const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "Gemfile.lock",
]);

const AREA_SECTIONS = [
  "Purpose",
  "Architecture",
  "Key flows",
  "Entry points",
  "Conventions",
  "Gotchas",
  "Connections",
];

export interface RecapArea {
  id: string;
  title: string;
  paths: string[];
  why: string;
  body: string;
  revision: string;
}

export interface RecapPlanArea {
  id: string;
  title: string;
  paths: string[];
  why?: string;
}

export type AgentRequestKind = "plan" | "area" | "overview";

export interface AgentRequest {
  kind: AgentRequestKind;
  prompt: string;
  cwd: string;
  tools: string[];
}

export type AgentFn = (req: AgentRequest) => Promise<string>;

export interface RecapReport {
  planned: boolean;
  regenerated: string[];
  kept: string[];
  failed: { id: string; error: string }[];
  durationMs: number;
}

export interface RecapChanges {
  files: string[];
  diff: (paths: string[]) => Promise<string>;
}

export interface RecapUpdateInput {
  repo: RepoConfig;
  /** The checkout on disk, pi's cwd. */
  dir: string;
  revision: string;
  index: RepositoryIndex;
  force: boolean;
  /** Resolves the files/diff changed since `base`. */
  changes: (base: string) => Promise<RecapChanges>;
}

export interface RecapRunnerDeps {
  db: KnowledgeDb;
  documents: DocumentStore;
  llm: LlmConfig;
  apiKey?: string;
  piCommand: string[];
  concurrency: number;
  timeoutMinutes: number;
  maxAreas: number;
  /** Known secrets, redacted from every agent output before storing. */
  secrets?: (string | undefined)[];
  /** Injectable for tests; default spawns `pi` (read-only tools only). */
  agent?: AgentFn;
}

interface AreaRow {
  repo: string;
  id: string;
  title: string;
  paths: string;
  why: string;
  body: string;
  revision: string;
  updated_at: number;
}

class RecapPlanError extends Error {}

function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.replaceAll(secret, "***");
  }
  return out;
}

function isKebabCase(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id);
}

/** Extracts the last fenced ```json block, else the outermost `{...}`. */
function extractJson(text: string): string {
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (fences.length > 0) {
    const last = fences.at(-1)?.[1];
    if (last) return last.trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new RecapPlanError("no JSON object found in the plan output");
  }
  return text.slice(start, end + 1);
}

function validatePlan(raw: unknown, maxAreas: number): RecapPlanArea[] {
  if (
    !raw ||
    typeof raw !== "object" ||
    !Array.isArray((raw as { areas?: unknown }).areas)
  ) {
    throw new RecapPlanError('plan must be {"areas": [...]}');
  }
  const areas = (raw as { areas: unknown[] }).areas;
  if (areas.length === 0) throw new RecapPlanError("plan has no areas");
  if (areas.length > maxAreas) {
    throw new RecapPlanError(`plan has ${areas.length} areas, max ${maxAreas}`);
  }
  const seen = new Set<string>();
  const result: RecapPlanArea[] = [];
  for (const [i, entry] of areas.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new RecapPlanError(`areas[${i}] is not an object`);
    }
    const { id, title, paths, why } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !isKebabCase(id)) {
      throw new RecapPlanError(`areas[${i}].id must be kebab-case`);
    }
    if (id === OVERVIEW_ID) {
      throw new RecapPlanError('"overview" is a reserved area id');
    }
    if (seen.has(id)) throw new RecapPlanError(`duplicate area id ${id}`);
    seen.add(id);
    if (typeof title !== "string" || !title) {
      throw new RecapPlanError(`areas[${i}].title is required`);
    }
    if (
      !Array.isArray(paths) ||
      paths.length === 0 ||
      paths.some((p) => typeof p !== "string" || !p || p.startsWith("/"))
    ) {
      throw new RecapPlanError(
        `areas[${i}].paths must be non-empty relative globs`,
      );
    }
    result.push({
      id,
      title,
      paths: paths as string[],
      why: typeof why === "string" ? why : undefined,
    });
  }
  return result;
}

function parsePlan(text: string, maxAreas: number): RecapPlanArea[] {
  const jsonText = extractJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new RecapPlanError(`invalid JSON: ${(err as Error).message}`);
  }
  return validatePlan(parsed, maxAreas);
}

/** Matches a repo-relative path against one of an area's glob patterns. */
function areaCoversFile(area: { paths: string[] }, path: string): boolean {
  return area.paths.some((p) => new Bun.Glob(p).match(path));
}

/** Matches a directory (an entity's `attrs.path`) against an area's globs. */
function areaCoversDir(area: { paths: string[] }, dir: string): boolean {
  const probe = dir === "" ? "__probe__" : `${dir}/__probe__`;
  return area.paths.some((p) => {
    const glob = new Bun.Glob(p);
    return glob.match(dir) || glob.match(probe);
  });
}

function entityIdsForArea(
  index: RepositoryIndex,
  area: { paths: string[] },
): string[] {
  return index.entities
    .filter((e: EntityInput) => e.type === "package" || e.type === "crate")
    .filter((e) => {
      const path = e.attrs.path;
      return typeof path === "string" && areaCoversDir(area, path);
    })
    .map((e) => e.id);
}

function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_BYTES) return diff;
  return `${diff.slice(0, MAX_DIFF_BYTES)}\n... (truncated)`;
}

/** Splits a recap body into `## `-heading chunks for documents. */
function chunkByHeading(
  body: string,
  fallbackHeading: string,
): { heading: string; content: string }[] {
  const lines = body.split(/\r?\n/);
  const chunks: { heading: string; content: string[] }[] = [];
  let current: { heading: string; content: string[] } | undefined;
  for (const line of lines) {
    const match = /^##\s+(.*)$/.exec(line.trim());
    if (match) {
      if (current) chunks.push(current);
      current = { heading: (match[1] ?? "").trim(), content: [] };
    } else if (current) {
      current.content.push(line);
    }
  }
  if (current) chunks.push(current);
  if (chunks.length === 0) {
    return [{ heading: fallbackHeading, content: body.trim() }];
  }
  return chunks
    .map((c) => ({ heading: c.heading, content: c.content.join("\n").trim() }))
    .filter((c) => c.content.length > 0);
}

/** Directories worth showing in the size table: at least this share of lines. */
const SIZE_TABLE_MIN_SHARE = 0.01;
const SIZE_TABLE_MAX_DEPTH = 4;
const SIZE_TABLE_MAX_ROWS = 80;
/** Rough target for one area; bigger apps get split along their modules. */
export const AREA_TARGET_LINES = 10_000;

/**
 * Files and lines per directory (depth ≤ 4, ≥ 1% of the repo's lines), so
 * the planner can size areas instead of mapping one area per package.
 */
export async function directorySizes(
  dir: string,
): Promise<{ path: string; files: number; lines: number }[]> {
  let files: string[];
  try {
    files = await listRepoFiles(dir);
  } catch {
    return [];
  }
  const totals = new Map<string, { files: number; lines: number }>();
  let all = 0;
  for (const file of files) {
    let lines = 0;
    try {
      const text = await readFile(join(dir, file), "utf8");
      if (text.length > 1_000_000 || text.includes("\u0000")) continue;
      lines = text.split("\n").length;
    } catch {
      continue;
    }
    all += lines;
    const parts = file.split("/").slice(0, -1);
    for (
      let depth = 1;
      depth <= Math.min(parts.length, SIZE_TABLE_MAX_DEPTH);
      depth++
    ) {
      const key = parts.slice(0, depth).join("/");
      const entry = totals.get(key) ?? { files: 0, lines: 0 };
      entry.files++;
      entry.lines += lines;
      totals.set(key, entry);
    }
  }
  return [...totals]
    .filter(([, t]) => all > 0 && t.lines / all >= SIZE_TABLE_MIN_SHARE)
    .sort((a, b) => b[1].lines - a[1].lines)
    .slice(0, SIZE_TABLE_MAX_ROWS)
    .map(([path, t]) => ({ path, ...t }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Model output is meant to be pure markdown, but models narrate ("I'll
 * write the recap now."). Drops a wrapping ```markdown fence and anything
 * before the first heading.
 */
export function cleanMarkdown(text: string): string {
  let out = text.trim();
  const fenced = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(out);
  if (fenced?.[1]) out = fenced[1].trim();
  const firstHeading = out.search(/^#{1,6}\s/m);
  if (firstHeading > 0) out = out.slice(firstHeading);
  return out;
}

async function buildStructuralMap(
  index: RepositoryIndex,
  dir: string,
): Promise<string> {
  const lines: string[] = [`Repository: ${index.repo}@${index.revision}`];
  try {
    const topDirs = readdirSync(dir, { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          !d.name.startsWith(".") &&
          d.name !== "node_modules",
      )
      .map((d) => d.name)
      .sort();
    if (topDirs.length)
      lines.push(`Top-level directories: ${topDirs.join(", ")}`);
  } catch {
    // best-effort
  }

  const packages = index.entities.filter(
    (e) => e.type === "package" || e.type === "crate",
  );
  if (packages.length) {
    lines.push("", "Packages/crates:");
    for (const pkg of packages) {
      const deps = index.facts
        .filter((f) => f.type === "depends_on" && f.from === pkg.id)
        .map((f) => f.to);
      const depsText = deps.length ? ` deps: ${deps.join(", ")}` : "";
      lines.push(`- ${pkg.id} (${pkg.attrs.path ?? ""})${depsText}`);
    }
  }

  const owns = index.facts.filter((f) => f.type === "owns");
  if (owns.length) {
    lines.push("", "CODEOWNERS:");
    for (const fact of owns) lines.push(`- ${fact.from} owns ${fact.to}`);
  }

  const sizes = await directorySizes(dir);
  if (sizes.length) {
    lines.push("", "Size by directory (files, lines):");
    for (const s of sizes) {
      lines.push(`- ${s.path}: ${s.files} files, ${s.lines} lines`);
    }
  }
  return lines.join("\n");
}

function planPrompt(
  repo: string,
  structuralMap: string,
  maxAreas: number,
  retryError?: string,
): string {
  const errorNote = retryError
    ? `\n\nYour previous answer was invalid: ${retryError}\nFix it and answer again.`
    : "";
  return `You are exploring the repository "${repo}" to plan its codebase
recaps: written summaries an engineer or agent can read instead of the
code. Decide the granularity yourself: a small, single-purpose repo needs
just one area; a monorepo should get one area per app/package, or one
area grouping several small related packages, so each area is small
enough to explain in a single recap document. Use the size table: aim for
roughly ${AREA_TARGET_LINES} lines of code per area (tests included). Split
an app or package that is much larger along its internal modules (e.g.
"apps/server/src/runtime/**" and "apps/server/src/control/**" as separate
areas), and group small packages together.

Structural map (from the repo's manifests, imports and CODEOWNERS):

${structuralMap}

Explore the checkout with your read-only tools as needed, then answer
with ONLY a JSON object (no prose, no markdown around it) of the shape:

{"areas":[{"id":"kebab-case-id","title":"Human title","paths":["apps/server/**"],"why":"one line"}]}

Rules: ids are unique kebab-case and never "overview" (reserved for the
repo-wide recap); paths are relative glob patterns covering the area, not
absolute; at most ${maxAreas} areas; every area must be explainable in one
recap document.${errorNote}`;
}

function areaPrompt(opts: {
  repo: string;
  area: RecapPlanArea;
  otherAreas: { id: string; title: string; paths: string[] }[];
  previous?: { body: string; changedFiles: string[]; diff: string };
}): string {
  const other = opts.otherAreas
    .map((a) => `- ${a.id} (${a.title}): ${a.paths.join(", ")}`)
    .join("\n");
  const sections = AREA_SECTIONS.map((s) => `## ${s}`).join("\n");
  const incremental = opts.previous
    ? `

This area was recapped before. Here is the previous recap, the files that
changed since then, and the diff (restricted to this area's paths, may be
truncated):

--- previous recap ---
${opts.previous.body}

--- changed files ---
${opts.previous.changedFiles.join("\n")}

--- diff ---
${opts.previous.diff}

Update the recap to reflect these changes; keep what is still accurate.`
    : "";

  return `You are writing the codebase recap for the "${opts.area.title}"
area of repository "${opts.repo}" (paths: ${opts.area.paths.join(", ")}).
${opts.area.why ? `Why this area: ${opts.area.why}\n` : ""}
Other areas in this repo, for cross-links:
${other || "(none)"}

Explore this area's files with your read-only tools, then answer with
ONLY markdown (no preamble) using exactly these sections:

${sections}

"Connections" should describe how this area relates to the other areas
listed above. Be concrete: name real files, functions and flows you
found, not generic advice.${incremental}`;
}

function overviewPrompt(repo: string, areas: RecapArea[]): string {
  const body = areas
    .map((a) => `# ${a.title} (${a.id})\n${a.body}`)
    .join("\n\n---\n\n");
  return `You are writing the repo-wide overview for "${repo}" from its
areas' recaps below. Answer with ONLY markdown: what the repo is, an area
map (one line per area naming it and what it does), and how the pieces
fit together. Do not invent anything not supported by the recaps.

${body}`;
}

export class RecapRunner {
  constructor(private readonly deps: RecapRunnerDeps) {
    deps.db.run(`CREATE TABLE IF NOT EXISTS hub_recap_areas (
      repo       TEXT NOT NULL,
      id         TEXT NOT NULL,
      title      TEXT NOT NULL,
      paths      TEXT NOT NULL,
      why        TEXT NOT NULL DEFAULT '',
      body       TEXT NOT NULL DEFAULT '',
      revision   TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (repo, id)
    )`);
  }

  private agent(req: AgentRequest): Promise<string> {
    if (this.deps.agent) return this.deps.agent(req);
    if (!this.deps.apiKey) {
      return Promise.reject(new Error("no llm api key configured"));
    }
    return runPi({
      llm: this.deps.llm,
      apiKey: this.deps.apiKey,
      cwd: req.cwd,
      prompt: req.prompt,
      tools: req.tools,
      piCommand: this.deps.piCommand,
      timeoutMinutes: this.deps.timeoutMinutes,
    });
  }

  private redactAll(text: string): string {
    return redact(text, this.deps.secrets ?? []);
  }

  private loadAreas(repo: string): RecapArea[] {
    const rows = this.deps.db
      .query("SELECT * FROM hub_recap_areas WHERE repo = $repo ORDER BY id")
      .all({ repo }) as AreaRow[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      paths: JSON.parse(r.paths) as string[],
      why: r.why,
      body: r.body,
      revision: r.revision,
    }));
  }

  private saveArea(repo: string, area: RecapArea): void {
    this.deps.db
      .query(
        `INSERT INTO hub_recap_areas
           (repo, id, title, paths, why, body, revision, updated_at)
         VALUES ($repo, $id, $title, $paths, $why, $body, $revision, $updated)
         ON CONFLICT(repo, id) DO UPDATE SET
           title = excluded.title, paths = excluded.paths,
           why = excluded.why, body = excluded.body,
           revision = excluded.revision, updated_at = excluded.updated_at`,
      )
      .run({
        repo,
        id: area.id,
        title: area.title,
        paths: JSON.stringify(area.paths),
        why: area.why,
        body: area.body,
        revision: area.revision,
        updated: Date.now(),
      });
  }

  private deleteAreas(repo: string, ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map((_, i) => `$id${i}`).join(",");
    const params: Record<string, string> = { repo };
    ids.forEach((id, i) => {
      params[`id${i}`] = id;
    });
    this.deps.db
      .query(
        `DELETE FROM hub_recap_areas WHERE repo = $repo AND id IN (${placeholders})`,
      )
      .run(params);
  }

  private async plan(
    repo: string,
    dir: string,
    structuralMap: string,
  ): Promise<RecapPlanArea[]> {
    const prompt = planPrompt(repo, structuralMap, this.deps.maxAreas);
    const first = await this.agent({
      kind: "plan",
      prompt,
      cwd: dir,
      tools: READ_ONLY_TOOLS,
    });
    try {
      return parsePlan(first, this.deps.maxAreas);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryPrompt = planPrompt(
        repo,
        structuralMap,
        this.deps.maxAreas,
        message,
      );
      const retry = await this.agent({
        kind: "plan",
        prompt: retryPrompt,
        cwd: dir,
        tools: READ_ONLY_TOOLS,
      });
      return parsePlan(retry, this.deps.maxAreas); // throws on second failure
    }
  }

  private async runArea(
    input: RecapUpdateInput,
    plan: RecapPlanArea,
    otherAreas: { id: string; title: string; paths: string[] }[],
    previous: RecapArea | undefined,
    changed: RecapChanges | undefined,
  ): Promise<RecapArea> {
    let previousCtx:
      | { body: string; changedFiles: string[]; diff: string }
      | undefined;
    if (previous && changed) {
      const relevantFiles = changed.files.filter((f) =>
        areaCoversFile(plan, f),
      );
      const diff = await changed.diff(plan.paths);
      previousCtx = {
        body: previous.body,
        changedFiles: relevantFiles,
        diff: truncateDiff(diff),
      };
    }
    const prompt = areaPrompt({
      repo: input.repo.repo,
      area: plan,
      otherAreas,
      previous: previousCtx,
    });
    const body = this.redactAll(
      cleanMarkdown(
        await this.agent({
          kind: "area",
          prompt,
          cwd: input.dir,
          tools: READ_ONLY_TOOLS,
        }),
      ),
    );
    return {
      id: plan.id,
      title: plan.title,
      paths: plan.paths,
      why: plan.why ?? "",
      body,
      revision: input.revision,
    };
  }

  /** Runs a bounded set of area jobs `deps.concurrency` at a time. */
  private async runConcurrent<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      async () => {
        while (next < items.length) {
          const item = items[next++] as T;
          await fn(item);
        }
      },
    );
    await Promise.all(workers);
  }

  private async writeDocuments(
    input: RecapUpdateInput,
    areas: RecapArea[],
    overview: RecapArea,
  ): Promise<void> {
    const repo = input.repo.repo;
    const docs: DocumentInput[] = [];
    const url = `https://github.com/${repo}/tree/${input.revision}`;

    const emit = (
      area: RecapArea,
      isOverview: boolean,
      entityIds: string[],
    ) => {
      const slugCounts = new Map<string, number>();
      const chunks = chunkByHeading(area.body, area.title);
      for (const chunk of chunks) {
        let slug = githubSlug(chunk.heading) || "section";
        const seen = slugCounts.get(slug) ?? 0;
        slugCounts.set(slug, seen + 1);
        if (seen > 0) slug = `${slug}-${seen}`;
        docs.push({
          id: `recap:${repo}:${area.id}#${slug}`,
          collection: `recap:${repo}`,
          title: `${repo} › ${area.title} › ${chunk.heading}`,
          body: chunk.content,
          path: isOverview ? undefined : area.paths[0],
          url,
          revision: input.revision,
          entityIds,
          hash: sha256(`${area.id}\n${chunk.heading}\n${chunk.content}`),
        });
      }
    };

    for (const area of areas) {
      emit(area, false, entityIdsForArea(input.index, area));
    }
    emit(overview, true, [`repo:${repo}`]);

    this.deps.documents.replaceCollection(`recap:${repo}`, docs);
  }

  /** First run, or a forced/replanned one: plan, recap every area, overview. */
  private async planAndRegenerateAll(
    input: RecapUpdateInput,
    previousById: Map<string, RecapArea>,
  ): Promise<RecapReport> {
    const start = Date.now();
    const structuralMap = await buildStructuralMap(input.index, input.dir);
    const plan = await this.plan(input.repo.repo, input.dir, structuralMap);

    const regenerated: string[] = [];
    const failed: { id: string; error: string }[] = [];
    const results = new Map<string, RecapArea>();

    await this.runConcurrent(plan, this.deps.concurrency, async (area) => {
      const otherAreas = plan
        .filter((a) => a.id !== area.id)
        .map((a) => ({ id: a.id, title: a.title, paths: a.paths }));
      try {
        const result = await this.runArea(
          input,
          area,
          otherAreas,
          undefined,
          undefined,
        );
        results.set(area.id, result);
        regenerated.push(area.id);
      } catch (err) {
        const previous = previousById.get(area.id);
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ id: area.id, error: message });
        if (previous) results.set(area.id, previous);
        log.error(
          { repo: input.repo.repo, area: area.id, error: message },
          "recap area failed",
        );
      }
    });

    const finalAreas = plan
      .map((a) => results.get(a.id))
      .filter((a): a is RecapArea => a !== undefined);
    for (const area of finalAreas) this.saveArea(input.repo.repo, area);

    const keepIds = new Set(plan.map((a) => a.id));
    const toDelete = [...previousById.keys()].filter((id) => !keepIds.has(id));
    this.deleteAreas(input.repo.repo, toDelete);

    const overview = await this.regenerateOverview(input, finalAreas);
    await this.writeDocuments(input, finalAreas, overview);

    return {
      planned: true,
      regenerated,
      kept: [],
      failed,
      durationMs: Date.now() - start,
    };
  }

  private async regenerateOverview(
    input: RecapUpdateInput,
    areas: RecapArea[],
  ): Promise<RecapArea> {
    const prompt = overviewPrompt(input.repo.repo, areas);
    const body = this.redactAll(
      cleanMarkdown(
        await this.agent({
          kind: "overview",
          prompt,
          cwd: input.dir,
          tools: [],
        }),
      ),
    );
    const overview: RecapArea = {
      id: OVERVIEW_ID,
      title: "Overview",
      paths: [],
      why: "",
      body,
      revision: input.revision,
    };
    this.saveArea(input.repo.repo, overview);
    return overview;
  }

  /** Every area regenerated, but its plan (id/title/paths) kept as-is. */
  private async regenerateAllKeepingPlan(
    input: RecapUpdateInput,
    existing: RecapArea[],
    reason: string,
  ): Promise<RecapReport> {
    const start = Date.now();
    log.warn(
      { repo: input.repo.repo, reason },
      "recap: full regenerate, no replan",
    );
    const regenerated: string[] = [];
    const failed: { id: string; error: string }[] = [];
    const results = new Map<string, RecapArea>();

    await this.runConcurrent(existing, this.deps.concurrency, async (area) => {
      const plan: RecapPlanArea = {
        id: area.id,
        title: area.title,
        paths: area.paths,
        why: area.why,
      };
      const otherAreas = existing
        .filter((a) => a.id !== area.id)
        .map((a) => ({ id: a.id, title: a.title, paths: a.paths }));
      try {
        const result = await this.runArea(
          input,
          plan,
          otherAreas,
          undefined,
          undefined,
        );
        results.set(area.id, result);
        regenerated.push(area.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ id: area.id, error: message });
        results.set(area.id, area);
        log.error(
          { repo: input.repo.repo, area: area.id, error: message },
          "recap area failed",
        );
      }
    });

    const finalAreas = existing.map((a) => results.get(a.id) ?? a);
    for (const area of finalAreas) this.saveArea(input.repo.repo, area);
    const overview = await this.regenerateOverview(input, finalAreas);
    await this.writeDocuments(input, finalAreas, overview);

    return {
      planned: false,
      regenerated,
      kept: [],
      failed,
      durationMs: Date.now() - start,
    };
  }

  private async incremental(
    input: RecapUpdateInput,
    existing: RecapArea[],
  ): Promise<RecapReport> {
    const start = Date.now();
    const bases = [...new Set(existing.map((a) => a.revision))];
    let changedByBase: Map<string, RecapChanges>;
    try {
      const entries = await Promise.all(
        bases.map(async (base) => [base, await input.changes(base)] as const),
      );
      changedByBase = new Map(entries);
    } catch (err) {
      log.warn(
        { repo: input.repo.repo, error: String(err) },
        "recap: could not compute changes, full regenerate",
      );
      return this.regenerateAllKeepingPlan(input, existing, "changes() failed");
    }

    const allChangedFiles = [...changedByBase.values()].flatMap((c) => c.files);
    const relevantChangedFiles = allChangedFiles.filter(
      (f) => !LOCKFILE_NAMES.has(f.split("/").at(-1) ?? ""),
    );
    const unmatched = relevantChangedFiles.filter(
      (f) => !existing.some((a) => areaCoversFile(a, f)),
    );
    if (unmatched.length > 0) {
      const previousById = new Map(existing.map((a) => [a.id, a]));
      return this.planAndRegenerateAll(input, previousById);
    }

    const regenerated: string[] = [];
    const kept: string[] = [];
    const failed: { id: string; error: string }[] = [];
    const results = new Map<string, RecapArea>();
    const toRegenerate: RecapArea[] = [];

    for (const area of existing) {
      const changed = changedByBase.get(area.revision);
      const areaChangedFiles = (changed?.files ?? []).filter((f) =>
        areaCoversFile(area, f),
      );
      if (areaChangedFiles.length > 0) {
        toRegenerate.push(area);
      } else {
        kept.push(area.id);
        results.set(area.id, area);
      }
    }

    await this.runConcurrent(
      toRegenerate,
      this.deps.concurrency,
      async (area) => {
        const plan: RecapPlanArea = {
          id: area.id,
          title: area.title,
          paths: area.paths,
          why: area.why,
        };
        const otherAreas = existing
          .filter((a) => a.id !== area.id)
          .map((a) => ({ id: a.id, title: a.title, paths: a.paths }));
        const changed = changedByBase.get(area.revision);
        try {
          const result = await this.runArea(
            input,
            plan,
            otherAreas,
            area,
            changed,
          );
          results.set(area.id, result);
          regenerated.push(area.id);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failed.push({ id: area.id, error: message });
          results.set(area.id, area); // keeps previous body/revision for retry
          log.error(
            { repo: input.repo.repo, area: area.id, error: message },
            "recap area failed",
          );
        }
      },
    );

    const finalAreas = existing.map((a) => results.get(a.id) ?? a);
    for (const area of finalAreas) this.saveArea(input.repo.repo, area);

    let overview: RecapArea;
    if (regenerated.length > 0) {
      overview = await this.regenerateOverview(input, finalAreas);
    } else {
      overview = this.loadAreas(input.repo.repo).find(
        (a) => a.id === OVERVIEW_ID,
      ) ?? {
        id: OVERVIEW_ID,
        title: "Overview",
        paths: [],
        why: "",
        body: "",
        revision: input.revision,
      };
    }
    await this.writeDocuments(input, finalAreas, overview);

    return {
      planned: false,
      regenerated,
      kept,
      failed,
      durationMs: Date.now() - start,
    };
  }

  async update(input: RecapUpdateInput): Promise<RecapReport> {
    const existing = this.loadAreas(input.repo.repo).filter(
      (a) => a.id !== OVERVIEW_ID,
    );
    if (existing.length === 0 || input.force) {
      const previousById = new Map(existing.map((a) => [a.id, a]));
      return this.planAndRegenerateAll(input, previousById);
    }
    return this.incremental(input, existing);
  }

  /** The stored recap for `area` (or `"overview"`), if any. */
  getArea(repo: string, area: string): RecapArea | undefined {
    const rows = this.deps.db
      .query("SELECT * FROM hub_recap_areas WHERE repo = $repo AND id = $id")
      .all({ repo, id: area }) as AreaRow[];
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      title: row.title,
      paths: JSON.parse(row.paths) as string[],
      why: row.why,
      body: row.body,
      revision: row.revision,
    };
  }

  listAreas(repo: string): RecapArea[] {
    return this.loadAreas(repo);
  }
}
