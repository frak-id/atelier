# Dashboard UX Refactor - Learnings

Conventions, patterns, and wisdom accumulated during execution.

---

## Task Drawer Implementation
- Created `TaskDrawer` component using shadcn `Sheet`.
- Reused `TaskSessionHierarchy` and `ExpandableInterventions` to maintain consistency with the detail page.
- Utilized `TodoProgressBar` with flattened todos from `sessionInteractions` to show overall progress.
- Handled `useTaskSessionProgress` hook requirements by passing a fallback object and controlling the `enabled` flag, as it expects a non-null Task object which `useQuery` doesn't guarantee during loading.

## Sidebar Refactor
- Shadcn `Collapsible` component is useful for organizing less frequently used nav items (like Admin).
- `NavLink` component extension with `badge` prop allows for clean attention counting integration.
- `useAttentionCount` hook aggregates data from multiple queries (sessions, permissions, questions, statuses) across all running sandboxes. Using `useQueries` with `flatMap` is the correct pattern here.
- TanStack Router's `createRootRouteWithContext` allows injecting query client, which is useful for data fetching in layout.

## Sandbox Card Grid Implementation
- Refactored `SandboxesPage` from list/table to responsive grid layout (`grid-cols-1 md:grid-cols-2 xl:grid-cols-3`).
- Extracted `SandboxCard` to a standalone component to handle complexity (tool icons, dev commands, actions).
- Implemented clickable card body using `div role="button"` to allow nested interactive elements (tool icon buttons) without DOM nesting violations. Used `e.stopPropagation()` on inner interactive elements.
- Integrated `SandboxDrawer` controlled by page-level state (`selectedSandboxId`).
- Added `SandboxDevStatus` sub-component to fetch and display running dev command indicators directly on the card using `sandboxDevCommandsQuery`.
