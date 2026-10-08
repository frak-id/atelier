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
import { registerConfigTools } from "./config.ts";
import { connectMcp } from "./mcp.test-support.ts";
import { registerSandboxTools } from "./sandbox.ts";
import { registerSystemTools } from "./system.ts";
import { registerTaskTools } from "./tasks.ts";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

describe("MCP tool surface", () => {
  test("is exactly these 14 tools", async () => {
    // Registration only closes over the container; no tool runs here.
    const container = {} as unknown as ServerContainer;
    const user = { id: "u", username: "u" } as unknown as AuthUser;
    const mcp = await connectMcp((server) => {
      registerSystemTools(server, container, user);
      registerSandboxTools(server, container, user);
      registerConfigTools(server, container, user);
      registerTaskTools(server, container, user);
    });
    cleanups.push(() => mcp.close());

    expect(await mcp.toolNames()).toEqual([
      "create_sandbox",
      "exec",
      "expose_port",
      "get_sandbox",
      "get_task",
      "list_toolboxes",
      "manage_prebuilds",
      "manage_process",
      "manage_task",
      "manage_toolbox",
      "patch_files",
      "sandbox_lifecycle",
      "send_prompt",
      "whoami",
    ]);
  });
});
