# @atelier/console

The Atelier web GUI — the primary product surface over `@atelier/server`.
React 19 + rolldown-vite + TanStack Router/Query + Tailwind v4 + shadcn/Radix +
xterm, typed end-to-end against the server's exported `App` type via Eden Treaty.

## Develop

```sh
# from the repo root, start the server in mock mode (listens on :4000)
cd apps/server && ATELIER_SERVER_MODE=mock bun run src/index.ts

# in another shell, start the console (Vite on :5174, proxies /v1 /api
# /sessions /auth /health /mcp to :4000 with ws upgrade)
cd apps/console && bun run dev
```

## Build

```sh
bun run build      # tsc --noEmit && vite build → dist/ (static)
```

## Container

The multi-target `Dockerfile` at the repo root builds both images:

```sh
docker build --target server  -t atelier-server  .
docker build --target console -t atelier-console .
```

- **server** — `apps/server` bundled to a single Bun file, drizzle migrations
  applied at boot (`MIGRATIONS_DIR`), base-image seeds baked in
  (`ATELIER_SEEDS_DIR`), SQLite under `DATA_DIR` (mount a PVC). Listens `:4000`.
- **console** — this SPA served by nginx (`infra/nginx/console.conf`), which
  reverse-proxies `/v1 /api /sessions /auth /health /mcp /swagger` to the
  server on `localhost:4000` — same origin, so the auth cookie and WS/SSE work
  with no CORS. Run the server + console as two containers in one pod.

## Surfaces

- `/` — sandbox fleet (status, harness, lifecycle actions)
- `/sandboxes/$id` — detail (urls, processes, logs, ports, read-only attach)
- `/sandboxes/$id/sessions` — live ACP sessions, todos, permissions, terminals
- `/spawn` — saved specs, compose presets, JSONC spec editor
- `/settings/*` — operator console (api-keys, ssh-keys, secrets, orgs, policy, catalog)

