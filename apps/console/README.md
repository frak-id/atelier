# @atelier/console

The Atelier web GUI, the main product surface over `@atelier/server`.
React 19, Vite, TanStack Router and Query, Tailwind v4, shadcn/Radix and
xterm, typed end to end against the server's exported `App` type through Eden
Treaty.

## Develop

```sh
# from the repo root: server in local mode with the Docker backend (:4000)
bun run --filter @atelier/server dev

# in another shell: Vite on :5174, proxying the server paths (with WebSocket
# upgrade) to :4000
bun run --filter @atelier/console dev
```

The server needs a running Docker daemon. The proxied paths are listed in
`PROXY_PATHS` in `vite.config.ts`. `infra/nginx/console.conf` holds the
production copy, and the two lists must stay in sync.

## Build

```sh
bun run --filter @atelier/console build   # tsc --noEmit && vite build -> dist/
```

`vite build` also regenerates `src/routeTree.gen.ts`. Do not edit that file by
hand.

## Container

The multi-target `Dockerfile` at the repo root builds both images:

```sh
docker build --target server  -t atelier-server  .
docker build --target console -t atelier-console .
```

- **server**: `apps/server` bundled into one Bun file, migrations applied at
  boot (`MIGRATIONS_DIR`), base-image seeds baked in (`ATELIER_SEEDS_DIR`),
  SQLite under `DATA_DIR` (mount a volume). Listens on `:4000`.
- **console**: this SPA served by nginx (`infra/nginx/console.conf`), which
  reverse-proxies the server paths to `localhost:4000`. The same origin keeps
  the auth cookie and WS/SSE free of CORS. Run both containers in one pod, or
  with host networking as `docker-compose.local.yml` does.

## Surfaces

| Route | Content |
|-------|---------|
| `/` | Task inbox (needs review, running, failed, seen) above the sandbox list |
| `/sandboxes/$id` | Action-first detail: terminal, harness URL, sessions, pause or resume, keep awake, fork, snapshot, destroy; processes, logs, urls, ports, "booted from" |
| `/sandboxes/$id/sessions` | Live ACP sessions, todos, tasks and terminals |
| `/spawn` | Repo card with recents, toolbox picker, org picker, advanced spec editor |
| `/library/*` | Prebuilds, toolboxes and toolsets, images (building is admin only) |
| `/jobs` | The job feed with logs and cancel |
| `/settings/*` | API keys, SSH keys, secrets, config, organizations, users |

Settings > Config groups keys into "Editable" and "Set by deployment
(read-only)". Actions that need a server admin are hidden from other users
(`hooks/use-is-admin.ts`, from `GET /auth/me`).
