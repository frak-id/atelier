# Dashboard

React 19 web interface for sandbox management. Deployed as static files via Caddy.

## Stack

React 19, Vite, TanStack Router (file-based), TanStack Query, shadcn/ui, Elysia Eden Treaty (type-safe API client).

## Conventions

- Routes auto-discovered in `src/routes/` — TanStack Router generates `routeTree.gen.ts`
- API queries organized per-domain in `src/api/queries/` (sandbox, workspace, task, platform)
- Type-safe API client generated from Manager's Elysia types via Eden Treaty
- shadcn/ui components live in `src/components/ui/`
- Use TanStack Query for server state — no prop drilling
- Optimistic updates for stop/start/delete actions
