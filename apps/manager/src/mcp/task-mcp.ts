import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Elysia } from "elysia";
import { z } from "zod/v4";
import { sandboxService, taskService } from "../container.ts";
import type {
  IntegrationAdapter,
  IntegrationEvent,
  IntegrationGateway,
} from "../modules/integration/index.ts";
import { createInternalGuard, getRequestIp } from "../shared/lib/internal.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("task-mcp");

let gateway: IntegrationGateway | null = null;

export function setTaskMcpGateway(gw: IntegrationGateway): void {
  gateway = gw;
}

type ResolveResult =
  | { ok: false; error: string }
  | { ok: true; adapter: IntegrationAdapter; event: IntegrationEvent };

function resolveTask(taskId: string): ResolveResult {
  const task = taskService.getById(taskId);
  if (!task) return { ok: false, error: "Task not found" };

  const integration = task.data.integration;
  if (!integration) return { ok: false, error: "Task has no integration" };

  const adapter = gateway?.getAdapter(integration.source as "slack" | "github");
  if (!adapter) return { ok: false, error: "No adapter for source" };

  return {
    ok: true,
    adapter,
    event: {
      source: integration.source as "slack" | "github",
      threadKey: integration.threadKey,
      user: "task-sandbox",
      text: "",
      raw: integration.slack ?? integration.github ?? {},
    },
  };
}

function createTaskMcpServer(taskId: string): McpServer {
  const server = new McpServer({
    name: `atelier-task-${taskId}`,
    version: "0.1.0",
  });

  server.registerTool(
    "get_context",
    {
      title: "Get Conversation Context",
      description:
        "Fetch the full conversation context from the platform " +
        "that triggered this task (Slack thread, GitHub PR, etc.).",
      inputSchema: z.object({}),
    },
    async () => {
      const result = resolveTask(taskId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }

      try {
        const context = await result.adapter.extractContext(result.event);
        const markdown = result.adapter.formatContextForPrompt(context);
        return { content: [{ type: "text" as const, text: markdown }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ taskId, error: msg }, "get_context failed");
        return {
          content: [{ type: "text" as const, text: `Failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "reply",
    {
      title: "Reply to Conversation",
      description:
        "Post a message back to the conversation that triggered " +
        "this task. Use for progress updates, questions, or results.",
      inputSchema: z.object({
        message: z.string().describe("The message to post"),
      }),
    },
    async ({ message }) => {
      const result = resolveTask(taskId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }

      try {
        await result.adapter.postMessage(result.event, message);
        return {
          content: [
            { type: "text" as const, text: "Message posted successfully" },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ taskId, error: msg }, "reply failed");
        return {
          content: [{ type: "text" as const, text: `Failed: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

const internalGuard = createInternalGuard(() => sandboxService.getAll());

export const taskMcpRoutes = new Elysia({ prefix: "/mcp/task" }).all(
  "/:taskId",
  async ({ params, request, set, server }) => {
    const guardResult = internalGuard({ request, server, set });
    if (guardResult) return guardResult;

    const task = taskService.getById(params.taskId);
    if (!task) {
      set.status = 404;
      return { error: "NOT_FOUND", message: "Task not found" };
    }

    if (!task.data.integration) {
      set.status = 400;
      return {
        error: "NO_INTEGRATION",
        message: "Task has no integration metadata",
      };
    }

    const callerIp = getRequestIp(request, server);
    if (callerIp && task.data.sandboxId) {
      const sandbox = sandboxService.getById(task.data.sandboxId);
      if (sandbox && sandbox.runtime.ipAddress !== callerIp) {
        set.status = 403;
        return {
          error: "FORBIDDEN",
          message: "Only the task's own sandbox can access this endpoint",
        };
      }
    }

    const mcpServer = createTaskMcpServer(params.taskId);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await mcpServer.connect(transport);

    try {
      return await transport.handleRequest(request);
    } catch (error) {
      log.error({ taskId: params.taskId, error }, "Task MCP request failed");
      set.status = 500;
      return { error: "INTERNAL_ERROR", message: "MCP request failed" };
    } finally {
      await mcpServer.close();
    }
  },
);
