# @atelier/console

The Atelier v2 GUI — the primary product surface over `@atelier/server`.
React 19 + rolldown-vite + TanStack Router/Query + Tailwind v4 + shadcn/Radix +
xterm, typed end-to-end against the server's exported `App` type via Eden Treaty.

## Develop

```sh
# from the repo root, start the v2 server in mock mode (listens on :4000)
cd apps/server && ATELIER_SERVER_MODE=mock bun run src/index.ts

# in another shell, start the console (Vite on :5174, proxies /v1 /api
# /sessions /auth /health /mcp to :4000 with ws upgrade)
cd apps/console && bun run dev
```

## Build

```sh
bun run build      # tsgo --noEmit && vite build → dist/ (static)
```

## Surfaces

- `/` — sandbox fleet (status, harness, lifecycle actions)
- `/sandboxes/$id` — detail (urls, processes, logs, ports, read-only attach)
- `/sandboxes/$id/sessions` — live ACP sessions, todos, permissions, terminals
- `/spawn` — saved specs, compose presets, JSONC spec editor
- `/settings/*` — operator console (api-keys, ssh-keys, secrets, orgs, policy, catalog)

## Tauri readiness

The static build wraps unchanged in a Tauri webview. Every server call —
Eden fetch, WebSocket attach, SSE `EventSource`, and the OAuth full-page nav —
resolves through a single origin in `src/lib/api-base.ts`:

```
apiBase = import.meta.env.VITE_API_BASE || window.location.origin
```

Same-origin by default (dev proxy / deployed static build); set
`VITE_API_BASE=https://your-server` at build time to point a custom-scheme
webview at a separate HTTP server. Cross-origin SSE/WS automatically send the
auth cookie (`withCredentials`).

**Server-side prerequisites for the cross-origin (Tauri) path** — not needed
for the same-origin web build:

1. CORS on the server must allow the webview origin specifically
   (`Access-Control-Allow-Origin: <scheme>://…` + `Access-Control-Allow-Credentials: true`)
   for the SSE and WebSocket upgrade endpoints.
2. The GitHub OAuth callback URL must redirect back to the app's custom scheme.
