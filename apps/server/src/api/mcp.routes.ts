/**
 * `/mcp` — same transport pattern as v1, but the tools grow mutation
 * capability (atelier-v2 §4: "it grows the mutation tools (create/pause/
 * resume/rm/files/expose) so agents drive sandboxes exactly like the CLI
 * does"). One API, three surfaces — GUI (primary), CLI, MCP.
 */
import type { SandboxSpec } from "@atelier/spec";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Elysia } from "elysia";
import { z } from "zod";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { ServerContainer } from "./container.ts";

const log = createChildLogger("mcp");

function textResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function createMcpServer(container: ServerContainer): McpServer {
  const { runtime, control } = container;
  const server = new McpServer({ name: "atelier-server", version: "0.1.0" });

  server.registerTool(
    "create_sandbox",
    {
      title: "Create sandbox",
      description: "Boot a new sandbox from a resolved SandboxSpec.",
      inputSchema: { spec: z.record(z.string(), z.unknown()) },
    },
    async ({ spec }) => {
      // No authenticated user identity in this MCP tool context (verifyMcpAuth
      // is a static bearer token, not a per-user session) — orgId can't be
      // resolved here yet; org-scoped secrets/policy are unreachable via MCP
      // until MCP auth carries a user identity (see PHASE0.md).
      const enriched = await control.enrichSpec(spec as SandboxSpec, undefined);
      const authorizedKeys = control.sshKeyService.getValidPublicKeys();
      return textResult(await runtime.create(enriched, { authorizedKeys }));
    },
  );

  server.registerTool(
    "get_sandbox",
    {
      title: "Get sandbox",
      description: "Read a sandbox's status, urls, and process health.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => textResult(await runtime.get(id)),
  );

  server.registerTool(
    "pause_sandbox",
    {
      title: "Pause sandbox",
      description: "Snapshot the disk and release compute.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => textResult(await runtime.pause(id)),
  );

  server.registerTool(
    "resume_sandbox",
    {
      title: "Resume sandbox",
      description: "Boot from the pause snapshot; runs onResume hooks.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => textResult(await runtime.resume(id)),
  );

  server.registerTool(
    "rm_sandbox",
    {
      title: "Remove sandbox",
      description: "Full teardown of a sandbox's resources.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      await runtime.destroy(id);
      return textResult({ ok: true });
    },
  );

  server.registerTool(
    "patch_files",
    {
      title: "Push files",
      description: "Live-push files into a running sandbox.",
      inputSchema: {
        id: z.string(),
        files: z.array(
          z.object({
            path: z.string(),
            content: z.string(),
            mode: z.string().optional(),
          }),
        ),
      },
    },
    async ({ id, files }) => {
      await runtime.patchFiles(id, files);
      return textResult({ ok: true });
    },
  );

  server.registerTool(
    "expose_port",
    {
      title: "Expose port",
      description: "Expose a port on a running sandbox after boot.",
      inputSchema: {
        id: z.string(),
        name: z.string(),
        port: z.number(),
        public: z.boolean().optional(),
      },
    },
    async ({ id, ...body }) => {
      await runtime.addPort(id, body);
      return textResult({ ok: true });
    },
  );

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

export function createMcpRoutes(container: ServerContainer) {
  // Single-slot stateful session, same rationale as v1: keeps the
  // StreamableHTTP multi-step handshake on one transport instance.
  let activeServer: McpServer | null = null;
  let activeTransport: WebStandardStreamableHTTPServerTransport | null = null;

  return new Elysia({ prefix: "/mcp" }).all("", async ({ request, set }) => {
    if (!verifyMcpAuth(request)) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Invalid MCP token" };
    }

    try {
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId && activeTransport?.sessionId === sessionId) {
        return await activeTransport.handleRequest(request);
      }

      if (request.method === "POST") {
        const body = await request.clone().json();
        if (isInitializeRequest(body)) {
          if (activeServer) await activeServer.close().catch(() => {});
          activeServer = createMcpServer(container);
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
  });
}
