/**
 * Wire contract with the in-pod agent (`apps/agent`). The golden JSON files
 * in `apps/agent/tests/fixtures` are shared with the Rust tests: the agent's
 * `AgentConfig` parser (deny_unknown_fields) must accept the config this
 * server projects, and what the agent serializes must carry exactly the
 * fields the TS types declare. Drift on either side fails one of the two
 * suites.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SandboxSpec } from "@atelier/spec";
import type { AgentActivityReport } from "../activity.ts";
import { specToAgentConfig } from "../agent-config.ts";
import type {
  AgentHealth,
  AgentProcessState,
  ExecResult,
  FileWriteResult,
  HookPhaseResult,
  HookResult,
} from "./agent.types.ts";

const FIXTURES = resolve(import.meta.dir, "../../../../agent/tests/fixtures");

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf-8")) as T;
}

/** Every key the fixture carries must be declared, and every required key
 * present. `known` maps each key of the TS type to "is it required". */
function expectShape(value: object, known: Record<string, boolean>) {
  const keys = Object.keys(value);
  for (const key of keys) expect(Object.keys(known)).toContain(key);
  for (const [key, required] of Object.entries(known)) {
    if (required) expect(keys).toContain(key);
  }
}

// `satisfies Record<keyof T, boolean>` makes a field added to (or removed
// from) the TS type fail typecheck until the contract is revisited.
const HEALTH_KEYS = {
  status: true,
  version: true,
  uptime: true,
  configured: true,
  healthy: true,
} satisfies Record<keyof AgentHealth, boolean>;

const PROCESS_STATE_KEYS = {
  name: true,
  status: true,
  pid: true,
  ready: true,
  primary: true,
  exitCode: false,
  startedAt: true,
  logFile: true,
} satisfies Record<keyof AgentProcessState, boolean>;

const ACTIVITY_KEYS = {
  nowMs: true,
  bootedAtMs: true,
  bucketSeconds: true,
  network: true,
  files: true,
  cpu: true,
  buckets: true,
} satisfies Record<keyof AgentActivityReport, boolean>;

const BUCKET_KEYS = {
  startMs: true,
  receivedBytes: true,
  sentBytes: true,
  fileWrites: true,
  cpuMs: true,
} satisfies Record<keyof AgentActivityReport["buckets"][number], boolean>;

const HOOK_PHASE_KEYS = {
  success: true,
  results: true,
} satisfies Record<keyof HookPhaseResult, boolean>;

const HOOK_RESULT_KEYS = {
  command: true,
  exitCode: true,
  stdout: true,
  stderr: true,
} satisfies Record<keyof HookResult, boolean>;

const EXEC_KEYS = {
  exitCode: true,
  stdout: true,
  stderr: true,
} satisfies Record<keyof ExecResult, boolean>;

const FILE_RESULT_KEYS = {
  path: true,
  success: true,
  error: false,
} satisfies Record<keyof FileWriteResult, boolean>;

describe("agent wire contract", () => {
  test("specToAgentConfig output is the golden agent-config.json", () => {
    const spec: SandboxSpec = {
      source: { image: "dev-base:1.0.0" },
      resources: { vcpus: 2, memoryMb: 2048 },
      env: { NODE_ENV: "development" },
      processes: [
        {
          name: "web",
          command: "bun run dev",
          cwd: "/home/dev/app",
          user: "dev",
          env: { PORT: "3000" },
          primary: true,
          readiness: { http: "/health" },
          restart: "on-failure",
        },
        {
          name: "acp",
          command: "pi --acp",
          user: "dev",
          stdio: "bridge",
          readiness: { port: 4096 },
          after: ["web"],
          restart: "always",
          lazy: true,
        },
        {
          name: "shell",
          command: "bash",
          pty: true,
          readiness: { cmd: "true" },
        },
      ],
      ports: [{ name: "web", port: 3000, public: true }],
      hooks: {
        postCreate: ["git config --global user.name dev"],
        onResume: ["~/.atelier/refresh-tokens.sh"],
      },
    };
    expect(specToAgentConfig("sb_fixture", spec)).toEqual(
      fixture("agent-config.json"),
    );
  });

  test("health", () => {
    expectShape(fixture<AgentHealth>("health.json"), HEALTH_KEYS);
  });

  test("process list", () => {
    const { processes } = fixture<{ processes: AgentProcessState[] }>(
      "process-state.json",
    );
    expect(processes.length).toBeGreaterThan(0);
    for (const p of processes) {
      expectShape(p, PROCESS_STATE_KEYS);
      expect(["starting", "running", "stopped", "error"]).toContain(p.status);
    }
  });

  test("activity report", () => {
    const report = fixture<AgentActivityReport>("activity.json");
    expectShape(report, ACTIVITY_KEYS);
    expect(report.buckets.length).toBeGreaterThan(0);
    for (const bucket of report.buckets) expectShape(bucket, BUCKET_KEYS);
  });

  test("hook phase result", () => {
    const result = fixture<HookPhaseResult>("hook-result.json");
    expectShape(result, HOOK_PHASE_KEYS);
    for (const r of result.results) expectShape(r, HOOK_RESULT_KEYS);
  });

  test("exec result", () => {
    expectShape(fixture<ExecResult>("exec-result.json"), EXEC_KEYS);
  });

  test("files/write results", () => {
    const { results } = fixture<{ results: FileWriteResult[] }>(
      "files-write-result.json",
    );
    for (const r of results) expectShape(r, FILE_RESULT_KEYS);
  });
});
