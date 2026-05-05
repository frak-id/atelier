# MCP Server

Model Context Protocol server exposing sandbox/task/workspace operations to AI agents. Mounted at `/mcp` on the Manager API.

## Structure

```
mcp/
├── index.ts        # Elysia route mounting MCP transport
├── tools/          # Tool definitions (one file per domain)
└── adapters/       # Internal adapters bridging tools → services
```

## Auth

Bearer token via `server.mcpToken` config. Requests without `Authorization: Bearer <token>` are rejected.

## Adding A Tool

1. Define schema + handler in `tools/<domain>.ts`
2. Import services from `../container.ts` (never from `modules/`)
3. Register in the tools barrel — auto-discovered by the MCP server

## Conventions

- **Read-only by default**: mutating tools must validate the bearer token has elevated scope
- **Return JSON-serializable shapes**: no `Date` objects, no class instances — use ISO strings + plain objects
- **Errors as MCP errors**: throw `McpError` with appropriate code; never leak `SandboxError` directly

## Anti-Patterns

- **DO NOT** import services directly from `modules/` — go through `container.ts`
- **DO NOT** expose internal IDs without an `origin` lookup path — agents should use `originSource` + `originExternalId`
