import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openKnowledgeDb,
  type RepositoryIndex,
  SqliteDocumentStore,
} from "@atelier/knowledge";
import type { RepoConfig } from "../config.ts";
import type { AgentRequest } from "./runner.ts";
import { cleanMarkdown, directorySizes, RecapRunner } from "./runner.ts";

const repo: RepoConfig = { repo: "acme/shop", branch: "main" };

function buildIndex(revision: string): RepositoryIndex {
  return {
    repo: repo.repo,
    revision,
    entities: [
      { id: "repo:acme/shop", type: "repo", name: "acme/shop", attrs: {} },
      {
        id: "package:@shop/a",
        type: "package",
        name: "@shop/a",
        attrs: { path: "packages/a" },
      },
      {
        id: "package:@shop/b",
        type: "package",
        name: "@shop/b",
        attrs: { path: "packages/b" },
      },
    ],
    facts: [
      {
        type: "depends_on",
        from: "package:@shop/a",
        to: "package:@shop/b",
        attrs: {},
      },
    ],
    documents: [],
    warnings: [],
    stats: { files: 4, packages: 2, documents: 0, durationMs: 0 },
  };
}

const PLAN_TWO_AREAS = `Some thinking.

\`\`\`json
{"areas":[
  {"id":"a","title":"Package A","paths":["packages/a/**"],"why":"is a"},
  {"id":"b","title":"Package B","paths":["packages/b/**"],"why":"is b"}
]}
\`\`\``;

function areaBody(title: string, marker = "v1"): string {
  return `## Purpose
${title} does things (${marker}).

## Architecture
Some architecture.

## Key flows
Flow.

## Entry points
Entry.

## Conventions
Convention.

## Gotchas
Gotcha.

## Connections
Connects to others.`;
}

function setup(agent: (req: AgentRequest) => Promise<string>) {
  const db = openKnowledgeDb(":memory:");
  const documents = new SqliteDocumentStore(db);
  const runner = new RecapRunner({
    db,
    documents,
    llm: {
      baseUrl: "http://x",
      api: "anthropic-messages",
      model: "m",
      thinking: "medium",
    },
    apiKey: "test-key",
    piCommand: ["pi"],
    concurrency: 2,
    timeoutMinutes: 1,
    maxAreas: 10,
    secrets: ["test-key", "super-secret-token"],
    agent,
  });
  return { db, documents, runner };
}

const noChanges = async () => ({
  files: [] as string[],
  diff: async () => "",
});

describe("RecapRunner.update — planning", () => {
  test("first run plans, recaps every area, writes overview and chunked documents", async () => {
    const calls: AgentRequest[] = [];
    const { runner, documents } = setup(async (req) => {
      calls.push(req);
      if (req.kind === "plan") return PLAN_TWO_AREAS;
      if (req.kind === "overview") return "## Overview\nThe repo.";
      const title = req.prompt.includes('"Package A"')
        ? "Package A"
        : "Package B";
      return areaBody(title);
    });

    const report = await runner.update({
      repo,
      dir: "/tmp/does-not-matter",
      revision: "r1",
      index: buildIndex("r1"),
      force: false,
      changes: noChanges,
    });

    expect(report.planned).toBe(true);
    expect(report.regenerated.sort()).toEqual(["a", "b"]);
    expect(report.failed).toEqual([]);

    const areas = runner.listAreas(repo.repo);
    expect(areas.map((a) => a.id).sort()).toEqual(["a", "b", "overview"]);

    const docs = documents.list(`recap:${repo.repo}`);
    expect(docs.length).toBeGreaterThan(0);
    const purposeDoc = docs.find(
      (d) => d.id === `recap:${repo.repo}:a#purpose`,
    );
    expect(purposeDoc).toBeDefined();
    expect(purposeDoc?.entityIds).toContain("package:@shop/a");

    expect(calls.filter((c) => c.kind === "area").length).toBe(2);
    expect(calls.filter((c) => c.kind === "overview")[0]?.tools).toEqual([]);
  });

  test("invalid plan retries once with the error, then fails the recap step", async () => {
    let attempts = 0;
    const { runner } = setup(async (req) => {
      if (req.kind === "plan") {
        attempts++;
        return attempts === 1 ? "not json at all" : PLAN_TWO_AREAS;
      }
      if (req.kind === "overview") return "## Overview\nok";
      return areaBody("x");
    });
    const report = await runner.update({
      repo,
      dir: "/tmp/x",
      revision: "r1",
      index: buildIndex("r1"),
      force: false,
      changes: noChanges,
    });
    expect(attempts).toBe(2);
    expect(report.planned).toBe(true);
  });

  test("a plan that is invalid twice fails the recap step", async () => {
    const { runner } = setup(async (req) => {
      if (req.kind === "plan") return "still not json";
      return "";
    });
    await expect(
      runner.update({
        repo,
        dir: "/tmp/x",
        revision: "r1",
        index: buildIndex("r1"),
        force: false,
        changes: noChanges,
      }),
    ).rejects.toThrow();
  });
});

describe("RecapRunner.update — incremental", () => {
  async function firstRun(runner: RecapRunner) {
    return runner.update({
      repo,
      dir: "/tmp/x",
      revision: "r1",
      index: buildIndex("r1"),
      force: false,
      changes: noChanges,
    });
  }

  test("only areas whose files changed are regenerated; overview refreshes too", async () => {
    const { runner, documents } = setup(async (req) => {
      if (req.kind === "plan") return PLAN_TWO_AREAS;
      if (req.kind === "overview") return "## Overview\nUpdated overview.";
      const title = req.prompt.includes('"Package A"')
        ? "Package A"
        : "Package B";
      return areaBody(title, "v2");
    });
    await firstRun(runner);

    const report = await runner.update({
      repo,
      dir: "/tmp/x",
      revision: "r2",
      index: buildIndex("r2"),
      force: false,
      changes: async (base) => {
        expect(base).toBe("r1");
        return {
          files: ["packages/a/src/index.ts"],
          diff: async (paths) => `diff for ${paths.join(",")}`,
        };
      },
    });

    expect(report.planned).toBe(false);
    expect(report.regenerated).toEqual(["a"]);
    expect(report.kept).toEqual(["b"]);

    const areaA = runner.listAreas(repo.repo).find((a) => a.id === "a");
    expect(areaA?.revision).toBe("r2");
    const areaB = runner.listAreas(repo.repo).find((a) => a.id === "b");
    expect(areaB?.revision).toBe("r1");

    const overview = runner
      .listAreas(repo.repo)
      .find((a) => a.id === "overview");
    expect(overview?.body).toContain("Updated overview");
    expect(documents.list(`recap:${repo.repo}`).length).toBeGreaterThan(0);
  });

  test("a changed file matching no area triggers a full replan, keeping unaffected bodies", async () => {
    let planCalls = 0;
    const { runner } = setup(async (req) => {
      if (req.kind === "plan") {
        planCalls++;
        return PLAN_TWO_AREAS;
      }
      if (req.kind === "overview") return "## Overview\nreplanned";
      const title = req.prompt.includes('"Package A"')
        ? "Package A"
        : "Package B";
      return areaBody(title, `plan${planCalls}`);
    });
    await firstRun(runner);

    const report = await runner.update({
      repo,
      dir: "/tmp/x",
      revision: "r2",
      index: buildIndex("r2"),
      force: false,
      changes: async () => ({
        files: ["some/uncovered/file.ts"],
        diff: async () => "",
      }),
    });

    expect(planCalls).toBe(2);
    expect(report.planned).toBe(true);
  });

  test("changes() failing regenerates every area without replanning", async () => {
    let planCalls = 0;
    const { runner } = setup(async (req) => {
      if (req.kind === "plan") {
        planCalls++;
        return PLAN_TWO_AREAS;
      }
      if (req.kind === "overview") return "## Overview\nok";
      const title = req.prompt.includes('"Package A"')
        ? "Package A"
        : "Package B";
      return areaBody(title, "regen");
    });
    await firstRun(runner);

    const report = await runner.update({
      repo,
      dir: "/tmp/x",
      revision: "r2",
      index: buildIndex("r2"),
      force: false,
      changes: async () => {
        throw new Error("shallow fetch failed");
      },
    });

    expect(planCalls).toBe(1); // no replan
    expect(report.planned).toBe(false);
    expect(report.regenerated.sort()).toEqual(["a", "b"]);
  });

  test("a failed area keeps its previous body and is retried next run", async () => {
    let areaAAttempts = 0;
    const { runner } = setup(async (req) => {
      if (req.kind === "plan") return PLAN_TWO_AREAS;
      if (req.kind === "overview") return "## Overview\nfine";
      const isA = req.prompt.includes('"Package A"');
      if (isA) {
        areaAAttempts++;
        if (areaAAttempts === 2) throw new Error("boom");
        return areaBody("Package A", `attempt${areaAAttempts}`);
      }
      return areaBody("Package B");
    });
    await firstRun(runner);
    const before = runner.listAreas(repo.repo).find((a) => a.id === "a");

    const report = await runner.update({
      repo,
      dir: "/tmp/x",
      revision: "r2",
      index: buildIndex("r2"),
      force: false,
      changes: async () => ({
        files: ["packages/a/src/index.ts"],
        diff: async () => "diff",
      }),
    });

    expect(report.failed).toEqual([{ id: "a", error: "boom" }]);
    const after = runner.listAreas(repo.repo).find((a) => a.id === "a");
    expect(after?.body).toBe(before?.body);
    expect(after?.revision).toBe(before?.revision);

    // Retried on the next run and succeeds this time.
    const report2 = await runner.update({
      repo,
      dir: "/tmp/x",
      revision: "r3",
      index: buildIndex("r3"),
      force: false,
      changes: async () => ({
        files: ["packages/a/src/index.ts"],
        diff: async () => "diff",
      }),
    });
    expect(report2.regenerated).toContain("a");
  });

  test("force re-plans even with existing areas", async () => {
    let planCalls = 0;
    const { runner } = setup(async (req) => {
      if (req.kind === "plan") {
        planCalls++;
        return PLAN_TWO_AREAS;
      }
      if (req.kind === "overview") return "## Overview\nok";
      return areaBody("x");
    });
    await firstRun(runner);
    await runner.update({
      repo,
      dir: "/tmp/x",
      revision: "r2",
      index: buildIndex("r2"),
      force: true,
      changes: noChanges,
    });
    expect(planCalls).toBe(2);
  });
});

describe("RecapRunner.update — redaction", () => {
  test("known secrets are redacted from stored bodies", async () => {
    const { runner } = setup(async (req) => {
      if (req.kind === "plan") return PLAN_TWO_AREAS;
      if (req.kind === "overview") {
        return "## Overview\nkey is super-secret-token here";
      }
      return `${areaBody("x")}\ntoken=super-secret-token`;
    });
    await runner.update({
      repo,
      dir: "/tmp/x",
      revision: "r1",
      index: buildIndex("r1"),
      force: false,
      changes: noChanges,
    });
    const areas = runner.listAreas(repo.repo);
    for (const area of areas) {
      expect(area.body).not.toContain("super-secret-token");
    }
  });
});

describe("cleanMarkdown", () => {
  test("drops narration before the first heading", () => {
    expect(
      cleanMarkdown("That's plenty. I'll write it now.\n\n## Purpose\nx"),
    ).toBe("## Purpose\nx");
  });

  test("unwraps a markdown fence and keeps heading-less text", () => {
    expect(cleanMarkdown("```markdown\n## A\nb\n```")).toBe("## A\nb");
    expect(cleanMarkdown("  just text  ")).toBe("just text");
  });
});

describe("directorySizes", () => {
  test("counts files and lines per directory, hiding tiny ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-sizes-"));
    mkdirSync(join(dir, "apps/big/src"), { recursive: true });
    mkdirSync(join(dir, "tiny"), { recursive: true });
    writeFileSync(join(dir, "apps/big/src/a.ts"), "x\n".repeat(500));
    writeFileSync(join(dir, "apps/big/b.ts"), "y\n".repeat(499));
    writeFileSync(join(dir, "tiny/c.ts"), "z");
    const sizes = await directorySizes(dir);
    expect(sizes).toEqual([
      { path: "apps", files: 2, lines: 1001 },
      { path: "apps/big", files: 2, lines: 1001 },
      { path: "apps/big/src", files: 1, lines: 501 },
    ]);
  });
});
