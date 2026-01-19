# Dashboard

React web interface for sandbox management. Deployed as static files.

## Stack

- **React 19** + **Vite** - Build & dev server
- **TanStack Router** - File-based routing with type safety
- **TanStack Query** - Server state management
- **shadcn/ui** - Component library (Tailwind + Radix)
- **Elysia Eden Treaty** - Type-safe API client

## API Client

```typescript
// src/api/client.ts
import { treaty } from "@elysiajs/eden";
import type { App as ManagerApp } from "@frak-sandbox/manager";

export const api = treaty<ManagerApp>(API_HOST);
// Fully typed - autocomplete + type checking for all endpoints
```

## Route Structure

```
routes/
├── __root.tsx              # Layout with sidebar navigation
├── index.tsx               # Dashboard overview
├── sandboxes/
│   ├── index.tsx           # Sandbox list
│   └── $id.tsx             # Sandbox detail
├── workspaces/
│   ├── index.tsx           # Workspace list
│   └── $id.tsx             # Workspace detail + prebuild trigger
├── images/
│   └── index.tsx           # Base images
└── system/
    └── index.tsx           # System stats, queue, cleanup
```

## Conventions

- **File-based routing** - TanStack Router auto-generates routes
- **Query hooks** - API calls via TanStack Query (in `src/api/queries.ts`)
- **Component co-location** - Dialog components live in `src/components/`
- **shadcn/ui imports** - Components in `src/components/ui/`
- **No prop drilling** - Use TanStack Query for server state
- **Optimistic updates** - For stop/start/delete actions

## Where to Look

| Task | File |
|------|------|
| Add new route | `src/routes/{name}.tsx` (auto-discovered) |
| API endpoints | `src/api/client.ts` |
| Query hooks | `src/api/queries.ts` |
| Create dialogs | `src/components/*-dialog.tsx` |
| UI components | `src/components/ui/*.tsx` |

## Key Components

| Component | Purpose |
|-----------|---------|
| `CreateSandboxDialog` | Spawn sandbox from image or workspace |
| `CreateWorkspaceDialog` | Create new workspace with git URL |
| `EditWorkspaceDialog` | Edit workspace config, commands, secrets |
| `RepositoryPicker` | GitHub repository selector (OAuth) |

## Build & Deploy

```bash
bun run build              # → dist/
# Static files served by Caddy at sandbox-dash.nivelais.com
```

## See Also

- [Manager Routes](../manager/src/modules/AGENTS.md) - Backend API structure
- [Infrastructure](../../docs/infrastructure.md) - Domains, deployment
