import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Elysia } from "elysia";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { registerDevCommandTools } from "./tools/dev-commands.ts";
import { registerSandboxTools } from "./tools/sandbox.ts";
import { registerSessionTemplateTools } from "./tools/session-template.ts";
import { registerSystemTools } from "./tools/system.ts";
import { registerTaskTools } from "./tools/task.ts";
import { registerWorkspaceTools } from "./tools/workspace.ts";

const log = createChildLogger("mcp");

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "atelier-manager",
    version: "0.1.0",
  });

  registerWorkspaceTools(server);
  registerTaskTools(server);
  registerSandboxTools(server);
  registerDevCommandTools(server);
  registerSessionTemplateTools(server);
  registerSystemTools(server);

  return server;
}

function verifyMcpAuth(request: Request): boolean {
  if (isMock()) return true;

  const token = config.server.mcpToken;
  if (!token) return true;

  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;

  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  return bearerToken === token;
}

// Single-slot stateful MCP session.
// Only one client connects at a time (system sandbox), so we keep exactly
// one server + transport pair. Using stateful mode (with sessionIdGenerator)
// lets the StreamableHTTP multi-step handshake (initialize \u2192 initialized \u2192
// tools/list) hit the same transport instance, avoiding a ~10 s
// timeout-then-SSE-fallback in OpenCode's MCP client.
// When the client reconnects, the new `initialize` replaces the old session.
let activeServer: McpServer | null = null;
let activeTransport: WebStandardStreamableHTTPServerTransport | null = null;

export const mcpRoutes = new Elysia({ prefix: "/mcp" }).all(
  "",
  async ({ request, set }) => {
    if (!verifyMcpAuth(request)) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Invalid MCP token" };
    }

    try {
      const sessionId = request.headers.get("mcp-session-id");

      // Existing session \u2014 delegate to the active transport
      if (sessionId && activeTransport?.sessionId === sessionId) {
        return await activeTransport.handleRequest(request);
      }

      // New initialization \u2014 tear down previous session, create fresh one
      if (request.method === "POST") {
        const body = await request.clone().json();

        if (isInitializeRequest(body)) {
          if (activeServer) {
            await activeServer.close().catch(() => {});
          }

          activeServer = createMcpServer();
          activeTransport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
          });

          await activeServer.connect(activeTransport);
          log.info("MCP session initialized");

          return await activeTransport.handleRequest(request, {
            parsedBody: body,
          });
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
