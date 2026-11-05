/**
 * The MCP endpoints over HTTP: `/mcp` for any authenticated user,
 * `/mcp/admin` for server admins only, and a session id the server does not
 * know (a deploy, an idle eviction) answers 404 so the client re-initializes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerContainer } from "../container.ts";

let dataDir: string;
let handle: (request: Request) => Promise<Response>;

const USERS: Record<string, { id: string; username: string }> = {
  "tok-admin": { id: "admin", username: "admin" },
  "tok-member": { id: "member", username: "member" },
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-mcp-index-"));
  process.env.DATA_DIR = dataDir;
  const { createMcpRoutes } = await import("./index.ts");
  const container = {
    control: {
      authService: {
        resolveToken: async (token?: string) => {
          const user = token ? USERS[token] : undefined;
          if (!user) throw new Error("bad token");
          return user;
        },
      },
      defaultOrg: { isServerAdmin: (id: string) => id === "admin" },
    },
  } as unknown as ServerContainer;
  const app = createMcpRoutes(container);
  handle = (request) => app.handle(request);
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
};

function post(
  path: string,
  token: string,
  body: unknown,
  sessionId?: string,
): Promise<Response> {
  return handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("MCP endpoints", () => {
  test("an unauthenticated request is 401", async () => {
    expect((await post("/mcp", "nope", INITIALIZE)).status).toBe(401);
  });

  test("any user initializes /mcp and gets a session", async () => {
    const res = await post("/mcp", "tok-member", INITIALIZE);
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
  });

  test("an unknown session id is 404, so the client starts a new one", async () => {
    const res = await post(
      "/mcp",
      "tok-member",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      "evicted-session",
    );
    expect(res.status).toBe(404);
  });

  test("/mcp/admin is 403 for a non-admin and open to a server admin", async () => {
    expect((await post("/mcp/admin", "tok-member", INITIALIZE)).status).toBe(
      403,
    );
    const ok = await post("/mcp/admin", "tok-admin", INITIALIZE);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("mcp-session-id")).toBeTruthy();
  });

  test("a /mcp session is unknown on /mcp/admin", async () => {
    const init = await post("/mcp", "tok-admin", INITIALIZE);
    const sessionId = init.headers.get("mcp-session-id") ?? "";
    const res = await post(
      "/mcp/admin",
      "tok-admin",
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      sessionId,
    );
    expect(res.status).toBe(404);
  });
});
