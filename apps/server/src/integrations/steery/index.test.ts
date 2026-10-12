import { describe, expect, test } from "bun:test";
import type { PermissionContext, PermissionRequest } from "../integration.ts";
import { steery } from "./index.ts";

const request: PermissionRequest = {
  requestId: "r1",
  sandboxId: "sb1",
  sandboxName: "my-box",
  title: "rm -rf build",
  kind: "delete",
  risk: "high",
  options: [
    { optionId: "allow", name: "Allow once please", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
};

interface Call {
  method: string;
  url: string;
  auth: string | null;
  redirect: RequestInit["redirect"];
  body: unknown;
}

type Reply = Response | Error | "hang";

/** A fake fetch: POST /v1/requests answers `raise`, GETs pop `reads`. */
function fakeSteery(reads: Reply[], raise: Reply = Response.json({})) {
  const calls: Call[] = [];
  let markHung: () => void = () => {};
  /** Resolves once a read is hanging, waiting for the abort. */
  const hung = new Promise<void>((resolve) => {
    markHung = resolve;
  });
  const fetch = async (input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: input,
      auth: headers.get("authorization"),
      redirect: init?.redirect,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    let reply: Reply = Response.json({});
    if (method === "POST" && input.endsWith("/v1/requests")) reply = raise;
    else if (method === "GET") {
      reply = reads.shift() ?? Response.json({ status: "open" });
    }
    if (reply === "hang") {
      markHung();
      await new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        ),
      );
    }
    if (reply instanceof Error) throw reply;
    return reply as Response;
  };
  return { calls, fetch, hung };
}

const responded = (choice: unknown) =>
  Response.json({
    status: "responded",
    response: { answer: { values: { choice } } },
  });

function ctx(over: Partial<PermissionContext> = {}) {
  const answers: string[] = [];
  const abort = new AbortController();
  const context: PermissionContext = {
    answer: (id) => answers.push(id),
    signal: abort.signal,
    serverSettings: { url: "https://steery.test/" },
    connection: { credential: "key-secret" },
    log: { warn() {}, debug() {}, info() {}, error() {} } as never,
    ...over,
  };
  return { context, answers, abort };
}

const noSleep = async () => {};
const run = async (
  fake: { fetch: (input: string, init?: RequestInit) => Promise<Response> },
  c: PermissionContext,
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = noSleep,
  req: PermissionRequest = request,
  timeouts: { requestTimeoutMs?: number; readTimeoutMs?: number } = {},
) => {
  await steery({ fetch: fake.fetch, sleep, ...timeouts }).onPermission?.(
    req,
    c,
  );
};

describe("steery onPermission", () => {
  test("raises a request and answers with the pressed button", async () => {
    const fake = fakeSteery([
      Response.json({ status: "open" }),
      responded("deny"),
    ]);
    const { context, answers } = ctx();
    await run(fake, context);

    expect(answers).toEqual(["deny"]);
    const [raise, ...reads] = fake.calls;
    expect(raise?.method).toBe("POST");
    expect(raise?.url).toBe("https://steery.test/v1/requests");
    expect(raise?.auth).toBe("Bearer key-secret");
    expect(raise?.redirect).toBe("manual");
    const body = raise?.body as {
      title: string;
      input: { options: { id: string; label: string; stance: string }[] }[];
    };
    expect(body.title).toBe("Let the agent delete files?");
    expect(body.input[0]?.options).toEqual([
      { id: "allow", label: "Allow once please", stance: "neutral" },
      { id: "deny", label: "Deny", stance: "rejection" },
    ]);
    expect(reads.map((r) => r.url.split("?")[1])).toEqual([
      "wait_secs=300",
      "wait_secs=300",
    ]);
    // Answered: nothing to withdraw.
    expect(fake.calls.some((c) => c.url.endsWith("/report"))).toBe(false);
  });

  test("withdraws the request when the prompt settles elsewhere", async () => {
    const fake = fakeSteery(["hang"]);
    const { context, answers, abort } = ctx();
    const done = run(fake, context);
    await fake.hung;
    abort.abort();
    await done;
    const report = fake.calls.find((c) => c.url.endsWith("/report"));
    expect(report?.body).toMatchObject({ state: "withdrawn" });
    expect(report?.redirect).toBe("manual");
    expect(answers).toEqual([]);
  });

  test("ignores an option the agent did not offer", async () => {
    const fake = fakeSteery([responded("allow-always")]);
    const { context, answers } = ctx();
    await run(fake, context);
    expect(answers).toEqual([]);
  });

  test("a refused raise throws and attempts a withdraw", async () => {
    const fake = fakeSteery([], new Response("nope", { status: 401 }));
    const { context } = ctx();
    await expect(run(fake, context)).rejects.toThrow("401");
    expect(fake.calls.at(-1)?.url).toMatch(/\/v1\/requests\/.+\/report$/);
  });

  test("a raise failing in flight is withdrawn", async () => {
    const fake = fakeSteery([], new Error("socket closed"));
    const { context } = ctx();
    await expect(run(fake, context)).rejects.toThrow("socket closed");
    expect(fake.calls.at(-1)?.url).toMatch(/\/report$/);
  });

  test("fails without a key and calls nothing", async () => {
    const fake = fakeSteery([]);
    const { context } = ctx({ connection: {} });
    await expect(run(fake, context)).rejects.toThrow("no Steery API key");
    expect(fake.calls).toEqual([]);
  });

  test("retries a failed read with the backoff", async () => {
    const waits: number[] = [];
    const fake = fakeSteery([
      new Response("", { status: 500 }),
      new Error("reset"),
      responded("allow"),
    ]);
    const { context, answers } = ctx();
    await run(fake, context, async (ms) => {
      waits.push(ms);
    });
    expect(waits).toEqual([1000, 2000]);
    expect(answers).toEqual(["allow"]);
  });

  test("abort while backing off withdraws", async () => {
    const fake = fakeSteery([new Response("", { status: 500 })]);
    const { context, abort } = ctx();
    await run(fake, context, async () => {
      abort.abort();
      throw new Error("aborted");
    });
    expect(fake.calls.at(-1)?.url).toMatch(/\/report$/);
  });

  test("a read that never returns times out into a retry", async () => {
    const fake = fakeSteery(["hang", responded("allow")]);
    const { context, answers } = ctx();
    await run(fake, context, noSleep, request, { readTimeoutMs: 20 });
    expect(answers).toEqual(["allow"]);
  });

  test("a raise that never returns times out and is withdrawn", async () => {
    const fake = fakeSteery([], "hang");
    const { context } = ctx();
    await expect(
      run(fake, context, noSleep, request, { requestTimeoutMs: 20 }),
    ).rejects.toThrow();
    expect(fake.calls.at(-1)?.url).toMatch(/\/report$/);
  });

  test("a prompt already settled raises nothing", async () => {
    const fake = fakeSteery([]);
    const { context, abort } = ctx();
    abort.abort();
    await run(fake, context);
    expect(fake.calls).toEqual([]);
  });

  test("fails on a missing url setting", async () => {
    const fake = fakeSteery([]);
    const { context } = ctx({ serverSettings: {} });
    await expect(run(fake, context)).rejects.toThrow("missing url setting");
    expect(fake.calls).toEqual([]);
  });

  test("abort during an in-flight raise withdraws by id, without reading", async () => {
    const calls: Call[] = [];
    let landRaise: (res: Response) => void = () => {};
    let markRaising: () => void = () => {};
    const raising = new Promise<void>((resolve) => {
      markRaising = resolve;
    });
    const fetch = async (input: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: input,
        auth: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (input.endsWith("/v1/requests")) {
        return new Promise<Response>((resolve) => {
          landRaise = resolve;
          markRaising();
        });
      }
      return Response.json({});
    };
    const { context, answers, abort } = ctx();
    const done = run({ fetch }, context);
    await raising;
    abort.abort();
    landRaise(Response.json({}));
    await done;
    const raisedId = (calls[0]?.body as { id: string } | undefined)?.id;
    expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
    expect(calls[1]?.url).toBe(
      `https://steery.test/v1/requests/${raisedId}/report`,
    );
    expect(answers).toEqual([]);
  });

  test("a 3xx on the raise fails and withdraws, never following it", async () => {
    const fake = fakeSteery(
      [],
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/steal" },
      }),
    );
    const { context } = ctx();
    await expect(run(fake, context)).rejects.toThrow("302");
    expect(fake.calls.at(-1)?.url).toMatch(/\/report$/);
    expect(
      fake.calls.every((c) => c.url.startsWith("https://steery.test/")),
    ).toBe(true);
  });

  test("a 3xx on a read takes the retry path", async () => {
    const waits: number[] = [];
    const fake = fakeSteery([
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/steal" },
      }),
      responded("allow"),
    ]);
    const { context, answers } = ctx();
    await run(fake, context, async (ms) => {
      waits.push(ms);
    });
    expect(waits).toEqual([1000]);
    expect(answers).toEqual(["allow"]);
    expect(
      fake.calls.every((c) => c.url.startsWith("https://steery.test/")),
    ).toBe(true);
  });

  test("caps the title at 8 words, the buttons at 3, and cleans markdown", async () => {
    const fake = fakeSteery([responded("allow")]);
    const { context } = ctx();
    const req: PermissionRequest = {
      ...request,
      kind: undefined,
      title: "`rm -rf`\nthen **more**",
      sandboxName: "my `box`\nname",
      options: [
        {
          optionId: "allow",
          name: "Allow this one time only",
          kind: "allow_once",
        },
      ],
    };
    await run(fake, context, noSleep, req);
    const body = fake.calls[0]?.body as {
      title: string;
      body: string;
      input: { options: { label: string }[] }[];
    };
    expect(body.title.split(" ").length).toBeLessThanOrEqual(8);
    expect(body.input[0]?.options[0]?.label).toBe("Allow this one");
    expect(body.body).toContain("**my box name** asks to **rm -rf then more**");
    expect(body.body).not.toContain("`");
  });

  test("agent-supplied text cannot carry links or emphasis", async () => {
    const fake = fakeSteery([responded("allow")]);
    const { context } = ctx();
    await run(fake, context, noSleep, {
      ...request,
      kind: undefined,
      title: "open [click](https://evil.test) _now_ <b>",
      sandboxName: "a*b",
    });
    const body = fake.calls[0]?.body as { body: string };
    expect(body.body).toContain(
      "**ab** asks to **open clickhttps://evil.test now b**",
    );
    expect(body.body).not.toMatch(/[[\]<>_]|\]\(/);
  });

  test("an 8-word cap applies to a long title", async () => {
    const fake = fakeSteery([responded("allow")]);
    const { context } = ctx();
    await run(fake, context, noSleep, {
      ...request,
      kind: undefined,
      title: "one two three four five six seven eight nine ten",
    });
    const body = fake.calls[0]?.body as { title: string };
    expect(body.title.split(" ")).toHaveLength(8);
  });

  test("never logs or throws the key, even when errors embed it", async () => {
    const lines: string[] = [];
    const sink = (...a: unknown[]) => lines.push(JSON.stringify(a));
    const log = { warn: sink, debug: sink, info: sink, error: sink } as never;
    // A fetch whose errors echo the request, headers included.
    const leaky = async (input: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      throw new Error(`fetch failed: ${input} ${auth}`);
    };

    const { context } = ctx({ log });
    const err = await run({ fetch: leaky }, context).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("fetch failed");
    expect(
      JSON.stringify([(err as Error).message, (err as Error).stack]),
    ).not.toContain("key-secret");

    // The read-retry path logs the failure.
    let reads = 0;
    const leakyRead = async (input: string, init?: RequestInit) => {
      if (init?.method === "GET" && reads++ === 0) return leaky(input, init);
      return init?.method === "GET" ? responded("allow") : Response.json({});
    };
    await run({ fetch: leakyRead }, ctx({ log }).context);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toContain("key-secret");
  });
});
