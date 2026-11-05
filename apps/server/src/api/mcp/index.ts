/**
 * Two MCP endpoints, one server and one auth:
 *  - `/mcp` — the sandbox MCP, what agents connect to: whoami, the sandbox
 *    lifecycle, exec/files/processes/ports and agent tasks;
 *  - `/mcp/admin` — the admin MCP, for curating the environment (prebuilds,
 *    toolboxes, base images, server config). Server admins only: anyone else
 *    gets 403 (see `ControlContainer.defaultOrg.isServerAdmin`).
 *
 * Per-user identity: the bearer token is resolved through
 * `control.authService.resolveToken` — the same `atl_`
 * API-key / JWT path every other route uses — instead of a single static
 * shared token. Each MCP session is bound to the user who initialized it;
 * every tool call closes over that resolved identity, so org-scoped
 * data (secrets, toolboxes) is reachable from MCP exactly as it is from the
 * HTTP API.
 *
 * Sessions are kept in a map per endpoint (one stateful transport per
 * client), not a single global slot — required once callers carry distinct
 * identities: two developers' IDEs must not evict each other's session.
 * Still STATEFUL (`sessionIdGenerator` set): a stateless-mode experiment
 * caused a ~10s timeout-then-SSE-fallback in OpenCode's MCP client during
 * the `initialize → initialized → tools/list` handshake, so every session
 * keeps its own long-lived transport instance. Because sessions live in
 * memory, an unknown session id (a deploy, an idle eviction) answers 404:
 * the Streamable HTTP spec's cue for the client to initialize a new one.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Elysia } from "elysia";
import type { AuthUser } from "../../control/index.ts";
import { isAuthBypassed } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ServerContainer } from "../container.ts";
import { registerAdminTools } from "./tools/admin.ts";
import { registerSandboxTools } from "./tools/sandbox.ts";
import { registerSystemTools } from "./tools/system.ts";
import { registerTaskTools } from "./tools/tasks.ts";

const log = createChildLogger("mcp");

/** Idle sessions are evicted lazily on the next request rather than via a
 * timer — this route is low-traffic enough that a background sweep isn't
 * worth the extra lifecycle to manage. */
const SESSION_IDLE_MS = 30 * 60 * 1000;

/** Any non-empty placeholder — `resolveToken`/`verifyJwt` ignore its content
 * when auth is bypassed (local mode). */
const MOCK_TOKEN = "mock";

interface McpSession {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  userId: string;
  lastSeen: number;
}

/** Registration order is the `tools/list` order: keep it fixed. */
type RegisterTools = (
  server: McpServer,
  container: ServerContainer,
  user: AuthUser,
) => void;

const registerSandboxMcp: RegisterTools = (server, container, user) => {
  registerSystemTools(server, container, user);
  registerSandboxTools(server, container, user);
  registerTaskTools(server, container, user);
};

function createMcpServer(
  container: ServerContainer,
  user: AuthUser,
  register: RegisterTools,
): McpServer {
  const server = new McpServer({ name: "atelier-server", version: "0.1.0" });
  register(server, container, user);
  return server;
}

function bearerFrom(request: Request): string | undefined {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return undefined;
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
}

async function resolveMcpUser(
  container: ServerContainer,
  request: Request,
): Promise<AuthUser> {
  const token = bearerFrom(request);
  // Auth-bypassed mode (local) has no real bearer token to send;
  // `resolveToken` throws on a missing token, but `verifyJwt` (which it
  // delegates to for non-`atl_` tokens) ignores its input entirely when auth
  // is bypassed and always returns the fixed mock user — so any non-empty
  // placeholder works.
  if (isAuthBypassed() && !token) {
    return container.control.authService.resolveToken(MOCK_TOKEN);
  }
  return container.control.authService.resolveToken(token);
}

interface McpEndpoint {
  path: string;
  register: RegisterTools;
  /** Whether `user` may connect (403 otherwise). */
  allow: (container: ServerContainer, user: AuthUser) => boolean;
}

const ENDPOINTS: McpEndpoint[] = [
  { path: "/mcp", register: registerSandboxMcp, allow: () => true },
  {
    path: "/mcp/admin",
    register: registerAdminTools,
    allow: (container, user) =>
      container.control.defaultOrg.isServerAdmin(user.id),
  },
];

export function createMcpRoutes(container: ServerContainer) {
  return new Elysia()
    .use(createMcpEndpoint(container, ENDPOINTS[0] as McpEndpoint))
    .use(createMcpEndpoint(container, ENDPOINTS[1] as McpEndpoint));
}

function createMcpEndpoint(container: ServerContainer, endpoint: McpEndpoint) {
  const sessions = new Map<string, McpSession>();

  function evictIdleSessions() {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (now - session.lastSeen > SESSION_IDLE_MS) {
        sessions.delete(sessionId);
        session.server.close().catch(() => {});
      }
    }
  }

  return new Elysia({ prefix: endpoint.path }).all(
    "",
    async ({ request, set }) => {
      evictIdleSessions();

      let user: AuthUser;
      try {
        user = await resolveMcpUser(container, request);
      } catch {
        set.status = 401;
        return { error: "UNAUTHORIZED", message: "Invalid or missing token" };
      }

      if (!endpoint.allow(container, user)) {
        set.status = 403;
        return {
          error: "FORBIDDEN",
          message: "Only server admins can use the admin MCP",
        };
      }

      try {
        const sessionId = request.headers.get("mcp-session-id");
        if (sessionId) {
          const session = sessions.get(sessionId);
          if (!session) {
            // 404, not 400: it is what tells a spec-compliant client to
            // start a new session (after a deploy or an idle eviction).
            set.status = 404;
            return {
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found" },
              id: null,
            };
          }
          // Re-resolving on every request is cheap (cached JWT verify / indexed
          // API-key lookup) and prevents one user from reaching another's
          // session by guessing a session id.
          if (session.userId !== user.id) {
            set.status = 401;
            return {
              error: "UNAUTHORIZED",
              message: "Session belongs to a different user",
            };
          }
          // A client-initiated DELETE is handled entirely inside the SDK: it
          // calls `onsessionclosed` (below) and closes the transport itself.
          session.lastSeen = Date.now();
          return await session.transport.handleRequest(request);
        }

        if (request.method === "POST") {
          const body = await request.clone().json();
          if (isInitializeRequest(body)) {
            const server = createMcpServer(container, user, endpoint.register);
            // If `handleRequest` fails before the SDK fires
            // `onsessioninitialized`, the connected server is in no map and
            // nothing would ever close it — track registration so the catch
            // below can release the orphan.
            let registered = false;
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (newSessionId) => {
                registered = true;
                sessions.set(newSessionId, {
                  server,
                  transport,
                  userId: user.id,
                  lastSeen: Date.now(),
                });
                log.info({ userId: user.id }, "MCP session initialized");
              },
              onsessionclosed: (closedSessionId) => {
                // The transport closes itself; the McpServer instance doesn't
                // — close it here so a client-initiated DELETE releases both.
                sessions
                  .get(closedSessionId)
                  ?.server.close()
                  .catch(() => {});
                sessions.delete(closedSessionId);
              },
            });
            await server.connect(transport);
            try {
              return await transport.handleRequest(request, {
                parsedBody: body,
              });
            } catch (err) {
              if (!registered) server.close().catch(() => {});
              throw err;
            }
          }
        }

        set.status = 400;
        return {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: Missing session ID" },
          id: null,
        };
      } catch (error) {
        log.error({ error }, "MCP request handling failed");
        set.status = 500;
        return { error: "INTERNAL_ERROR", message: "MCP request failed" };
      }
    },
  );
}
