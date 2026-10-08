/**
 * Shared harness for MCP tool tests: a real MCP client/server pair over the
 * in-memory transport, so arguments go through the same zod validation and
 * results through the same `text()` serialization a real client sees.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolResult {
  isError: boolean;
  /** The parsed JSON payload. */
  data: // biome-ignore lint/suspicious/noExplicitAny: tests poke at arbitrary shapes
  any;
  /** The payload exactly as the client receives it. */
  raw: string;
}

export async function connectMcp(register: (server: McpServer) => void) {
  const server = new McpServer({ name: "test", version: "0" });
  register(server);
  const client = new Client({ name: "test-client", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    async call(
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<ToolResult> {
      const result = await client.callTool({ name, arguments: args });
      const [block] = result.content as { type: string; text: string }[];
      const raw = block?.text ?? "";
      return {
        isError: result.isError === true,
        data: JSON.parse(raw || "null"),
        raw,
      };
    },
    async toolNames(): Promise<string[]> {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name).sort();
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
