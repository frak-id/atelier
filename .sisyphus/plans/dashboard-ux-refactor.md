# Dashboard UX Refactor: Mission Control Redesign

## TL;DR

> **Quick Summary**: Full UX refactor of the React dashboard. Transform the home page into a real-time Mission Control, replace sandbox and task detail pages with slide-out drawers, add attention badge system to sidebar, surface tool access (VSCode/terminal/OpenCode) everywhere as one-click icons, and move config pages under a collapsed Admin section.
> 
> **Deliverables**:
> - Mission Control home page (real-time attention items, running tasks, active sandboxes, dev commands)
> - Sandbox drawer (replaces `/sandboxes/$id` route)
> - Task drawer (replaces `/tasks/$id` route)
> - Sandbox card grid (replaces sandbox list/table)
> - Sidebar restructure (attention badge on Tasks, collapsed Admin section)
> - Task board list/kanban toggle
> - Route cleanup (delete removed pages, update all references)
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: Sidebar badge → Sandbox drawer → Mission Control → Route cleanup

---

## Context

### Original Request
Full UX refactor of the dashboard. Keep the left navbar but rethink every page's content, UX flow, and developer experience. Core principles: fewer clicks, no back-and-forth navigation, real-time awareness, one-click tool access, config collapsed by default.

### Interview Summary
**Key Discussions**:
- Home page becomes **Mission Control**: real-time feed with attention items, running tasks, active sandboxes, dev commands
- Sandbox detail page (998 lines, 6 tabs) **replaced by drawer**: essential info on top, scrollable exec/repos below
- Task detail page (496 lines) **also replaced by drawer**: session hierarchy, progress, interventions
- **Attention system**: Badge count on Tasks nav when sessions need input/permissions/questions
- **Tool access**: VSCode/terminal/OpenCode icon buttons directly on every sandbox card — one click opens
- **Dev commands**: Running ones visible on Mission Control with URLs, full management in sandbox drawer
- **Task board**: Both kanban + list view with toggle, default to list
- **Config collapsed**: Workspaces, Settings, Images, System under collapsed Admin section
- **Attention response**: Deep-link to OpenCode web UI only, no inline response forms
- **Keyboard shortcuts**: Nice-to-have, not in scope for this iteration
- **Testing**: Manual QA only

**Research Findings**:
- Stack: React 19, TanStack Router (file-based), TanStack Query, shadcn/ui + Tailwind, Elysia Eden Treaty
- Existing Sheet component at `src/components/ui/sheet.tsx` — use for drawers with `side="right"`
- SSE via OpenCode SDK for real-time session events (subscriptions managed by `OpencodeEventsProvider`)
- `useAllOpenCodeSessions()` hook exists for global session data
- `aggregateInteractions()` in `opencode-helpers.ts` already computes `needsAttention`, `pendingPermissions`, `pendingQuestions`
- Existing `NavLink` component in `__root.tsx` needs badge support extension

### Metis Review
**Identified Gaps** (addressed):
- Task detail page fate → Becomes drawer (user confirmed)
- Sandbox drawer feature triage → Essential on top, scrollable with exec/repos below, config extraction and resource resize cut
- Inline response vs deep-link → Deep-link only (user confirmed)
- Workspaces nav position → Move to Admin as discussed (user confirmed)
- Drawer width/behavior → Default applied: use shadcn Sheet `side="right"` with `w-[700px]` or similar wide variant
- Empty states on Mission Control → Default applied: show "Start Working" CTA when no sandboxes/tasks exist
- Mobile responsiveness → Explicitly out of scope for this iteration

---

## Work Objectives

### Core Objective
Transform the dashboard from a page-navigation-heavy architecture into an action-oriented Mission Control with drawer-based detail views, real-time attention awareness, and one-click tool access everywhere.

### Concrete Deliverables
- New Mission Control page component at `src/routes/index.tsx`
- New `SandboxDrawer` component using shadcn Sheet
- New `TaskDrawer` component using shadcn Sheet
- New `SandboxCard` component with status + tool icon buttons
- Updated sidebar with attention badge and collapsed Admin section
- Task list view + kanban toggle on `/tasks`
- Deleted routes: `src/routes/sandboxes/$id.tsx`, `src/routes/tasks/$id.tsx`
- All internal links updated from page navigation to drawer-open actions

### Definition of Done
- [ ] Home page shows real-time attention items, running tasks, active sandboxes with tool buttons
- [ ] Clicking a sandbox card anywhere opens the sandbox drawer (not a page navigation)
- [ ] Clicking a task anywhere opens the task drawer (not a page navigation)
- [ ] Tasks sidebar nav shows badge count when sessions need attention
- [ ] Admin section (Workspaces, Settings, Images, System) is collapsed in sidebar
- [ ] Task board has list/kanban toggle (default list)
- [ ] No dead links to removed routes (`/sandboxes/$id`, `/tasks/$id`)
- [ ] `bun run check` passes (Biome lint + format)
- [ ] `bun run typecheck` passes (TypeScript)

### Must Have
- One-click tool access (VSCode, terminal, OpenCode) on every sandbox representation
- Real-time attention badge in sidebar
- Drawer-based sandbox and task detail (no page navigation)
- Mission Control with attention items at top priority
- Running dev commands visible on Mission Control with URLs

### Must NOT Have (Guardrails)
- **No inline permission/question response UI** — deep-link to OpenCode web URL only
- **No new API endpoints** — use existing 78 query/mutation hooks only
- **No changes to `queries.ts`** — zero modifications to the API layer
- **No changes to SSE architecture** — existing `OpencodeEventsProvider` and polling intervals stay as-is
- **No mobile optimization** — defer to separate iteration
- **No custom animations** — use default shadcn Sheet transitions only
- **No command palette / keyboard shortcuts** — deferred to future iteration
- **No changes to Admin page content** (Images, System, Settings) — only move them in nav
- **No historical activity feed** — Mission Control shows current state only, not historical events

---

## Verification Strategy (MANDATORY)

### Test Decision
- **Infrastructure exists**: YES (Biome lint, TypeScript checking)
- **User wants tests**: NO — Manual QA only
- **Framework**: N/A
- **QA approach**: `bun run check` + `bun run typecheck` + visual verification via Playwright browser

### Automated Verification

Each TODO includes verification via:
- `bun run typecheck` — ensures type safety after route changes
- `bun run check` — ensures lint/format compliance
- Playwright browser automation — visual verification of rendered components

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — Foundation):
├── Task 1: Sidebar restructure (badge + nav reorg)
├── Task 2: SandboxDrawer component
└── Task 3: TaskDrawer component

Wave 2 (After Wave 1 — Page Transforms):
├── Task 4: Sandbox card grid page (depends: 2)
├── Task 5: Mission Control home page (depends: 1, 2, 3)
└── Task 6: Task board list/kanban toggle

Wave 3 (After Wave 2 — Cleanup):
└── Task 7: Route cleanup + dead link removal (depends: 4, 5)

Critical Path: Task 1 → Task 5 → Task 7
Parallel Speedup: ~40% faster than sequential
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 (Sidebar) | None | 5 | 2, 3 |
| 2 (SandboxDrawer) | None | 4, 5 | 1, 3 |
| 3 (TaskDrawer) | None | 5 | 1, 2 |
| 4 (Sandbox cards) | 2 | 7 | 5, 6 |
| 5 (Mission Control) | 1, 2, 3 | 7 | 4, 6 |
| 6 (Task toggle) | None | 7 | 4, 5 |
| 7 (Route cleanup) | 4, 5 | None | None (final) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1, 2, 3 | 3x `delegate_task(category="visual-engineering", load_skills=["frontend-ui-ux"], run_in_background=true)` |
| 2 | 4, 5, 6 | 3x `delegate_task(category="visual-engineering", load_skills=["frontend-ui-ux"], run_in_background=true)` |
| 3 | 7 | 1x `delegate_task(category="quick", load_skills=["frontend-ui-ux"], run_in_background=false)` |

---

## TODOs

- [ ] 1. Sidebar Restructure: Attention Badge + Collapsed Admin Section

  **What to do**:
  - Extend the `NavLink` component in `__root.tsx` to accept an optional `badge?: number` prop that renders a shadcn `Badge` (variant="destructive", small) next to the nav label
  - Create a new hook `useAttentionCount()` that:
    - Uses `useAllOpenCodeSessions()` to get all sessions across all running sandboxes
    - For each sandbox with OpenCode, calls the existing aggregation logic from `opencode-helpers.ts` (`aggregateInteractions`) 
    - Returns total count of `pendingPermissions + pendingQuestions` across all sandboxes
  - Wire `useAttentionCount()` to the Tasks `NavLink` badge prop
  - Restructure sidebar navigation in `__root.tsx`:
    - **Main section**: Home, Tasks (with badge), Sandboxes
    - **Admin section** (collapsed by default using shadcn Collapsible): Workspaces, Images, System, Settings
    - The collapsible Admin section already has a pattern in `__root.tsx` — extend it to include Workspaces
  - Keep the existing GitHub status display and sign-out button at the bottom

  **Must NOT do**:
  - Do NOT change any routing — only nav link structure and visual hierarchy
  - Do NOT modify `OpencodeEventsProvider` or SSE subscription logic
  - Do NOT add new query hooks to `queries.ts` — the `useAttentionCount` hook composes existing hooks
  - Do NOT change the sidebar width or layout mechanism

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Sidebar restructuring involves visual hierarchy and component composition
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: UI component modification, badge styling, nav hierarchy patterns

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Task 5 (Mission Control needs badge hook working)
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/routes/__root.tsx:220-239` — Current `NavLink` component implementation. Extend with optional `badge` prop.
  - `apps/dashboard/src/routes/__root.tsx:124-189` — Mobile Sheet nav — update structure to match desktop changes
  - `apps/dashboard/src/routes/__root.tsx:191-218` — Desktop sidebar nav — the section to restructure with collapsed Admin group
  - `apps/dashboard/src/routes/__root.tsx:87-121` — Admin section already uses Collapsible — extend to include Workspaces

  **API/Type References**:
  - `apps/dashboard/src/hooks/use-all-opencode-sessions.ts` — Hook that fetches all OpenCode sessions across sandboxes. Returns sessions grouped by sandbox.
  - `apps/dashboard/src/lib/opencode-helpers.ts` — Contains `aggregateInteractions()` which computes `pendingPermissions`, `pendingQuestions`, `needsAttention` from session data.
  - `apps/dashboard/src/hooks/use-opencode-data.ts` — Per-sandbox OpenCode data hook. Use as reference for how attention data is computed.

  **UI References**:
  - `apps/dashboard/src/components/ui/badge.tsx` — shadcn Badge component for rendering the count badge
  - `apps/dashboard/src/components/ui/collapsible.tsx` — shadcn Collapsible for Admin section

  **WHY Each Reference Matters**:
  - `__root.tsx:220-239`: This is the exact component to extend. It renders `NavLink` with icon + label. Add badge rendering after label.
  - `use-all-opencode-sessions.ts`: This is the data source for the global attention count. It already fetches across all sandboxes.
  - `opencode-helpers.ts`: Has the logic to categorize interventions into permissions/questions. Don't reinvent — compose.
  - `__root.tsx:87-121`: Existing Admin collapsible section pattern. Workspaces nav just needs to move inside this group.

  **Acceptance Criteria**:

  ```bash
  # Type check passes with new badge prop
  bun run typecheck
  # Expected: no errors

  # Lint + format passes
  bun run check
  # Expected: no errors
  ```

  **Playwright verification**:
  ```
  1. Navigate to: http://localhost:5173
  2. Assert: Sidebar shows "Home", "Tasks", "Sandboxes" as main nav items
  3. Assert: "Admin" or "Config" collapsible section exists below main nav
  4. Click: Admin section toggle
  5. Assert: Expanded section shows "Workspaces", "Images", "System", "Settings"
  6. Assert: If running sandboxes have pending permissions/questions, Tasks nav shows a numeric badge
  7. Screenshot: .sisyphus/evidence/task-1-sidebar.png
  ```

  **Commit**: YES
  - Message: `refactor(dashboard): restructure sidebar with attention badge and collapsed admin section`
  - Files: `apps/dashboard/src/routes/__root.tsx`, `apps/dashboard/src/hooks/use-attention-count.ts`
  - Pre-commit: `bun run typecheck && bun run check`

---

- [ ] 2. SandboxDrawer Component

  **What to do**:
  - Create `apps/dashboard/src/components/sandbox-drawer.tsx` — a slide-out panel using shadcn `Sheet` (`side="right"`) that displays sandbox details
  - The drawer accepts a `sandboxId: string | null` prop (null = closed) and an `onClose` callback
  - **Top section** (always visible, no scrolling needed):
    - Sandbox name/ID, status badge, workspace name
    - Tool icon buttons row: VSCode, Terminal, OpenCode, SSH — each opens `sandbox.runtime.urls.*` in new tab. Use `lucide-react` icons (Monitor, Terminal, Bot, Key). Only show when sandbox is running.
    - Dev commands section: list each dev command with name, status (running/stopped), start/stop button, and URL link if running. Use `useStartDevCommand` and `useStopDevCommand` mutations.
    - Services list: name, port, status indicator
  - **Scrollable section** (below fold):
    - Repos tab content: git status per repo (branch, changes), using `sandboxGitStatusQuery`
    - Exec section: command input + execute button + output display, using `useExecCommand` mutation
  - **Excluded from drawer** (cut features):
    - Config extraction tab
    - Resource resize (disk expansion)
    - Sandbox stop/start/restart/delete (keep these on the card or Mission Control only)
  - Use existing query hooks: `sandboxDetailQuery(id)`, `sandboxServicesQuery(id)`, `sandboxDevCommandsQuery(id)`, `sandboxGitStatusQuery(id)`, `sandboxMetricsQuery(id)`
  - The Sheet should be wide: use className `w-[700px] sm:w-[700px] sm:max-w-none` to override default width

  **Must NOT do**:
  - Do NOT create new query hooks or modify `queries.ts`
  - Do NOT build inline OpenCode session management — just link to OpenCode URL
  - Do NOT add config extraction or resource resize to the drawer
  - Do NOT use custom animations — rely on Sheet's built-in transitions
  - Do NOT duplicate stop/start/delete sandbox buttons in the drawer — those stay on cards/Mission Control

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Complex UI component with multiple sections, responsive layout, and data composition
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Sheet/drawer patterns, component layout, icon integration

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Task 4 (sandbox card grid needs to open this drawer), Task 5 (Mission Control uses it)
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/routes/sandboxes/$id.tsx` — The 998-line page being replaced. Extract the content patterns from here: tool URL buttons (lines ~50-100), dev commands panel, services display, git status display, exec section. This is the SOURCE for what goes into the drawer.
  - `apps/dashboard/src/components/dev-commands-panel.tsx` — Existing dev commands panel component. Reuse or adapt this inside the drawer rather than rebuilding.
  - `apps/dashboard/src/routes/__root.tsx:124-189` — Existing Sheet usage for mobile nav. Follow the same `Sheet`/`SheetContent`/`SheetHeader` pattern.

  **API/Type References**:
  - `apps/dashboard/src/api/queries.ts` — All sandbox-related query hooks: `sandboxDetailQuery`, `sandboxServicesQuery`, `sandboxDevCommandsQuery`, `sandboxGitStatusQuery`, `sandboxMetricsQuery`. Also mutations: `useStartDevCommand`, `useStopDevCommand`, `useExecCommand`.
  - `apps/dashboard/src/api/client.ts` — Exports `Sandbox` type. Use for prop typing.

  **UI References**:
  - `apps/dashboard/src/components/ui/sheet.tsx` — shadcn Sheet component. Use `Sheet`, `SheetContent`, `SheetHeader`, `SheetTitle`, `SheetDescription`.
  - `apps/dashboard/src/components/ui/badge.tsx` — For status badges
  - `apps/dashboard/src/components/ui/tabs.tsx` — If needed for scrollable section organization
  - `apps/dashboard/src/components/ui/scroll-area.tsx` — For scrollable content section

  **WHY Each Reference Matters**:
  - `sandboxes/$id.tsx`: This is the page being decomposed into a drawer. Every section in this file needs to be triaged (keep/cut/adapt). The tool buttons, dev commands display, services list, git status, and exec sections are the content sources.
  - `dev-commands-panel.tsx`: Don't rebuild dev command UI from scratch — this component already handles start/stop/status display. Adapt or reuse.
  - `sheet.tsx`: The Sheet component's API determines how the drawer opens/closes. Use `open` + `onOpenChange` controlled pattern.

  **Acceptance Criteria**:

  ```bash
  bun run typecheck
  # Expected: no errors

  bun run check
  # Expected: no errors
  ```

  **Playwright verification**:
  ```
  1. Navigate to: http://localhost:5173/sandboxes
  2. Assert: Sandbox cards are visible (requires running sandboxes)
  3. Click: A sandbox card
  4. Wait for: Sheet/drawer to slide in from right
  5. Assert: Drawer shows sandbox name, status badge
  6. Assert: Tool icon buttons visible (VSCode, Terminal, OpenCode) — only if sandbox is running
  7. Assert: Dev commands section shows with start/stop buttons
  8. Assert: Services section shows running services
  9. Scroll: Down in drawer
  10. Assert: Repos/git status section visible
  11. Assert: Exec section visible with command input
  12. Click: Outside drawer or press Escape
  13. Assert: Drawer closes
  14. Screenshot: .sisyphus/evidence/task-2-sandbox-drawer.png
  ```

  **Commit**: YES
  - Message: `feat(dashboard): add sandbox drawer component replacing detail page`
  - Files: `apps/dashboard/src/components/sandbox-drawer.tsx`
  - Pre-commit: `bun run typecheck && bun run check`

---

- [ ] 3. TaskDrawer Component

  **What to do**:
  - Create `apps/dashboard/src/components/task-drawer.tsx` — a slide-out panel using shadcn `Sheet` (`side="right"`) that displays task details
  - Accepts `taskId: string | null` (null = closed) and `onClose` callback
  - **Top section**:
    - Task title, status badge (draft/active/done), workspace name
    - If task has a sandbox: tool icon buttons (VSCode, Terminal, OpenCode) — same pattern as SandboxDrawer
    - Action buttons: Start task (`useStartTask`), Complete task (`useCompleteTask`), Reset task (`useResetTask`)
  - **Session hierarchy section**:
    - Reuse or adapt the existing `TaskSessionHierarchy` component from `src/components/task-session-hierarchy.tsx`
    - Show parent/child sessions with status indicators
    - Each session with pending interventions shows an attention indicator
    - "Add session" button using `useAddTaskSessions`
  - **Attention/Interventions section**:
    - Reuse or adapt `ExpandableInterventions` component
    - Show pending permissions and questions with deep-links to OpenCode web UI
  - **Progress section**:
    - Reuse `TodoProgressBar` component for session todo progress
    - Reuse `ExpandableTodoList` for detailed todo items
  - Use existing query hooks: `taskDetailQuery(id)`, plus OpenCode session queries for the task's sandbox
  - Wide drawer: `w-[700px] sm:w-[700px] sm:max-w-none`

  **Must NOT do**:
  - Do NOT build inline permission/question response forms — deep-link to OpenCode URL only
  - Do NOT create new query hooks or modify `queries.ts`
  - Do NOT rebuild session hierarchy from scratch — reuse existing components
  - Do NOT add task deletion to the drawer — keep on kanban/list only

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Complex component composing multiple existing sub-components with data hooks
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Drawer layout, component composition, intervention display patterns

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Task 5 (Mission Control uses task drawer)
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/routes/tasks/$id.tsx` — The 496-line task detail page being replaced. Extract: task header with status/actions, session hierarchy, interventions, progress display. This is the SOURCE for drawer content.
  - `apps/dashboard/src/components/task-session-hierarchy.tsx` — Session hierarchy component. Reuse inside the drawer.
  - `apps/dashboard/src/components/expandable-interventions.tsx` — Intervention display. Reuse inside the drawer.
  - `apps/dashboard/src/components/expandable-todo-list.tsx` — Todo list display. Reuse inside the drawer.
  - `apps/dashboard/src/components/todo-progress-bar.tsx` — Progress bar. Reuse.
  - `apps/dashboard/src/components/session-status-indicator.tsx` — Session status display. Reuse.

  **API/Type References**:
  - `apps/dashboard/src/api/queries.ts` — `taskDetailQuery(id)`, `useStartTask`, `useCompleteTask`, `useResetTask`, `useAddTaskSessions`
  - `apps/dashboard/src/hooks/use-task-session-progress.ts` — Hook for tracking task session progress. Reuse.

  **UI References**:
  - `apps/dashboard/src/components/ui/sheet.tsx` — Same Sheet pattern as SandboxDrawer
  - `apps/dashboard/src/components/ui/badge.tsx` — Task status badges
  - `apps/dashboard/src/components/ui/scroll-area.tsx` — For scrollable content

  **WHY Each Reference Matters**:
  - `tasks/$id.tsx`: The page being decomposed. Lines 1-100 contain the header with task actions and sandbox tool buttons. Lines 100-300 contain session hierarchy and progress. Lines 300-496 contain interventions and secondary session spawning.
  - `task-session-hierarchy.tsx`: Don't rebuild — this is already a self-contained component that renders the session tree. Just embed it.
  - `expandable-interventions.tsx`: Already handles permission/question display with deep-links. Embed directly.
  - `use-task-session-progress.ts`: Already computes progress metrics. Compose with drawer.

  **Acceptance Criteria**:

  ```bash
  bun run typecheck
  bun run check
  # Expected: no errors for both
  ```

  **Playwright verification**:
  ```
  1. Navigate to: http://localhost:5173/tasks
  2. Assert: Task list/board is visible
  3. Click: A task card/row
  4. Wait for: Sheet/drawer to slide in from right
  5. Assert: Drawer shows task title, status badge, workspace name
  6. Assert: If task has sandbox, tool buttons visible
  7. Assert: Session hierarchy section visible
  8. Assert: Interventions section visible (if any)
  9. Assert: Todo progress visible (if sessions exist)
  10. Click: Outside drawer or press Escape
  11. Assert: Drawer closes
  12. Screenshot: .sisyphus/evidence/task-3-task-drawer.png
  ```

  **Commit**: YES
  - Message: `feat(dashboard): add task drawer component replacing detail page`
  - Files: `apps/dashboard/src/components/task-drawer.tsx`
  - Pre-commit: `bun run typecheck && bun run check`

---

- [ ] 4. Sandbox Card Grid Page

  **What to do**:
  - Rewrite `apps/dashboard/src/routes/sandboxes/index.tsx` to display sandboxes as a card grid instead of the current list/table
  - Each `SandboxCard` component shows:
    - Sandbox ID/name, workspace name (from `useWorkspaceMap()`), status badge (color-coded: green=running, red=error, gray=stopped, yellow=creating)
    - **Tool icon buttons row**: VSCode, Terminal, OpenCode — each opens `sandbox.runtime.urls.*` in new tab. Only visible when `status === "running"`.
    - Dev command status indicators: show running dev command names with links to their URLs
    - Quick action buttons: Stop/Start/Restart (depending on current status), Delete (with confirmation)
    - Created at timestamp, resource info (vCPUs, memory)
  - Responsive grid: `grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4`
  - Keep existing filter controls (status filter, workspace filter) at top
  - Keep existing "Create Sandbox" button
  - **Clicking the card body** (not an action button) opens the `SandboxDrawer` from Task 2
  - Manage drawer state: `const [selectedSandboxId, setSelectedSandboxId] = useState<string | null>(null)`
  - Render `<SandboxDrawer sandboxId={selectedSandboxId} onClose={() => setSelectedSandboxId(null)} />` at page level

  **Must NOT do**:
  - Do NOT navigate to `/sandboxes/$id` on card click — open the drawer instead
  - Do NOT add config extraction, resource resize, or any heavy features to the card
  - Do NOT change query hooks or polling intervals
  - Do NOT make cards expandable — all detail goes in the drawer

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Card grid layout, status-driven styling, responsive design
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Card component design, grid layouts, status indicators, responsive patterns

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6)
  - **Blocks**: Task 7 (route cleanup needs this done)
  - **Blocked By**: Task 2 (SandboxDrawer must exist to import)

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/routes/sandboxes/index.tsx` — Current sandbox list page. This file gets rewritten. Keep the filter bar, create button, and data fetching patterns. Replace the list rendering with card grid.
  - `apps/dashboard/src/components/sandbox-row.tsx` — Current sandbox row component. Use as reference for what data to display on cards, then replace with card layout.
  - `apps/dashboard/src/components/running-sandboxes-card.tsx` — Existing card-style sandbox display on home page. Reference for card layout patterns.

  **API/Type References**:
  - `apps/dashboard/src/api/queries.ts` — `sandboxListQuery()`, `useStopSandbox`, `useStartSandbox`, `useRestartSandbox`, `useDeleteSandbox`
  - `apps/dashboard/src/api/client.ts` — `Sandbox` type for card prop typing
  - `apps/dashboard/src/api/queries.ts` — `useWorkspaceMap()` for workspace name display

  **UI References**:
  - `apps/dashboard/src/components/ui/card.tsx` — shadcn Card for card layout
  - `apps/dashboard/src/components/ui/badge.tsx` — Status badges
  - `apps/dashboard/src/components/ui/tooltip.tsx` — Tooltips on icon buttons

  **WHY Each Reference Matters**:
  - `sandboxes/index.tsx`: The file being rewritten. Preserve the data fetching, filter logic, and create dialog trigger. Only change the rendering.
  - `sandbox-row.tsx`: Shows what fields are currently displayed per sandbox. Transfer to card layout.
  - `running-sandboxes-card.tsx`: Already renders sandbox info in a card-like format on the home page. Use as design reference.

  **Acceptance Criteria**:

  ```bash
  bun run typecheck
  bun run check
  # Expected: no errors
  ```

  **Playwright verification**:
  ```
  1. Navigate to: http://localhost:5173/sandboxes
  2. Assert: Cards displayed in grid layout (not table/list)
  3. Assert: Each card shows sandbox ID, workspace name, status badge
  4. Assert: Running sandbox cards show VSCode/Terminal/OpenCode icon buttons
  5. Assert: Stopped sandbox cards do NOT show tool icon buttons
  6. Assert: Filter bar at top still works (status filter)
  7. Assert: "Create Sandbox" button still visible and functional
  8. Click: A sandbox card body
  9. Wait for: Sandbox drawer to open from right
  10. Assert: Drawer shows matching sandbox details
  11. Screenshot: .sisyphus/evidence/task-4-sandbox-cards.png
  ```

  **Commit**: YES
  - Message: `refactor(dashboard): replace sandbox list with card grid + drawer integration`
  - Files: `apps/dashboard/src/routes/sandboxes/index.tsx`, `apps/dashboard/src/components/sandbox-card.tsx`
  - Pre-commit: `bun run typecheck && bun run check`

---

- [ ] 5. Mission Control Home Page

  **What to do**:
  - Rewrite `apps/dashboard/src/routes/index.tsx` to become the Mission Control
  - **Layout**: Single column, sections stacked vertically with clear visual separation
  - **Section 1 — Attention Required** (top, always visible, even if empty):
    - Header: "Needs Attention" with count badge
    - List of sessions with pending permissions or questions across ALL running sandboxes
    - Each item shows: session ID, sandbox name, type (permission/question), summary text, timestamp
    - Each item has a "View in OpenCode" button that deep-links to `sandbox.runtime.urls.opencode` (opens new tab)
    - If no items: show subtle "All clear" message with checkmark icon
    - Data source: compose `useAllOpenCodeSessions()` with per-sandbox `useOpencodeData()` or adapt the `useAttentionCount` hook from Task 1 to return full attention items (not just count)
  - **Section 2 — Running Tasks**:
    - Header: "Active Tasks" with count
    - Compact list of tasks with `status === "active"`
    - Each shows: title, workspace, progress (todo progress bar), session count, time running
    - Clicking a task opens the `TaskDrawer` from Task 3
    - If no active tasks: "No active tasks" with link to task board
  - **Section 3 — Active Sandboxes**:
    - Header: "Running Sandboxes" with count
    - Card grid of sandboxes with `status === "running"` (reuse `SandboxCard` from Task 4 or a compact variant)
    - Each card: sandbox ID, workspace, tool icon buttons (VSCode/Terminal/OpenCode), dev commands with URLs
    - Clicking a card opens the `SandboxDrawer` from Task 2
    - If no running sandboxes: show "Start Working" CTA (reuse pattern from current `StartWorkingCard`)
  - **Section 4 — Dev Commands** (optional, only if any are running):
    - Running dev commands across all sandboxes with their URLs, sandbox name, and status
    - Quick link to open the dev command URL
  - Manage drawer state for both sandbox and task drawers at this page level
  - Render both `<SandboxDrawer>` and `<TaskDrawer>` at page level

  **Must NOT do**:
  - Do NOT build a historical activity feed/timeline — show current state only
  - Do NOT build inline permission/question response — deep-link to OpenCode URL only
  - Do NOT embed log viewers or dev command output — just show name + status + URL link
  - Do NOT show stopped sandboxes or completed tasks on Mission Control — only active items
  - Do NOT create new API endpoints — compose existing queries

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Complex page composition with multiple data sources, real-time sections, drawer integration
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Dashboard layout, real-time data display, section hierarchy, empty states

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 6)
  - **Blocks**: Task 7 (route cleanup)
  - **Blocked By**: Task 1 (attention hook), Task 2 (SandboxDrawer), Task 3 (TaskDrawer)

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/routes/index.tsx` — Current home page. This file gets rewritten. Reference the current layout patterns and data fetching.
  - `apps/dashboard/src/components/start-working-card.tsx` — Reuse for empty state CTA when no running sandboxes
  - `apps/dashboard/src/components/recent-sessions-card.tsx` — Reference for card layout patterns on home page
  - `apps/dashboard/src/components/running-sandboxes-card.tsx` — Current running sandboxes display. Adapt or replace with card grid.
  - `apps/dashboard/src/components/session-status-indicator.tsx` — Status indicator for sessions. Reuse in attention items.
  - `apps/dashboard/src/components/expandable-interventions.tsx` — Reference for how interventions are displayed. Adapt for attention section.

  **API/Type References**:
  - `apps/dashboard/src/hooks/use-all-opencode-sessions.ts` — Global session data across all sandboxes
  - `apps/dashboard/src/hooks/use-opencode-data.ts` — Per-sandbox OpenCode data with permissions/questions
  - `apps/dashboard/src/lib/opencode-helpers.ts` — `aggregateInteractions()` for attention computation
  - `apps/dashboard/src/api/queries.ts` — `sandboxListQuery()` (filter running), `taskListQuery()` (filter active)
  - `apps/dashboard/src/hooks/use-task-session-progress.ts` — Progress metrics for task display

  **WHY Each Reference Matters**:
  - `index.tsx`: Being rewritten. Keep the `createFileRoute('/')` pattern and Suspense boundaries.
  - `use-all-opencode-sessions.ts`: Core data source for the attention section. Returns sessions grouped by sandbox URL.
  - `opencode-helpers.ts`: `aggregateInteractions()` tells you which sessions need attention and why. Essential for Section 1.
  - `start-working-card.tsx`: Don't rebuild the empty state CTA — reuse this component when no sandboxes exist.

  **Acceptance Criteria**:

  ```bash
  bun run typecheck
  bun run check
  # Expected: no errors
  ```

  **Playwright verification**:
  ```
  1. Navigate to: http://localhost:5173
  2. Assert: "Needs Attention" section visible at top
  3. Assert: If pending permissions/questions exist, they are listed with "View in OpenCode" buttons
  4. Assert: "Active Tasks" section visible with running tasks
  5. Click: A task in the active tasks list
  6. Wait for: Task drawer to open from right
  7. Assert: Task drawer shows correct task details
  8. Close drawer
  9. Assert: "Running Sandboxes" section visible with sandbox cards
  10. Assert: Each sandbox card has tool icon buttons (VSCode, Terminal, OpenCode)
  11. Click: VSCode icon on a sandbox
  12. Assert: New tab opens with VSCode URL
  13. Click: Sandbox card body
  14. Wait for: Sandbox drawer to open from right
  15. Assert: Sandbox drawer shows correct details
  16. Screenshot: .sisyphus/evidence/task-5-mission-control.png
  ```

  **Commit**: YES
  - Message: `feat(dashboard): replace home page with Mission Control dashboard`
  - Files: `apps/dashboard/src/routes/index.tsx`, `apps/dashboard/src/hooks/use-attention-data.ts` (if new hook needed)
  - Pre-commit: `bun run typecheck && bun run check`

---

- [ ] 6. Task Board List/Kanban Toggle

  **What to do**:
  - Modify `apps/dashboard/src/routes/tasks/index.tsx` to add a list view alongside the existing kanban board
  - Add a toggle control at the top: "List" | "Board" (use shadcn Tabs or simple button group)
  - Default to **list view**
  - **List view**:
    - Table/list showing all tasks across all workspaces
    - Columns: Title, Workspace, Status (badge), Session count, Progress (mini bar), Created, Actions
    - Sort by: status (active first), then creation date
    - Clicking a task row opens the `TaskDrawer` from Task 3
    - Quick action buttons per row: Start (if draft), Complete (if active), Delete (with confirmation)
  - **Kanban view**:
    - Keep existing `KanbanBoard` component mostly as-is
    - Clicking a task card opens the `TaskDrawer` instead of navigating to `/tasks/$id`
  - Persist view preference in `localStorage` key `frak_task_view`
  - Manage task drawer state at this page level
  - Render `<TaskDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />`
  - Keep existing workspace filter and task creation button

  **Must NOT do**:
  - Do NOT rewrite the kanban board — keep existing `KanbanBoard`, `KanbanColumn`, `TaskCard` components
  - Do NOT navigate to `/tasks/$id` — open drawer instead
  - Do NOT add complex filtering beyond existing workspace filter
  - Do NOT modify task card drag-and-drop logic

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: View toggle, list component, drawer integration, localStorage persistence
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Table/list patterns, view toggle UX, layout switching

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 5)
  - **Blocks**: Task 7 (route cleanup needs task links updated)
  - **Blocked By**: None (but Task 3 must exist for drawer import; can stub if needed)

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/routes/tasks/index.tsx` — Current task page with kanban. Modify this file to add toggle and list view.
  - `apps/dashboard/src/components/kanban/kanban-board.tsx` — Existing kanban board. Keep as-is, but change task click handler to open drawer.
  - `apps/dashboard/src/components/kanban/task-card.tsx` — Existing task card. Modify click handler from `navigate("/tasks/$id")` to `onTaskClick(taskId)`.
  - `apps/dashboard/src/components/kanban/task-form-dialog.tsx` — Task creation dialog. Keep as-is.

  **API/Type References**:
  - `apps/dashboard/src/api/queries.ts` — `taskListQuery(workspaceId?)`, `useCompleteTask`, `useStartTask`, `useDeleteTask`
  - `apps/dashboard/src/api/queries.ts` — `useWorkspaceMap()` for workspace name display in list

  **WHY Each Reference Matters**:
  - `tasks/index.tsx`: Being modified. Add the toggle + list view around the existing kanban.
  - `task-card.tsx`: Must change the click handler from navigation to drawer-open callback. This is the integration point.
  - `kanban-board.tsx`: Need to pass down `onTaskClick` callback so kanban cards open the drawer instead of navigating.

  **Acceptance Criteria**:

  ```bash
  bun run typecheck
  bun run check
  # Expected: no errors
  ```

  **Playwright verification**:
  ```
  1. Navigate to: http://localhost:5173/tasks
  2. Assert: View toggle visible at top (List / Board)
  3. Assert: Default view is "List"
  4. Assert: List shows tasks with columns: Title, Workspace, Status, Progress
  5. Click: A task row
  6. Wait for: Task drawer to open from right
  7. Assert: Drawer shows correct task details
  8. Close drawer
  9. Click: "Board" toggle
  10. Assert: Kanban board appears (drag-and-drop columns)
  11. Click: A kanban task card
  12. Wait for: Task drawer to open (NOT page navigation)
  13. Assert: Drawer shows correct task details
  14. Reload page
  15. Assert: Previous view preference (Board) is preserved
  16. Screenshot: .sisyphus/evidence/task-6-task-toggle.png
  ```

  **Commit**: YES
  - Message: `feat(dashboard): add list/kanban toggle to task board with drawer integration`
  - Files: `apps/dashboard/src/routes/tasks/index.tsx`, `apps/dashboard/src/components/kanban/task-card.tsx`, `apps/dashboard/src/components/kanban/kanban-board.tsx`
  - Pre-commit: `bun run typecheck && bun run check`

---

- [ ] 7. Route Cleanup: Delete Removed Pages + Update All References

  **What to do**:
  - **Delete** `apps/dashboard/src/routes/sandboxes/$id.tsx` — sandbox detail page replaced by drawer
  - **Delete** `apps/dashboard/src/routes/tasks/$id.tsx` — task detail page replaced by drawer
  - **Find and update ALL references** to these deleted routes across the entire codebase:
    - Use `ast_grep_search` and `grep` to find all `<Link to="/sandboxes/$id"`, `to="/sandboxes/${id}"`, `navigate({ to: '/sandboxes/$id'`, `params: { id:` patterns
    - Same for task routes: `<Link to="/tasks/$id"`, `navigate({ to: '/tasks/$id'`
    - Replace navigations with drawer-open actions (pass `onClick` callbacks that set drawer state)
  - **Specific files to check**:
    - `apps/dashboard/src/components/sandbox-row.tsx` — likely has Link to sandbox detail
    - `apps/dashboard/src/components/running-sandboxes-card.tsx` — likely has Link to sandbox detail
    - `apps/dashboard/src/components/recent-sessions-card.tsx` — may link to tasks or sandboxes
    - `apps/dashboard/src/components/kanban/task-card.tsx` — should already be updated in Task 6
    - `apps/dashboard/src/components/start-working-card.tsx` — may link to sandboxes or tasks
    - Any other component that renders sandbox or task references
  - **Verify no dead links** remain by running `grep -r "sandboxes/\\\$id\|/sandboxes/\${" apps/dashboard/src/` and similar for tasks
  - Run `bun run typecheck` — TanStack Router's type-safe routing will ERROR if any component references a deleted route. This is the primary verification.

  **Must NOT do**:
  - Do NOT delete any component files that are reused in drawers (e.g., `task-session-hierarchy.tsx`, `dev-commands-panel.tsx`)
  - Do NOT delete query hooks that the drawers still consume
  - Do NOT modify the router configuration beyond removing the route files
  - Do NOT leave any `<Link>` pointing to deleted routes — TypeScript WILL catch these

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Search-and-replace task, no complex UI work, just reference cleanup
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Understanding route patterns, Link component usage

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential, final step)
  - **Blocks**: None (final task)
  - **Blocked By**: Task 4 (sandbox card page done), Task 5 (mission control done), Task 6 (task board done)

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/routes/sandboxes/$id.tsx` — File to DELETE
  - `apps/dashboard/src/routes/tasks/$id.tsx` — File to DELETE
  - `apps/dashboard/src/components/sandbox-row.tsx` — Likely contains `<Link to="/sandboxes/$id">` — update to callback
  - `apps/dashboard/src/components/running-sandboxes-card.tsx` — Likely contains sandbox links
  - `apps/dashboard/src/components/recent-sessions-card.tsx` — May contain task/sandbox links
  - `apps/dashboard/src/components/start-working-card.tsx` — May contain sandbox links
  - `apps/dashboard/src/components/kanban/task-card.tsx` — Should be updated in Task 6, verify

  **Tool References**:
  - Use `ast_grep_search` with pattern `<Link to="/sandboxes/$id" $$$>` (TSX) to find all sandbox links
  - Use `ast_grep_search` with pattern `navigate({ to: "/sandboxes/$id", $$$ })` to find programmatic navigation
  - Use `grep` for string patterns: `/sandboxes/$` and `/tasks/$` across all `.tsx` and `.ts` files
  - Use `lsp_find_references` on the deleted route file exports to find all consumers

  **WHY Each Reference Matters**:
  - `sandbox-row.tsx`: This component is used in list views. Its sandbox click handler must change from navigate to callback. The parent component provides the callback to open the drawer.
  - `running-sandboxes-card.tsx`: Used on the home page (now Mission Control). Links must become drawer-open actions.
  - TanStack Router type safety: After deleting route files, `bun run typecheck` will flag every remaining reference. This is the best verification tool.

  **Acceptance Criteria**:

  ```bash
  # Verify deleted routes don't exist
  ls apps/dashboard/src/routes/sandboxes/\$id.tsx 2>&1
  # Expected: No such file

  ls apps/dashboard/src/routes/tasks/\$id.tsx 2>&1
  # Expected: No such file

  # Verify no remaining references to deleted routes
  grep -r "sandboxes/\\\$id\|/sandboxes/\$" apps/dashboard/src/ --include="*.tsx" --include="*.ts"
  # Expected: No output (zero matches)

  grep -r "tasks/\\\$id\|/tasks/\$" apps/dashboard/src/ --include="*.tsx" --include="*.ts"
  # Expected: No output (zero matches) — excluding the tasks/index.tsx route definition itself

  # Type check MUST pass — this catches all dead route references
  bun run typecheck
  # Expected: no errors

  bun run check
  # Expected: no errors
  ```

  **Commit**: YES
  - Message: `refactor(dashboard): remove sandbox and task detail pages, update all references to use drawers`
  - Files: (deleted) `apps/dashboard/src/routes/sandboxes/$id.tsx`, `apps/dashboard/src/routes/tasks/$id.tsx`, (modified) all files with updated links
  - Pre-commit: `bun run typecheck && bun run check`

---

## Commit Strategy

| After Task | Message | Key Files | Verification |
|------------|---------|-----------|-------------|
| 1 | `refactor(dashboard): restructure sidebar with attention badge and collapsed admin section` | `__root.tsx`, `use-attention-count.ts` | `bun run typecheck && bun run check` |
| 2 | `feat(dashboard): add sandbox drawer component replacing detail page` | `sandbox-drawer.tsx` | `bun run typecheck && bun run check` |
| 3 | `feat(dashboard): add task drawer component replacing detail page` | `task-drawer.tsx` | `bun run typecheck && bun run check` |
| 4 | `refactor(dashboard): replace sandbox list with card grid + drawer integration` | `sandboxes/index.tsx`, `sandbox-card.tsx` | `bun run typecheck && bun run check` |
| 5 | `feat(dashboard): replace home page with Mission Control dashboard` | `routes/index.tsx`, `use-attention-data.ts` | `bun run typecheck && bun run check` |
| 6 | `feat(dashboard): add list/kanban toggle to task board with drawer integration` | `tasks/index.tsx`, `task-card.tsx`, `kanban-board.tsx` | `bun run typecheck && bun run check` |
| 7 | `refactor(dashboard): remove sandbox and task detail pages, update all references to use drawers` | delete `$id.tsx` files, update all Link references | `bun run typecheck && bun run check` |

---

## Success Criteria

### Verification Commands
```bash
bun run typecheck   # Expected: 0 errors — catches dead routes, missing props, type mismatches
bun run check       # Expected: 0 errors — Biome lint + format
```

### Final Checklist
- [ ] Home page is Mission Control with attention items, running tasks, active sandboxes
- [ ] Clicking any sandbox anywhere opens a drawer (never navigates to /sandboxes/$id)
- [ ] Clicking any task anywhere opens a drawer (never navigates to /tasks/$id)
- [ ] Tasks sidebar nav shows attention badge count
- [ ] Admin section collapsed with Workspaces, Images, System, Settings
- [ ] Task board has list/kanban toggle, default list
- [ ] Tool icon buttons (VSCode/Terminal/OpenCode) visible on every sandbox card
- [ ] Dev commands visible on Mission Control with URLs
- [ ] Attention items deep-link to OpenCode web UI (no inline response)
- [ ] No dead links to `/sandboxes/$id` or `/tasks/$id`
- [ ] `bun run typecheck` passes
- [ ] `bun run check` passes
- [ ] All "Must NOT Have" guardrails respected
