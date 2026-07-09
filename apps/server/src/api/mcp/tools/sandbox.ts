/**
 * Sandbox lifecycle + live-mutation tools \u2014 the MCP mirror of `/v1/*`
 * (atelier-v2 \u00a74: "it grows the mutation tools ... so agents drive sandboxes
 * exactly like the CLI does"). `create_sandbox` reuses the exact enrichment
 * path `POST /v1/sandboxes` uses (`createSandboxForUser`), so an MCP-spawned
 * sandbox gets the same org secrets/policy/auto-injected toolboxes as the
 * HTTP/CLI/GUI path \u2014 no more "no identity in this context" gap.
 */
import type { CreateSandboxRequest } from "@atelier/spec";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthUser } from "../../../control/index.ts";
import type { ServerContainer } from "../../container.ts";
import { createSandboxForUser } from "../../v1.routes.ts";
import { safeTool, text } from "../format.ts";

function formatUrl(u: { name: string; url: string; ready?: boolean }) {
  return { name: u.name, url: u.url, ready: u.ready };
}

export function registerSandboxTools(
  server: McpServer,
  container: ServerContainer,
  user: AuthUser,
): void {
  const { runtime } = container;

  server.registerTool(
    "create_sandbox",
    {
      title: "Create sandbox",
      description:
        "Boot a new sandbox from a SandboxSpec, optionally with " +
        "`toolboxes` selectors and/or a `prebuild` recipe. Applies your " +
        "org's + your own auto-injected toolboxes and org policy, same as " +
        "the CLI/dashboard.",
      inputSchema: {
        spec: z.record(z.string(), z.unknown()),
        toolboxes: z
          .array(z.string())
          .optional()
          .describe("tb/<owner>/<slug> toolbox selectors to apply"),
        prebuild: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("A prebuild recipe to resolve as this sandbox's source"),
      },
    },
    safeTool(async ({ spec, toolboxes, prebuild }) => {
      const body = {
        ...spec,
        ...(toolboxes ? { toolboxes } : {}),
        ...(prebuild ? { prebuild } : {}),
      } as CreateSandboxRequest;
      return text(await createSandboxForUser(container, user, body));
    }),
  );

  server.registerTool(
    "list_sandboxes",
    {
      title: "List sandboxes",
      description: "List known sandboxes, optionally filtered by status.",
      inputSchema: {
        status: z
          .enum(["creating", "running", "paused", "stopped", "error"])
          .optional(),
      },
    },
    safeTool(async ({ status }) => {
      const all = runtime.list();
      return text(status ? all.filter((s) => s.status === status) : all);
    }),
  );

  server.registerTool(
    "get_sandbox",
    {
      title: "Get sandbox",
      description:
        "Read a sandbox's status, URLs (with readiness), and live process " +
        "health. Use this to check on a sandbox before exec/attach.",
      inputSchema: { id: z.string() },
    },
    safeTool(async ({ id }) => {
      const state = await runtime.get(id);
      return text({
        id: state.id,
        status: state.status,
        urls: state.urls.map(formatUrl),
        processes: state.processes,
        metadata: state.metadata,
      });
    }),
  );

  server.registerTool(
    "sandbox_lifecycle",
    {
      title: "Manage sandbox lifecycle",
      description:
        "Pause (snapshot + release compute), resume, snapshot (without " +
        "releasing compute), or destroy (full teardown) a sandbox.",
      inputSchema: {
        id: z.string(),
        action: z.enum(["pause", "resume", "snapshot", "destroy"]),
      },
    },
    safeTool(async ({ id, action }) => {
      switch (action) {
        case "pause":
          return text(await runtime.pause(id));
        case "resume":
          // No files/env overrides via MCP (unlike the HTTP route, which
          // also refreshes the owner's git credentials from a resume body) —
          // plain resume; the persisted spec + last-known files still apply.
          return text(await runtime.resume(id));
        case "snapshot":
          return text(await runtime.snapshot(id));
        case "destroy":
          await runtime.destroy(id);
          return text({ ok: true });
      }
    }),
  );

  server.registerTool(
    "exec",
    {
      title: "Exec",
      description: "Run a one-shot command in a sandbox and capture output.",
      inputSchema: {
        id: z.string(),
        command: z.string(),
        cwd: z.string().optional(),
        timeoutMs: z.number().optional(),
      },
    },
    safeTool(async ({ id, ...req }) => text(await runtime.exec(id, req))),
  );

  server.registerTool(
    "manage_process",
    {
      title: "Manage process",
      description:
        "Start, stop, or read logs for a supervised process in a running " +
        "sandbox.",
      inputSchema: {
        id: z.string(),
        name: z.string(),
        action: z.enum(["start", "stop", "logs"]),
      },
    },
    safeTool(async ({ id, name, action }) => {
      if (action === "logs") return text(await runtime.processLogs(id, name));
      await runtime.processAction(id, name, action);
      return text({ ok: true });
    }),
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
    safeTool(async ({ id, files }) => {
      await runtime.patchFiles(id, files);
      return text({ ok: true });
    }),
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
    safeTool(async ({ id, ...body }) => {
      await runtime.addPort(id, body);
      return text({ ok: true });
    }),
  );
}
