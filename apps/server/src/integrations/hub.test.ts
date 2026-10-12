import { describe, expect, test } from "bun:test";
import type { PermissionRisk } from "@frak/atelier-shared";
import { createChildLogger } from "../shared/lib/logger.ts";
import { type HubPrompt, IntegrationHub } from "./hub.ts";
import type {
  Integration,
  PermissionContext,
  PermissionRequest,
} from "./integration.ts";

const OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];
const bash: HubPrompt = {
  sandboxId: "sb1",
  sessionId: "s1",
  requestId: "r1",
  title: "ls",
  kind: "execute",
  options: OPTIONS,
};
const read: HubPrompt = { ...bash, title: "Read file", kind: "read" };

interface Call {
  id: string;
  request: PermissionRequest;
  ctx: PermissionContext;
}

/** An integration that records its calls and stays pending until aborted. */
function fake(id: string, calls: Call[], opts: { throws?: boolean } = {}) {
  const integration: Integration = {
    manifest: { id, label: id, description: "d" },
    onPermission: (request, ctx) => {
      calls.push({ id, request, ctx });
      if (opts.throws) return Promise.reject(new Error("boom"));
      return new Promise<void>((resolve) =>
        ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    },
  };
  return integration;
}

interface Conn {
  integrationId: string;
  credential?: string;
  minRisk?: PermissionRisk;
  delaySeconds?: number;
}

function setup(
  integrations: Integration[],
  connections: Conn[],
  opts: { owner?: string | undefined } = {},
) {
  const owner = "owner" in opts ? opts.owner : "u1";
  const calls: Call[] = [];
  const delays: { ms: number; resolve: () => void }[] = [];
  let markSlept: () => void = () => {};
  const slept = new Promise<void>((resolve) => {
    markSlept = resolve;
  });
  const hub = new IntegrationHub({
    registry: {
      enabled: () => integrations,
      serverSettings: (id) => ({ who: id }),
    },
    ownerOf: () => owner,
    sandboxName: (id) => `name-${id}`,
    connectionsOf: async (userId) =>
      userId === "u1"
        ? connections.map((c) => ({
            minRisk: "low" as const,
            delaySeconds: 0,
            ...c,
          }))
        : [],
    // Delays are driven by the test: `slept` resolves when one starts,
    // `elapse()` ends it.
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        delays.push({ ms, resolve });
        markSlept();
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
    log: createChildLogger("hub-test"),
  });
  const answers: string[] = [];
  const parent = new AbortController();
  /** Starts the fan-out; resolves when it is done (integrations here stay
   * pending until aborted, so most tests use `notify`). */
  const run = (prompt: HubPrompt = bash) =>
    hub.notify(prompt, (id) => answers.push(id), parent.signal);
  /** Starts the fan-out and lets every step that needs no timer run (a few
   * microtask turns): the integrations are then in their pending call. */
  const notify = async (prompt: HubPrompt = bash) => {
    void run(prompt);
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  };
  return { hub, calls, answers, parent, notify, run, delays, slept };
}

const a = (calls: Call[]) => fake("aa", calls);

describe("IntegrationHub", () => {
  test("calls the integration with the request, settings and own credential", async () => {
    const calls: Call[] = [];
    const t = setup(
      [fake("aa", calls), fake("bb", calls)],
      [
        { integrationId: "aa", credential: "secret-a" },
        { integrationId: "bb", credential: "secret-b" },
      ],
    );
    await t.notify();
    expect(calls).toHaveLength(2);
    const [first, second] = calls;
    expect(first?.request).toEqual({
      requestId: "r1",
      sandboxId: "sb1",
      sandboxName: "name-sb1",
      title: "ls",
      kind: "execute",
      risk: "high",
      options: OPTIONS,
    });
    // Credential isolation: each integration only sees its own.
    expect(first?.ctx.connection).toEqual({ credential: "secret-a" });
    expect(second?.ctx.connection.credential).toBe("secret-b");
    expect(first?.ctx.serverSettings).toEqual({ who: "aa" });
  });

  test("first answer wins and aborts the siblings", async () => {
    const calls: Call[] = [];
    const t = setup(
      [fake("aa", calls), fake("bb", calls)],
      [{ integrationId: "aa" }, { integrationId: "bb" }],
    );
    await t.notify();
    calls[1]?.ctx.answer("deny");
    calls[0]?.ctx.answer("allow");
    expect(t.answers).toEqual(["deny"]);
    expect(calls[0]?.ctx.signal.aborted).toBe(true);
    expect(calls[1]?.ctx.signal.aborted).toBe(true);
  });

  test("an option the prompt did not offer is ignored", async () => {
    const calls: Call[] = [];
    const t = setup(
      [fake("aa", calls), fake("bb", calls)],
      [{ integrationId: "aa" }, { integrationId: "bb" }],
    );
    await t.notify();
    calls[0]?.ctx.answer("not-offered");
    expect(t.answers).toEqual([]);
    expect(calls[1]?.ctx.signal.aborted).toBe(false);
    calls[1]?.ctx.answer("allow");
    expect(t.answers).toEqual(["allow"]);
  });

  test("the prompt settling elsewhere aborts every integration", async () => {
    const calls: Call[] = [];
    const t = setup(
      [fake("aa", calls), fake("bb", calls)],
      [{ integrationId: "aa" }, { integrationId: "bb" }],
    );
    await t.notify();
    t.parent.abort();
    expect(calls.every((c) => c.ctx.signal.aborted)).toBe(true);
    calls[0]?.ctx.answer("allow");
    expect(t.answers).toEqual([]);
  });

  test("an already-aborted prompt calls nothing", async () => {
    const calls: Call[] = [];
    const t = setup([a(calls)], [{ integrationId: "aa" }]);
    t.parent.abort();
    await t.notify();
    expect(calls).toHaveLength(0);
  });

  test("minRisk filters by the prompt's risk", async () => {
    const calls: Call[] = [];
    const t = setup(
      [fake("aa", calls), fake("bb", calls)],
      [
        { integrationId: "aa", minRisk: "high" },
        { integrationId: "bb", minRisk: "low" },
      ],
    );
    await t.notify(read);
    expect(calls.map((c) => c.id)).toEqual(["bb"]);
    await t.notify(bash);
    expect(calls.map((c) => c.id)).toEqual(["bb", "aa", "bb"]);
  });

  test("delaySeconds waits, and a settle before it means no call", async () => {
    const calls: Call[] = [];
    const t = setup([a(calls)], [{ integrationId: "aa", delaySeconds: 1 }]);
    const done = t.run();
    await t.slept;
    expect(t.delays.map((d) => d.ms)).toEqual([1000]);
    expect(calls).toHaveLength(0);
    t.parent.abort();
    await done;
    expect(calls).toHaveLength(0);
  });

  test("a delayed integration is called once the delay passes", async () => {
    const calls: Call[] = [];
    const t = setup([a(calls)], [{ integrationId: "aa", delaySeconds: 1 }]);
    const done = t.run();
    await t.slept;
    expect(calls).toHaveLength(0);
    t.delays[0]?.resolve();
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    expect(calls).toHaveLength(1);
    t.parent.abort();
    await done;
  });

  test("a throwing integration is logged and the prompt stays pending", async () => {
    const calls: Call[] = [];
    const t = setup(
      [fake("aa", calls, { throws: true }), fake("bb", calls)],
      [{ integrationId: "aa" }, { integrationId: "bb" }],
    );
    await t.notify();
    expect(calls).toHaveLength(2);
    expect(t.answers).toEqual([]);
    expect(t.parent.signal.aborted).toBe(false);
    expect(calls[1]?.ctx.signal.aborted).toBe(false);
  });

  test("no connection, a disabled one, or no onPermission → no call", async () => {
    const calls: Call[] = [];
    const none = setup([a(calls)], []);
    await none.notify();
    // connectionsOf returns enabled connections only: a disabled one is absent.
    const other = setup([a(calls)], [{ integrationId: "zz" }]);
    await other.notify();
    const passive: Integration = {
      manifest: { id: "pp", label: "p", description: "d" },
    };
    const noHook = setup([passive], [{ integrationId: "pp" }]);
    await noHook.notify();
    expect(calls).toHaveLength(0);
  });

  test("an unowned sandbox calls nothing", async () => {
    const calls: Call[] = [];
    const t = setup([a(calls)], [{ integrationId: "aa" }], {
      owner: undefined,
    });
    await t.notify();
    expect(calls).toHaveLength(0);
  });

  test("a failing lookup never throws into the caller", async () => {
    const hub = new IntegrationHub({
      registry: { enabled: () => [fake("aa", [])], serverSettings: () => ({}) },
      ownerOf: () => "u1",
      sandboxName: (id) => id,
      connectionsOf: async () => {
        throw new Error("db down");
      },
      sleep: async () => {},
      log: createChildLogger("hub-test"),
    });
    const parent = new AbortController();
    const answers: string[] = [];
    await hub.notify(bash, (id) => answers.push(id), parent.signal);
    expect(answers).toEqual([]);
    expect(parent.signal.aborted).toBe(false);
  });
});
