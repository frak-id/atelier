import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubApp, type HubApp } from "./app.ts";
import { mintToken } from "./auth.ts";
import { type HubConfig, parseConfig } from "./config.ts";
import { signPayload } from "./github-webhook.ts";
import { createHubServices, type HubServices } from "./services.ts";

const alice = mintToken(); // human reviewer on team:platform
const bot = mintToken(); // agent answering in public
const reader = mintToken(); // read-only, cannot propose

const SECRET = "webhook-secret";
const REPO = "acme/shop";

/** Writes a tiny monorepo into `dir` — what the fake `checkout` "fetches". */
function writeFixture(dir: string, extraDoc: string): void {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "shop",
      private: true,
      workspaces: ["packages/*"],
    }),
    "README.md": "# Shop\n\nThe acme storefront monorepo.\n",
    "packages/api/package.json": JSON.stringify({
      name: "@shop/api",
      description: "Checkout and billing HTTP API",
      dependencies: { "@shop/db": "workspace:*" },
    }),
    "packages/api/src/index.ts": 'import { pool } from "@shop/db";\n',
    "packages/db/package.json": JSON.stringify({ name: "@shop/db" }),
    "packages/db/src/index.ts": "export const pool = 1;\n",
    ".github/CODEOWNERS": "/packages/api/ @acme/payments\n",
    "docs/runbook.md": `# Runbook\n\n## Refunds\n\n${extraDoc}\n`,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

let hub: HubServices;
let app: HubApp;
let revision = 0;

beforeAll(() => {
  const dataDir = mkdtempSync(join(tmpdir(), "hub-test-"));
  const config: HubConfig = parseConfig(
    {
      dataDir,
      teams: { "team:platform": ["user:alice"] },
      repos: [{ repo: REPO, branch: "main" }],
      embeddings: { provider: "hashing", dimensions: 64 },
      tokens: [
        {
          name: "alice",
          sha256: alice.sha256,
          actor: { kind: "human", id: "user:alice" },
          scopes: ["read", "propose", "review", "index"],
          audience: ["user:alice"],
        },
        {
          name: "bot",
          sha256: bot.sha256,
          actor: { kind: "agent", id: "agent:bot" },
          scopes: ["read", "propose"],
          audience: ["org"],
        },
        {
          name: "reader",
          sha256: reader.sha256,
          actor: { kind: "agent", id: "agent:reader" },
          scopes: ["read"],
          audience: ["org"],
        },
      ],
    },
    { HUB_WEBHOOK_SECRET: SECRET },
  );
  hub = createHubServices(config, {
    dbPath: ":memory:",
    indexer: {
      checkout: async (_repo, dir) => {
        revision++;
        writeFixture(dir, `Refunds are issued by the api (rev ${revision}).`);
        return `rev${revision}`;
      },
    },
  });
  app = createHubApp(hub);
});

async function call(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

describe("auth", () => {
  test("health is public, the API is not", async () => {
    expect((await call(null, "GET", "/health")).status).toBe(200);
    expect((await call(null, "GET", "/api/whoami")).status).toBe(401);
    expect((await call("hub_nope", "GET", "/api/whoami")).status).toBe(401);
    const me = await call(bot.token, "GET", "/api/whoami");
    expect(me.body.actor.id).toBe("agent:bot");
  });

  test("scopes and audience are enforced", async () => {
    const propose = await call(reader.token, "POST", "/api/memories", {
      scope: { kind: "org" },
      kind: "fact",
      content: "x",
    });
    expect(propose.status).toBe(403);
    const escalate = await call(
      bot.token,
      "GET",
      "/api/search?q=x&audience=user:alice",
    );
    expect(escalate.status).toBe(403);
  });
});

describe("proposing never reveals what the caller can't read", () => {
  test("non-reviewers get a receipt; invisible duplicates stay hidden", async () => {
    const input = {
      scope: { kind: "team", id: "platform" },
      kind: "fact",
      content: "The DR site is in Helsinki.",
      provenance: [{ kind: "slack", ref: "C9/p1", quote: "secret quote" }],
    };
    const byAlice = await call(alice.token, "POST", "/api/memories", input);
    expect(byAlice.body.provenance).toHaveLength(1); // reviewer: full row

    const byBot = await call(bot.token, "POST", "/api/memories", input);
    expect(Object.keys(byBot.body).sort()).toEqual(["id", "status"]);
    expect(byBot.body.id).not.toBe(byAlice.body.id);
  });

  test("an agent can't auto-publish org-wide through a preference", async () => {
    const res = await call(bot.token, "POST", "/api/memories", {
      scope: { kind: "user", id: "bob" },
      kind: "preference",
      content: "bob likes emoji",
      readers: ["org"],
    });
    expect(res.body.status).toBe("active");
    const seen = await call(bot.token, "GET", "/api/search?q=emoji");
    expect(seen.body).toEqual([]);
  });
});

describe("memory governance over HTTP", () => {
  let id: string;

  test("an agent proposes; it is not served before review", async () => {
    const res = await call(bot.token, "POST", "/api/memories", {
      scope: { kind: "team", id: "platform" },
      kind: "ownership",
      content: "The platform team owns the kubernetes ingress controller.",
      tags: ["infra"],
      facts: [{ type: "owns", from: "team:platform", to: "service:ingress" }],
      provenance: [{ kind: "slack", ref: "C1/p123" }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("proposed");
    id = res.body.id;

    const hits = await call(alice.token, "GET", "/api/search?q=ingress");
    expect(hits.body).toEqual([]);
  });

  test("agents cannot approve; reviewers see the queue and approve", async () => {
    const denied = await call(bot.token, "POST", `/api/memories/${id}/approve`);
    expect(denied.status).toBe(403);

    const queue = await call(alice.token, "GET", "/api/memories/review-queue");
    expect(queue.body.map((m: { id: string }) => m.id)).toContain(id);

    const ok = await call(alice.token, "POST", `/api/memories/${id}/approve`, {
      note: "confirmed",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("active");
  });

  test("the audience rule: team memory reaches alice, not a public reply", async () => {
    const forAlice = await call(alice.token, "GET", "/api/search?q=ingress");
    expect(forAlice.body.map((h: { id: string }) => h.id)).toContain(id);

    const inPublic = await call(bot.token, "GET", "/api/search?q=ingress");
    expect(inPublic.body).toEqual([]);
    const direct = await call(bot.token, "GET", `/api/memories/${id}`);
    expect(direct.status).toBe(404);
  });

  test("the memory's structured claim is in the graph", async () => {
    const res = await call(
      alice.token,
      "GET",
      `/api/graph/neighbors?id=team:platform&direction=out`,
    );
    // team:platform has no entity row, so traversal starts nowhere — but
    // factsFor on the service end still shows the claim.
    expect(res.status).toBe(200);
    const facts = hub.graph.factsFor("service:ingress", {
      audience: ["user:alice"],
    });
    expect(facts.map((f) => f.source.key)).toEqual([`memory:${id}`]);
  });

  test("flag → stale → erase leaves nothing but a content-free audit", async () => {
    const flagged = await call(bot.token, "POST", `/api/memories/${id}/flag`, {
      reason: "reorg",
    });
    // The bot can't see a team memory, so it can't flag it either.
    expect(flagged.status).toBe(404);
    const byAlice = await call(
      alice.token,
      "POST",
      `/api/memories/${id}/flag`,
      {
        reason: "reorg",
      },
    );
    expect(byAlice.body.status).toBe("stale");

    const erased = await call(alice.token, "POST", "/api/memories/erase", {
      ids: [id],
      reason: "GDPR request",
    });
    expect(erased.status).toBe(200);
    expect(erased.body.roots).toEqual([{ kind: "memory", id }]);

    expect((await call(alice.token, "GET", `/api/memories/${id}`)).status).toBe(
      404,
    );
    expect(
      hub.graph.factsFor("service:ingress", {
        audience: ["user:alice"],
        includeHistory: true,
      }),
    ).toEqual([]);
    const audit = await call(alice.token, "GET", `/api/audit?target_id=${id}`);
    const actions = audit.body.map((e: { action: string }) => e.action);
    expect(actions).toContain("memory.erase");
    expect(JSON.stringify(audit.body)).not.toContain("ingress");
  });
});

describe("GitHub webhook → index", () => {
  const push = JSON.stringify({
    ref: "refs/heads/main",
    after: "abc",
    repository: { full_name: REPO },
  });

  const deliver = (body: string, signature: string) =>
    app.handle(
      new Request("http://localhost/webhooks/github", {
        method: "POST",
        headers: {
          "x-github-event": "push",
          "x-hub-signature-256": signature,
          "content-type": "application/json",
        },
        body,
      }),
    );

  test("rejects a bad signature", async () => {
    expect((await deliver(push, "sha256=00")).status).toBe(401);
  });

  test("a signed push indexes the repository", async () => {
    const res = await deliver(push, signPayload(SECRET, push));
    expect(res.status).toBe(202);
    // Wait for the queued run.
    for (let i = 0; i < 100 && hub.indexer.isRunning(REPO); i++) {
      await Bun.sleep(20);
    }
    const [run] = hub.indexer.runs({ repo: REPO });
    expect(run?.status).toBe("succeeded");

    const api = await call(
      bot.token,
      "GET",
      `/api/graph/entities/${encodeURIComponent("package:@shop/api")}`,
    );
    expect(api.status).toBe(200);
    const facts = api.body.facts.map(
      (f: { type: string; from: string; to: string }) =>
        `${f.from} ${f.type} ${f.to}`,
    );
    expect(facts).toContain("package:@shop/api depends_on package:@shop/db");
    expect(facts).toContain("package:@shop/api imports package:@shop/db");
    expect(facts).toContain("team:payments owns package:@shop/api");

    const docs = await call(bot.token, "GET", "/api/search?q=refunds");
    expect(docs.body[0]?.kind).toBe("document");
  });

  test("a manual re-index at the same revision is skipped unless forced", async () => {
    const again = await call(
      alice.token,
      "POST",
      `/api/index/repos/${REPO}?wait=true`,
    );
    // The fake checkout bumps the revision each time, so this one runs.
    expect(again.body.status).toBe("succeeded");
    expect(again.body.report.documents.upserted).toBeGreaterThan(0);
    const denied = await call(bot.token, "POST", `/api/index/repos/${REPO}`);
    expect(denied.status).toBe(403);
  });
});

describe("MCP", () => {
  async function rpc(
    body: unknown,
    session?: string,
  ): Promise<{ session: string | null; message: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${bot.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (session) {
      headers["mcp-session-id"] = session;
      headers["mcp-protocol-version"] = "2025-06-18";
    }
    const res = await app.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    const data = text
      .split("\n")
      .find((l) => l.startsWith("data:"))
      ?.slice(5);
    return {
      session: res.headers.get("mcp-session-id"),
      message: data ? JSON.parse(data) : {},
    };
  }

  test("an agent lists tools and searches over MCP", async () => {
    const init = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    const session = init.session;
    expect(session).toBeTruthy();
    await rpc(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      session ?? "",
    );

    const tools = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      session ?? "",
    );
    const names = (
      tools.message.result as { tools: { name: string }[] }
    ).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "knowledge_search",
        "memory_propose",
        "graph_neighbors",
      ]),
    );

    const result = await rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "knowledge_search", arguments: { query: "billing" } },
      },
      session ?? "",
    );
    const content = (result.message.result as { content: { text: string }[] })
      .content[0]?.text;
    const hits = JSON.parse(content ?? "[]") as { id: string }[];
    expect(hits.map((h) => h.id)).toContain("package:@shop/api");
  });
});
