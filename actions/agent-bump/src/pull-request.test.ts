import { describe, expect, test } from "bun:test";
import type { BumpFile } from "./bump-file.ts";
import {
  branchVerdict,
  brokeACheck,
  conversation,
  decodeState,
  encodeState,
  HEADING,
  type PullRequest,
  pullRequestBody,
} from "./pull-request.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const OTHER = "c".repeat(40);

const pull = (
  number: number,
  state: PullRequest["state"],
  head: string,
  pushed?: string,
): PullRequest => ({
  number,
  state,
  head: { sha: head },
  body: `### Dependency updates\n\n${pushed ? encodeState({ base: BASE, head: pushed }) : ""}`,
});

describe("the state in the body", () => {
  test("is read back", () => {
    expect(
      decodeState(`text\n\n${encodeState({ base: BASE, head: HEAD })}`),
    ).toEqual({ base: BASE, head: HEAD });
  });

  test("is none without the marker, or with anything but commits in it", () => {
    expect(decodeState(null)).toBeUndefined();
    expect(decodeState("no state")).toBeUndefined();
    expect(
      decodeState('<!-- agent-bump-state {"base":"x","head":"y"} -->'),
    ).toBeUndefined();
    expect(decodeState("<!-- agent-bump-state {not json} -->")).toBeUndefined();
  });
});

describe("the update's branch", () => {
  test("is the job's when there's none", () => {
    expect(branchVerdict("agent-bump", undefined, [])).toEqual({ ours: true });
  });

  test("is the job's while its open pull request is at the head it pushed", () => {
    const open = pull(7, "open", HEAD, HEAD);
    expect(
      branchVerdict("agent-bump", HEAD, [pull(3, "closed", BASE, BASE), open]),
    ).toEqual({ ours: true, open });
  });

  test("is a person's once they pushed to it: their commits are kept", () => {
    const verdict = branchVerdict("agent-bump", OTHER, [
      pull(7, "open", OTHER, HEAD),
    ]);
    expect(verdict.ours).toBe(false);
    if (!verdict.ours) expect(verdict.reason).toContain("#7");
  });

  test("is not the job's when the body lost its state", () => {
    expect(
      branchVerdict("agent-bump", HEAD, [pull(7, "open", HEAD)]).ours,
    ).toBe(false);
  });

  test("left by a merged or closed pull request, is the job's to start over, if untouched since", () => {
    expect(
      branchVerdict("agent-bump", HEAD, [
        pull(2, "closed", OTHER, OTHER),
        pull(5, "closed", HEAD, HEAD),
      ]),
    ).toEqual({ ours: true });
    expect(
      branchVerdict("agent-bump", OTHER, [pull(5, "closed", HEAD, HEAD)]).ours,
    ).toBe(false);
  });

  test("never pushed by the job is left alone", () => {
    const verdict = branchVerdict("agent-bump", HEAD, []);
    expect(verdict.ours).toBe(false);
    if (!verdict.ours) expect(verdict.reason).toContain("agent-bump exists");
  });
});

describe("people's comments", () => {
  test("reach the agent from the repository's people only, oldest first, no bot's", () => {
    expect(
      conversation([
        {
          user: { login: "bob" },
          body: "later",
          created_at: "2026-11-12T00:00:00Z",
          author_association: "MEMBER",
        },
        {
          user: { login: "alice" },
          body: " hold typescript ",
          submitted_at: "2026-11-11T00:00:00Z",
          author_association: "OWNER",
        },
        {
          user: { login: "stranger" },
          body: "bump my package",
          created_at: "2026-11-10T00:00:00Z",
          author_association: "NONE",
        },
        {
          user: { login: "github-actions[bot]", type: "Bot" },
          body: "review",
          created_at: "2026-11-10T00:00:00Z",
          author_association: "MEMBER",
        },
        {
          user: { login: "carol" },
          body: "",
          created_at: "2026-11-10T00:00:00Z",
          author_association: "COLLABORATOR",
        },
      ]),
    ).toEqual([
      { author: "alice", body: "hold typescript" },
      { author: "bob", body: "later" },
    ]);
  });
});

const file: BumpFile = {
  title: "chore(deps): weekly updates",
  summary: "Moved two. ping @alice <img src=x>",
  updates: [
    { name: "left-pad", ecosystem: "npm", from: "1.0.0", to: "1.0.1" },
    {
      name: "@biomejs/biome",
      ecosystem: "npm",
      from: "1.9.4",
      to: "2.7.1",
      changelog: "https://github.com/biomejs/biome/releases",
      notes: "Ran `biome migrate --write`.",
    },
    {
      name: "a|b",
      ecosystem: "docker",
      from: "sha256:1",
      to: "sha256:2",
    },
  ],
  held: [
    {
      name: "typescript",
      ecosystem: "npm",
      from: "7.0.2",
      to: "8.0.0",
      reason: "Needs\na migration.",
    },
  ],
  checks: [
    { command: "bun run test", status: "passed" },
    { command: "cargo test", status: "pre-existing", note: "flaky" },
  ],
};
const run = {
  base: BASE,
  baseBranch: "main",
  head: HEAD,
  runUrl: "https://github.com/o/r/actions/runs/1/attempts/1",
};

describe("the body", () => {
  test("lists the updates majors first, quieted, its cells on one line", () => {
    const body = pullRequestBody(file, run);
    expect(body.startsWith(`${HEADING}\n\nMoved two. ping @\u200balice`)).toBe(
      true,
    );
    expect(body).toContain("<\u200bimg");
    const rows = body.split("\n").filter((line) => line.startsWith("| `"));
    expect(rows).toEqual([
      "| `@biomejs/biome` | npm | 1.9.4 | 2.7.1 | **major** · [changes](https://github.com/biomejs/biome/releases) |",
      "| `left-pad` | npm | 1.0.0 | 1.0.1 | patch |",
      "| `a\\|b` | docker | sha256:1 | sha256:2 |  |",
    ]);
    expect(body).toContain(
      "**`@biomejs/biome`** 1.9.4 → 2.7.1\n\nRan `biome migrate --write`.",
    );
    expect(body).toContain(
      "- `typescript` (npm) 7.0.2 → 8.0.0: Needs a migration.",
    );
    expect(body).toContain("- ⚠️ `cargo test` fails on the base too: flaky");
    expect(decodeState(body)).toEqual({ base: BASE, head: HEAD });
  });

  test("says why it's a draft when a check broke", () => {
    const broken: BumpFile = {
      ...file,
      checks: [{ command: "bun run test", status: "failed" }],
    };
    expect(brokeACheck(file)).toBe(false);
    expect(brokeACheck(broken)).toBe(true);
    expect(pullRequestBody(broken, run)).toContain(
      "this pull request is a draft",
    );
  });

  test("is cut to GitHub's limit, its state kept", () => {
    const long: BumpFile = {
      ...file,
      updates: file.updates.map((update) => ({
        ...update,
        notes: `\`\`\`\n${"x".repeat(40_000)}`,
      })),
    };
    const body = pullRequestBody(long, run);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("cut here");
    expect(decodeState(body)).toEqual({ base: BASE, head: HEAD });
  });
});
