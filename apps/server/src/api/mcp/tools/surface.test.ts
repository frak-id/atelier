/**
 * The MCP tool surface, pinned. Every tool is a choice the agent has to make
 * and a schema it pays for in every session, so adding one should be a
 * deliberate edit here, not a side effect. Related operations share a tool
 * (`get_sandbox` reads one sandbox or lists them, `send_prompt` starts or
 * continues a task, ...) instead of getting a sibling.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { AuthUser } from "../../../control/index.ts";
import type { ServerContainer } from "../../container.ts";
import { registerAdminTools } from "./admin.ts";
import { connectMcp } from "./mcp.test-support.ts";
import { registerSandboxTools } from "./sandbox.ts";
import { registerSystemTools } from "./system.ts";
import { registerTaskTools } from "./tasks.ts";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

// Registration only closes over the container; no tool runs here.
const container = {} as unknown as ServerContainer;
const user = { id: "u", username: "u" } as unknown as AuthUser;

async function surface(register: Parameters<typeof connectMcp>[0]) {
  const mcp = await connectMcp(register);
  cleanups.push(() => mcp.close());
  return mcp;
}

describe("MCP tool surface", () => {
  test("the sandbox MCP is exactly these 13 tools, in this order", async () => {
    const mcp = await surface((server) => {
      registerSystemTools(server, container, user);
      registerSandboxTools(server, container, user);
      registerTaskTools(server, container, user);
    });
    expect(await mcp.toolNames()).toEqual([
      "whoami",
      "get_sandbox",
      "create_sandbox",
      "sandbox_lifecycle",
      "destroy_sandbox",
      "exec",
      "read_files",
      "write_files",
      "manage_process",
      "expose_port",
      "send_prompt",
      "get_task",
      "manage_task",
    ]);
  });

  test("the admin MCP is exactly these 4 tools, in this order", async () => {
    const mcp = await surface((server) =>
      registerAdminTools(server, container, user),
    );
    expect(await mcp.toolNames()).toEqual([
      "manage_prebuilds",
      "manage_toolbox",
      "manage_images",
      "server_config",
    ]);
  });

  test("every tool carries the full set of behaviour annotations", async () => {
    const mcp = await surface((server) => {
      registerSystemTools(server, container, user);
      registerSandboxTools(server, container, user);
      registerTaskTools(server, container, user);
      registerAdminTools(server, container, user);
    });
    for (const tool of await mcp.tools()) {
      const a = tool.annotations;
      expect(a?.readOnlyHint, `${tool.name} readOnlyHint`).toBeBoolean();
      expect(a?.openWorldHint, `${tool.name} openWorldHint`).toBeBoolean();
      if (a?.readOnlyHint === false) {
        expect(a.destructiveHint, `${tool.name} destructiveHint`).toBeBoolean();
        expect(a.idempotentHint, `${tool.name} idempotentHint`).toBeBoolean();
      }
    }
  });

  test("read tools declare an outputSchema; destructive ones are marked", async () => {
    const mcp = await surface((server) => {
      registerSystemTools(server, container, user);
      registerSandboxTools(server, container, user);
      registerTaskTools(server, container, user);
    });
    const tools = new Map((await mcp.tools()).map((t) => [t.name, t]));
    for (const name of ["whoami", "get_sandbox", "get_task", "read_files"]) {
      expect(tools.get(name)?.outputSchema, name).toBeDefined();
      expect(tools.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    for (const name of ["destroy_sandbox", "exec", "write_files"]) {
      expect(tools.get(name)?.annotations?.destructiveHint, name).toBe(true);
    }
    expect(tools.get("expose_port")?.annotations?.openWorldHint).toBe(true);
  });
});
