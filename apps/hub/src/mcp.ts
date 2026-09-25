/**
 * `/mcp`: the knowledge tools for agents: a worker in an Atelier sandbox,
 * an Open-Inspect session, a developer's own harness. Each session is bound
 * to the token that initialized it; tools inherit that token's scopes and
 * audience, so an agent answering in a public channel can't read a team's
 * private memories by asking.
 *
 * Stateful sessions (a transport per client), like `apps/server`'s `/mcp`:
 * OpenCode's MCP client stalls on the stateless handshake.
 */
import { KnowledgeError } from "@atelier/knowledge";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Elysia } from "elysia";
import { z } from "zod";
import { AuthError, type Caller } from "./auth.ts";
import { createLogger } from "./logger.ts";
import * as ops from "./ops.ts";
import type { HubServices } from "./services.ts";

const log = createLogger("mcp");
const SESSION_IDLE_MS = 30 * 60 * 1000;

function text(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError && { isError: true }),
  };
}

function safe<A extends unknown[]>(handler: (...args: A) => unknown) {
  return async (...args: A) => {
    try {
      return text(await handler(...args));
    } catch (error) {
      if (error instanceof KnowledgeError) {
        return text({ error: error.code, message: error.message }, true);
      }
      if (error instanceof AuthError) {
        return text({ error: "forbidden", message: error.message }, true);
      }
      log.error({ error }, "tool failed");
      return text({ error: "internal", message: String(error) }, true);
    }
  };
}

const MEMORY_KINDS = [
  "fact",
  "decision",
  "preference",
  "ownership",
  "convention",
  "incident",
] as const;

const SCOPE_KINDS = ["org", "team", "repo", "channel", "user"] as const;

function createServer(hub: HubServices, caller: Caller): McpServer {
  const server = new McpServer({ name: "atelier-hub", version: "0.1.0" });

  server.registerTool(
    "knowledge_search",
    {
      title: "Search company knowledge",
      description:
        "Search approved company memory, the code knowledge graph " +
        "(repos, packages, owners) and indexed docs. Results carry ids " +
        "you should cite. Prefer this before guessing how the company " +
        "works or who owns something.",
      inputSchema: {
        query: z.string().min(1),
        kinds: z
          .array(z.enum(["memory", "entity", "document"]))
          .optional()
          .describe("Restrict to these record kinds"),
        entity: z
          .string()
          .optional()
          .describe("Only records linked to this entity id"),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    safe(({ query, kinds, entity, limit }) =>
      ops.search(hub, caller, { query, kinds, entityId: entity, limit }),
    ),
  );

  server.registerTool(
    "memory_propose",
    {
      title: "Propose a memory",
      description:
        "Propose a durable fact worth remembering (a decision, an owner, " +
        "a convention, a preference). It is NOT used until a human " +
        "approves it. Include provenance (a link to where you learned it). " +
        "Don't propose secrets, personal data, or what the code or docs " +
        "already say.",
      inputSchema: {
        content: z.string().min(1).max(4000),
        kind: z.enum(MEMORY_KINDS),
        scope_kind: z.enum(SCOPE_KINDS),
        scope_id: z
          .string()
          .optional()
          .describe("Team slug, owner/repo, channel id or user id"),
        tags: z.array(z.string()).optional(),
        entity_ids: z
          .array(z.string())
          .optional()
          .describe("Graph entities this is about, e.g. package:@x/y"),
        provenance: z
          .array(
            z.object({
              kind: z.enum([
                "slack",
                "github",
                "linear",
                "email",
                "url",
                "thread",
                "session",
                "commit",
                "manual",
              ]),
              ref: z.string(),
              url: z.string().optional(),
              quote: z.string().max(500).optional(),
            }),
          )
          .optional(),
        supersedes: z
          .string()
          .optional()
          .describe("Id of the memory this corrects"),
      },
    },
    safe((args) => {
      const memory = ops.proposeMemory(hub, caller, {
        content: args.content,
        kind: args.kind,
        scope: { kind: args.scope_kind, id: args.scope_id ?? "" },
        tags: args.tags,
        entityIds: args.entity_ids,
        provenance: args.provenance,
        supersedes: args.supersedes,
      });
      return { id: memory.id, status: memory.status };
    }),
  );

  server.registerTool(
    "memory_flag",
    {
      title: "Flag a memory as wrong",
      description:
        "Flag a memory you were given as wrong or outdated (e.g. a user " +
        "corrected it). It stops being served until a human reviews it.",
      inputSchema: { id: z.string(), reason: z.string().min(1) },
    },
    safe(({ id, reason }) => {
      const memory = ops.flagMemory(hub, caller, id, reason);
      return { id: memory.id, status: memory.status };
    }),
  );

  server.registerTool(
    "graph_entity",
    {
      title: "Describe an entity",
      description:
        "An entity of the knowledge graph (repo, package, crate, team, " +
        "person, …) with its facts: what it contains, depends on, imports, " +
        "who owns it.",
      inputSchema: {
        id: z.string().describe("e.g. package:@atelier/spec"),
        history: z
          .boolean()
          .optional()
          .describe("Include facts that are no longer true"),
      },
    },
    safe(({ id, history }) => ops.readEntity(hub, caller, id, { history })),
  );

  server.registerTool(
    "graph_neighbors",
    {
      title: "Explore the graph",
      description:
        "Entities and facts around an entity, up to 4 hops. Use it for " +
        "impact questions: who imports this package, what a team owns.",
      inputSchema: {
        id: z.string(),
        depth: z.number().int().min(1).max(4).optional(),
        direction: z.enum(["out", "in", "both"]).optional(),
        types: z
          .array(z.string())
          .optional()
          .describe("Fact types: depends_on, imports, owns, contains, …"),
      },
    },
    safe(({ id, depth, direction, types }) =>
      ops.neighbors(hub, caller, { id, depth, direction, types }),
    ),
  );

  server.registerTool(
    "index_status",
    {
      title: "Code index status",
      description:
        "Tracked repositories and the revision each is indexed at, to " +
        "judge how fresh graph and doc answers are.",
      inputSchema: {},
    },
    safe(() =>
      hub.config.repos.map((r) => {
        const last = hub.indexer.lastSuccess(r.repo);
        return {
          repo: r.repo,
          branch: r.branch,
          revision: last?.revision,
          indexedAt: last?.finishedAt,
        };
      }),
    ),
  );

  return server;
}

interface Session {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  token: string;
  lastSeen: number;
}

export function createMcpRoutes(hub: HubServices) {
  const sessions = new Map<string, Session>();

  function evictIdle() {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > SESSION_IDLE_MS) {
        sessions.delete(id);
        s.server.close().catch(() => {});
      }
    }
  }

  const rpcError = (message: string) => ({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });

  return new Elysia().all("/mcp", async ({ request, set }) => {
    evictIdle();
    const caller = hub.auth.authenticate(request.headers.get("authorization"));

    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        set.status = 404;
        return rpcError("Unknown session ID");
      }
      if (session.token !== caller.token) {
        set.status = 403;
        return rpcError("Session belongs to another token");
      }
      session.lastSeen = Date.now();
      return session.transport.handleRequest(request);
    }

    if (request.method !== "POST") {
      set.status = 400;
      return rpcError("Missing session ID");
    }
    const body = await request.clone().json();
    if (!isInitializeRequest(body)) {
      set.status = 400;
      return rpcError("Missing session ID");
    }

    const server = createServer(hub, caller);
    let registered = false;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        registered = true;
        sessions.set(id, {
          server,
          transport,
          token: caller.token,
          lastSeen: Date.now(),
        });
      },
      onsessionclosed: (id) => {
        sessions
          .get(id)
          ?.server.close()
          .catch(() => {});
        sessions.delete(id);
      },
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request, { parsedBody: body });
    } catch (error) {
      if (!registered) server.close().catch(() => {});
      throw error;
    }
  });
}
