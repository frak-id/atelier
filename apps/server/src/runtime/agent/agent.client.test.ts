import { afterEach, describe, expect, test } from "bun:test";
import { AgentClient } from "./agent.client.ts";
import {
  BUILD_TIMEOUT_MS,
  EXEC_DEFAULT_TIMEOUT_MS,
  hookPhaseTimeoutMs,
  MATERIALIZE_TIMEOUT_MS,
} from "./agent.contract.ts";

interface Seen {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

let servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers = [];
});

/** A fake agent: records what it was sent, answers per-path JSON. */
function fakeAgent(routes: Record<string, unknown> = {}) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      seen.push({
        method: req.method,
        path: url.pathname,
        authorization: req.headers.get("authorization"),
        body: text ? JSON.parse(text) : undefined,
      });
      return Response.json(routes[url.pathname] ?? { success: true });
    },
  });
  servers.push(server);
  const client = (resolveToken?: (id: string) => string | undefined) =>
    new AgentClient(
      async () => ({
        host: "127.0.0.1",
        agentPort: server.port as number,
        attachPort: 9997,
      }),
      resolveToken,
    );
  return { seen, client };
}

describe("AgentClient auth", () => {
  test("sends the bearer token resolved from the sandbox record", async () => {
    const { seen, client } = fakeAgent({ "/processes": { processes: [] } });
    const agent = client((id) => (id === "sb1" ? "record-token" : undefined));
    await agent.processList("sb1");
    expect(seen[0]?.authorization).toBe("Bearer record-token");
  });

  test("setToken (a booting sandbox) wins over the record", async () => {
    const { seen, client } = fakeAgent();
    const agent = client(() => "stale");
    agent.setToken("sb1", "fresh");
    await agent.reconcile("sb1");
    expect(seen[0]?.authorization).toBe("Bearer fresh");
  });

  test("sends no header when no token is known", async () => {
    const { seen, client } = fakeAgent();
    await client().reconcile("sb1");
    expect(seen[0]?.authorization).toBeNull();
  });

  test("WS urls carry the token; replay opt-out is explicit", async () => {
    const { client } = fakeAgent();
    const agent = client();
    agent.setToken("sb1", "tok");

    const rw = new URL(await agent.attachUrl("sb1", "acp", "rw"));
    expect(rw.pathname).toBe("/attach/acp");
    expect(rw.searchParams.get("mode")).toBe("rw");
    expect(rw.searchParams.get("token")).toBe("tok");
    expect(rw.searchParams.has("replay")).toBe(false);

    const live = new URL(
      await agent.attachUrl("sb1", "acp", "rw", { replay: false }),
    );
    expect(live.searchParams.get("replay")).toBe("0");

    const term = new URL(await agent.terminalBridgeUrl("sb1", "term-1"));
    expect(term.pathname).toBe("/terminal/term-1");
    expect(term.port).toBe("9997");
    expect(term.searchParams.get("token")).toBe("tok");
  });
});

describe("AgentClient timeouts", () => {
  test("exec always names its timeout to the agent", async () => {
    const { seen, client } = fakeAgent({
      "/exec": { exitCode: 0, stdout: "", stderr: "" },
    });
    await client().exec("sb1", "true");
    expect(seen[0]?.body).toMatchObject({ timeout: EXEC_DEFAULT_TIMEOUT_MS });
  });

  test("runHook sizes its abort from the phase's command count", async () => {
    const { seen, client } = fakeAgent({
      "/config": { sandboxId: "sb1", hooks: { postStart: ["a", "b"] } },
      "/hooks/postStart": { success: true, results: [] },
    });
    const result = await client().runHook("sb1", "postStart");
    expect(result.success).toBe(true);
    expect(seen.map((s) => s.path)).toEqual(["/config", "/hooks/postStart"]);
  });

  test("client timeouts sit above the agent's own deadlines", () => {
    // Rust: toolset::BUILD_TIMEOUT_MS = 600s, command::DEFAULT_EXEC_TIMEOUT_MS = 120s.
    expect(BUILD_TIMEOUT_MS).toBeGreaterThan(600_000);
    expect(MATERIALIZE_TIMEOUT_MS).toBeGreaterThan(600_000);
    expect(hookPhaseTimeoutMs(0)).toBeGreaterThan(120_000);
    expect(hookPhaseTimeoutMs(3)).toBeGreaterThan(3 * 120_000);
  });
});
