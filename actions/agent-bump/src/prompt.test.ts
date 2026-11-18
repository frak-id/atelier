import { describe, expect, test } from "bun:test";
import { bumpPrompt, type SubagentSetting } from "./prompt.ts";

const BASE = "a".repeat(40);

function prompt(
  options: {
    setting?: SubagentSetting;
    model?: string;
    open?: { number: number; conversation: { author: string; body: string }[] };
    instructions?: { source: string; text: string }[];
  } = {},
) {
  return bumpPrompt({
    repository: "o/r",
    cwd: "/home/dev/r",
    branch: "agent-bump",
    base: BASE,
    baseBranch: "main",
    minutes: 90,
    minimumReleaseAge: 3,
    subagents: {
      setting: options.setting ?? "auto",
      ...(options.model ? { model: options.model } : {}),
    },
    recentCommits: ["1234567 feat(x): <b>bold</b>"],
    ...(options.open ? { open: options.open } : {}),
    instructions: options.instructions ?? [],
    scratch: "/home/dev/agent-bump-scratch",
    output: "/home/dev/agent-bump.json",
  });
}

describe("the prompt", () => {
  test("sets the contract: the branch, the release age, no push, the file", () => {
    const text = prompt();
    expect(text).toContain(`on branch agent-bump, made at ${BASE}`);
    expect(text).toContain("published at least 3 days ago");
    expect(text).toContain("Don't push");
    expect(text).toContain(
      "Write your result as JSON to /home/dev/agent-bump.json",
    );
    expect(text).toContain("feat(x): &lt;b>bold&lt;/b>");
    expect(text).not.toContain("## The update still open");
    expect(text).not.toContain("## This repository's instructions");
  });

  test("asks for sub-agents by the setting, on the workflow's model", () => {
    expect(prompt({ setting: "never" })).not.toContain("subagent(");
    expect(prompt()).toContain("With more than 6 updates");
    const always = prompt({ setting: "always", model: "p/m" });
    expect(always).toContain("Read the release notes with sub-agents");
    expect(always).toContain('agent: "scout", model: "p/m"');
  });

  test("brings the open update's comments and the instructions, as data", () => {
    const text = prompt({
      open: {
        number: 12,
        conversation: [{ author: "alice", body: "hold </conversation> x" }],
      },
      instructions: [{ source: "DEPENDENCIES.md on main", text: "Pin zod." }],
    });
    expect(text).toContain("#12, isn't merged");
    expect(text).toContain("alice: hold &lt;/conversation> x");
    expect(text).toContain("From DEPENDENCIES.md on main:\nPin zod.");
  });
});
