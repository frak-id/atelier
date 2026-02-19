import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
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

export const mcpRoutes = new Elysia({ prefix: "/mcp" }).all(
  "",
  async ({ request, set }) => {
    if (!verifyMcpAuth(request)) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Invalid MCP token" };
    }

    const server = createMcpServer();

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);

    try {
      return await transport.handleRequest(request);
    } catch (error) {
      log.error({ error }, "MCP request handling failed");
      set.status = 500;
      return { error: "INTERNAL_ERROR", message: "MCP request failed" };
    } finally {
      await server.close();
    }
  },
);
