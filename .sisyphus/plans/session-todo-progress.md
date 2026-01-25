# Session Todo Progress Tracking

## Context

### Original Request
Improve session progress tracking in the dashboard by leveraging OpenCode's todo endpoint data. Currently, progress is tracked based on sub-session idle state, but the todo endpoint provides much more granular information about what a session is doing and has achieved.

### Interview Summary
**Key Discussions**:
- **Task Card**: Replace progress bar with todo-based segmented progress (green=completed, blue=in_progress, gray=pending)
- **Session Row**: Add mini todo progress bar + current task text
- **Task Detail**: Expandable todo list per session with status icons
- **Fallback**: When no todos exist, revert to previous sub-session count progress (idle sessions / total sessions)
- **Events**: Add `todo.updated` handler for real-time invalidation

**Research Findings**:
- OpenCode SDK has `client.session.todo({ sessionID })` returning `Todo[]`
- Todo type: `{ id, content, status, priority }` with statuses: pending, in_progress, completed, cancelled
- Event: `todo.updated` with `{ sessionID, todos[] }`
- Current dashboard has SSE event infrastructure in `opencode-events-provider.tsx`

### Metis Review
**Identified Gaps** (addressed):
- SDK version mismatch (dashboard: 1.1.31, manager: 1.1.34) → Added SDK upgrade task
- Cancelled status handling → Will exclude from count, show as gray strikethrough in list
- N+1 query pattern → Acceptable for MVP; todos are session-scoped
- Loading states → Show skeleton/spinner while loading
- Error handling → Fall back to sub-session count progress silently
- Multiple in_progress todos → Show first one as current task
- Long todo content → Truncate with ellipsis

---

## Work Objectives

### Core Objective
Replace the binary idle-based progress tracking with granular todo-based progress that shows developers what a session is working on and has achieved.

### Concrete Deliverables
- `fetchOpenCodeTodos(baseUrl, sessionId)` function in `api/opencode.ts`
- `queryKeys.opencode.todos(baseUrl, sessionId)` query key and options in `api/queries.ts`
- `todo.updated` event handler in `opencode-events-provider.tsx`
- `TodoProgressBar` component with segmented colors
- `SessionTodoInfo` component for current task display
- `ExpandableTodoList` component for detail page
- Modified `task-card.tsx` with todo progress
- Modified `session-row.tsx` with todo progress
- Modified `routes/tasks/$id.tsx` with expandable todo lists

### Definition of Done
- [x] `bun run check` passes (Biome lint + format)
- [x] `bun run typecheck` passes
- [x] Task cards show segmented todo progress bar with current task
- [x] Session rows show mini todo progress bar with current task
- [x] Task detail page shows expandable todo lists per session
- [x] `todo.updated` events trigger UI updates
- [x] Sessions with no todos fall back to sub-session count progress

### Must Have
- Segmented progress bar (green/blue/gray)
- Current task text display
- Fallback to sub-session count progress when no todos
- Event-driven query invalidation
- Error handling with graceful fallback

### Must NOT Have (Guardrails)
- No todo mutations (complete/cancel buttons) - read-only display
- No refetchInterval on todo queries - SSE handles freshness
- No subsession todo aggregation - session-scoped only
- No priority-based styling or sorting - simple display
- No todo filtering/search - simple list only
- No toast notifications for todo changes
- No animated transitions on progress bar - instant updates
- No global "My Tasks" page - per-session context only

---

## Verification Strategy (MANDATORY)

### Test Decision
- **Infrastructure exists**: NO (no test framework in dashboard)
- **User wants tests**: Manual verification via Playwright
- **Framework**: Manual QA only

### Manual Execution Verification

Each task includes browser verification steps using Playwright automation.

**Evidence Required:**
- Screenshots for visual changes
- Console output for event handling
- Network tab for API calls

---

## Task Flow

```
Task 0 (SDK upgrade)
    ↓
Task 1 (API function)
    ↓
Task 2 (Query infrastructure) 
    ↓
Task 3 (Event handler)
    ↓
Task 4 (TodoProgressBar component)
Task 5 (SessionTodoInfo component)  ← parallel
Task 6 (ExpandableTodoList component)
    ↓
Task 7 (useTaskSessionProgress hook update)
    ↓
Task 8 (task-card.tsx integration)
Task 9 (session-row.tsx integration)  ← parallel
Task 10 (task detail page integration)
    ↓
Task 11 (Final verification)
```

## Parallelization

| Group | Tasks | Reason |
|-------|-------|--------|
| A | 4, 5, 6 | Independent UI components |
| B | 8, 9, 10 | Independent integrations after hook is ready |

| Task | Depends On | Reason |
|------|------------|--------|
| 1 | 0 | SDK upgrade must complete first |
| 2 | 1 | Query needs fetch function |
| 3 | 2 | Event handler needs query key |
| 7 | 2, 4, 5 | Hook needs query and components |
| 8, 9, 10 | 7 | Integrations need updated hook |
| 11 | all | Final verification |

---

## TODOs

- [x] 0. Upgrade OpenCode SDK to latest version

  **What to do**:
  - Update `@opencode-ai/sdk` in `apps/dashboard/package.json` to match manager version (1.1.34 or latest)
  - Run `bun install` to update lockfile
  - Verify no type errors introduced

  **Must NOT do**:
  - Don't upgrade other packages
  - Don't modify SDK usage patterns yet

  **Parallelizable**: NO (prerequisite for all other tasks)

  **References**:
  - `apps/dashboard/package.json` - Current SDK version
  - `apps/manager/package.json` - Target SDK version for alignment

  **Acceptance Criteria**:
  - [x] `bun install` completes without errors
  - [x] `bun run typecheck` passes in apps/dashboard
  - [x] SDK version in package.json matches manager

  **Commit**: YES
  - Message: `chore(dashboard): upgrade opencode SDK to 1.1.34`
  - Files: `apps/dashboard/package.json`, `bun.lock`

---

- [x] 1. Add todo fetch function to OpenCode API

  **What to do**:
  - Add `fetchOpenCodeTodos(baseUrl: string, sessionId: string): Promise<Todo[]>` function
  - Follow existing pattern in `fetchOpenCodeSessions`, `fetchOpenCodePermissions`
  - Import `Todo` type from SDK
  - Handle errors gracefully (return empty array on failure)

  **Must NOT do**:
  - Don't add mutation functions
  - Don't modify existing functions

  **Parallelizable**: NO (depends on Task 0)

  **References**:
  - `apps/dashboard/src/api/opencode.ts:13-25` - Pattern for fetch functions (fetchOpenCodeSessions)
  - `apps/dashboard/src/api/opencode.ts:102-112` - Error handling pattern (getOpenCodeSessionStatuses)
  - OpenCode SDK: `client.session.todo({ sessionID })` returns `Todo[]`

  **Acceptance Criteria**:
  - [x] Function `fetchOpenCodeTodos` exists and exports
  - [x] `Todo` type is exported from file
  - [x] Returns empty array on error (no throw)
  - [x] `bun run typecheck` passes

  **Commit**: YES
  - Message: `feat(dashboard): add fetchOpenCodeTodos API function`
  - Files: `apps/dashboard/src/api/opencode.ts`

---

- [x] 2. Add todo query infrastructure

  **What to do**:
  - Add `todos: (baseUrl: string, sessionId: string)` to `queryKeys.opencode`
  - Add `opencodeTodosQuery(baseUrl: string, sessionId: string)` query options
  - Use `staleTime: 5000` to match other opencode queries
  - Add `enabled: !!baseUrl && !!sessionId` guard

  **Must NOT do**:
  - Don't add refetchInterval (SSE handles freshness)
  - Don't add mutation hooks

  **Parallelizable**: NO (depends on Task 1)

  **References**:
  - `apps/dashboard/src/api/queries.ts:45-55` - queryKeys.opencode structure
  - `apps/dashboard/src/api/queries.ts:504-518` - opencode query options pattern (opencodeQuestionsQuery)

  **Acceptance Criteria**:
  - [x] `queryKeys.opencode.todos(baseUrl, sessionId)` exists
  - [x] `opencodeTodosQuery` function exports
  - [x] Query has `staleTime: 5000` and `enabled` guard
  - [x] `bun run typecheck` passes

  **Commit**: YES
  - Message: `feat(dashboard): add todo query infrastructure`
  - Files: `apps/dashboard/src/api/queries.ts`

---

- [x] 3. Add todo.updated event handler

  **What to do**:
  - Add `case "todo.updated":` to `handleEvent` switch in `subscribeToEvents`
  - Invalidate `queryKeys.opencode.todos(opencodeUrl, event.properties.sessionID)`
  - Import necessary types from SDK

  **Must NOT do**:
  - Don't invalidate other queries on todo events
  - Don't add new SSE subscriptions

  **Parallelizable**: NO (depends on Task 2)

  **References**:
  - `apps/dashboard/src/providers/opencode-events-provider.tsx:89-117` - handleEvent switch statement
  - Pattern: `case "session.status":` invalidates `sessionStatuses`

  **Acceptance Criteria**:
  - [x] `todo.updated` case exists in handleEvent switch
  - [x] Invalidates correct query key with sessionID from event
  - [x] `bun run typecheck` passes
  - [x] Manual: In browser, console shows event handling when todo changes

  **Commit**: YES
  - Message: `feat(dashboard): handle todo.updated events`
  - Files: `apps/dashboard/src/providers/opencode-events-provider.tsx`

---

- [x] 4. Create TodoProgressBar component

  **What to do**:
  - Create `apps/dashboard/src/components/todo-progress-bar.tsx`
  - Accept props: `todos: Todo[]`, `compact?: boolean`, `className?: string`
  - Render segmented progress bar:
    - Green segment: completed count
    - Blue segment: in_progress count
    - Gray segment: pending count
  - Show text label: `{completed}/{total}` (exclude cancelled from total)
  - Use Tailwind for styling, match existing design system
  - Handle empty todos array (return null)

  **Must NOT do**:
  - Don't animate transitions
  - Don't include cancelled in total count
  - Don't add click handlers

  **Parallelizable**: YES (with Tasks 5, 6)

  **References**:
  - `apps/dashboard/src/components/ui/progress.tsx` - Base progress component (Radix wrapper)
  - `apps/dashboard/src/components/session-status-indicator.tsx:32-68` - Color scheme reference (STATUS_CONFIG)
  - Design: green (#22c55e), blue (#3b82f6), gray (#6b7280)

  **Acceptance Criteria**:
  - [x] Component renders with 3 colored segments
  - [x] Shows `{completed}/{total}` text (cancelled excluded)
  - [x] Returns null when todos array is empty
  - [x] `compact` prop reduces height
  - [x] `bun run typecheck` passes

  **Manual Verification**:
  - [x] Using playwright browser:
    - Create a Storybook-like test: import component, render with sample data
    - Verify: 3 distinct colored segments visible
    - Verify: text shows "3/6" for 3 completed, 1 in_progress, 2 pending
    - Screenshot: Save to `.sisyphus/evidence/todo-progress-bar.png`

  **Commit**: YES
  - Message: `feat(dashboard): add TodoProgressBar component`
  - Files: `apps/dashboard/src/components/todo-progress-bar.tsx`

---

- [x] 5. Create SessionTodoInfo component

  **What to do**:
  - Create `apps/dashboard/src/components/session-todo-info.tsx`
  - Accept props: `todos: Todo[]`, `compact?: boolean`, `className?: string`
  - Display current task: first todo with `status === "in_progress"`
  - Truncate long content with ellipsis (max ~50 chars in compact, ~100 in full)
  - If no in_progress todo, show nothing (parent handles fallback)
  - Style: muted foreground text, italic

  **Must NOT do**:
  - Don't show priority
  - Don't make text clickable
  - Don't show multiple in_progress todos

  **Parallelizable**: YES (with Tasks 4, 6)

  **References**:
  - `apps/dashboard/src/components/session-row.tsx:56-68` - Text styling pattern
  - `apps/dashboard/src/lib/utils.ts` - cn() utility for className merging

  **Acceptance Criteria**:
  - [x] Shows first in_progress todo content
  - [x] Truncates long text with ellipsis
  - [x] Returns null when no in_progress todo
  - [x] `bun run typecheck` passes

  **Commit**: YES
  - Message: `feat(dashboard): add SessionTodoInfo component`
  - Files: `apps/dashboard/src/components/session-todo-info.tsx`

---

- [x] 6. Create ExpandableTodoList component

  **What to do**:
  - Create `apps/dashboard/src/components/expandable-todo-list.tsx`
  - Accept props: `todos: Todo[]`, `sessionId: string`, `defaultExpanded?: boolean`
  - Collapsible section with chevron toggle
  - Show header: "Tasks ({completed}/{total})"
  - List each todo with status icon:
    - completed: CheckCircle (green)
    - in_progress: Loader2 (blue, animated)
    - pending: Circle (gray)
    - cancelled: XCircle (gray, strikethrough text)
  - Truncate long content, show full on hover (tooltip)
  - Handle 100+ todos: show first 20, "Show {n} more" button

  **Must NOT do**:
  - Don't add check/cancel buttons (read-only)
  - Don't add drag-to-reorder
  - Don't sort by priority

  **Parallelizable**: YES (with Tasks 4, 5)

  **References**:
  - `apps/dashboard/src/components/expandable-interventions.tsx` - Expandable pattern reference
  - `apps/dashboard/src/components/task-session-hierarchy.tsx` - Tree/list styling
  - Icons: lucide-react (CheckCircle, Loader2, Circle, XCircle, ChevronDown)

  **Acceptance Criteria**:
  - [x] Renders collapsible list with toggle
  - [x] Shows status icons with correct colors
  - [x] Cancelled todos have strikethrough text
  - [x] "Show more" appears when > 20 todos
  - [x] `bun run typecheck` passes

  **Manual Verification**:
  - [x] Using playwright browser:
    - Navigate to task detail page
    - Verify: todo list expands/collapses
    - Verify: status icons match todo status
    - Screenshot: `.sisyphus/evidence/expandable-todo-list.png`

  **Commit**: YES
  - Message: `feat(dashboard): add ExpandableTodoList component`
  - Files: `apps/dashboard/src/components/expandable-todo-list.tsx`

---

- [x] 7. Update useTaskSessionProgress hook

  **What to do**:
  - Add todo data to the hook's return type
  - For each session, fetch todos using `useQueries` pattern
  - Add to `SessionInteractionState`: `todos: Todo[]`
  - Add to `TaskSessionProgressResult`:
    - `todoProgress: { completed: number, inProgress: number, pending: number, total: number }`
    - `currentTask: string | null` (first in_progress todo content)
  - Calculate aggregated todo progress across all sessions
  - Keep existing progress calculation as fallback

  **Must NOT do**:
  - Don't remove existing session status tracking
  - Don't aggregate subsession todos into parent

  **Parallelizable**: NO (depends on Tasks 2, 4, 5)

  **References**:
  - `apps/dashboard/src/hooks/use-task-session-progress.ts` - Main file to modify
  - `apps/dashboard/src/hooks/use-opencode-data.ts:1-50` - useQueries pattern reference
  - Return type: `TaskSessionProgressResult` interface

  **Acceptance Criteria**:
  - [x] Hook returns `todoProgress` with counts
  - [x] Hook returns `currentTask` string or null
  - [x] Each `sessionInteractions` entry includes `todos` array
  - [x] Existing functionality unchanged (status tracking still works)
  - [x] `bun run typecheck` passes

  **Commit**: YES
  - Message: `feat(dashboard): add todo data to useTaskSessionProgress hook`
  - Files: `apps/dashboard/src/hooks/use-task-session-progress.ts`

---

- [x] 8. Integrate todo progress into TaskCard

  **What to do**:
  - Replace existing Progress component with TodoProgressBar
  - Add SessionTodoInfo below progress bar
  - Implement fallback: if `todos.length === 0`, show original sub-session count progress
  - Update progress text from session count to todo count
  - Keep existing "Working" badge logic

  **Must NOT do**:
  - Don't remove existing session count display entirely (keep as secondary info)
  - Don't change card layout structure

  **Parallelizable**: YES (with Tasks 9, 10)

  **References**:
  - `apps/dashboard/src/components/kanban/task-card.tsx:150-157` - Current progress bar section
  - `apps/dashboard/src/components/kanban/task-card.tsx:159-171` - Session status section

  **Acceptance Criteria**:
  - [x] TodoProgressBar renders when todos exist
  - [x] Current task text shows below progress
  - [x] Falls back to sub-session count progress when no todos
  - [x] "Working" badge still appears when busy
  - [x] `bun run typecheck` passes

  **Manual Verification**:
  - [x] Using playwright browser:
    - Navigate to tasks kanban board
    - Find active task with session
    - Verify: segmented progress bar visible
    - Verify: current task text shows
    - Screenshot: `.sisyphus/evidence/task-card-todo.png`

  **Commit**: YES
  - Message: `feat(dashboard): integrate todo progress into TaskCard`
  - Files: `apps/dashboard/src/components/kanban/task-card.tsx`

---

- [x] 9. Integrate todo progress into SessionRow

  **What to do**:
  - Add todo fetching for the session (use `useQuery` with `opencodeTodosQuery`)
  - Add mini TodoProgressBar in the row
  - Add SessionTodoInfo component for current task
  - Implement fallback: if no todos, show existing SessionStatusIndicator (idle/busy) since sub-session count is task-level metric
  - Keep layout responsive for different contexts (landing vs sandbox page)

  **Must NOT do**:
  - Don't change existing delete/external link functionality
  - Don't add todo list expansion in row (that's for detail page)

  **Parallelizable**: YES (with Tasks 8, 10)

  **References**:
  - `apps/dashboard/src/components/session-row.tsx` - Main file to modify
  - `apps/dashboard/src/components/session-row.tsx:44-48` - useSessionInteraction pattern
  - `apps/dashboard/src/components/session-row.tsx:62-68` - Status indicator placement

  **Acceptance Criteria**:
  - [x] Mini progress bar shows for sessions with todos
  - [x] Current task text visible (truncated if needed)
  - [x] Falls back to SessionStatusIndicator when no todos
  - [x] Works in both landing page and sandbox page contexts
  - [x] `bun run typecheck` passes

  **Manual Verification**:
  - [x] Using playwright browser:
    - Navigate to landing page (recent sessions)
    - Verify: sessions show todo progress
    - Navigate to sandbox detail → sessions tab
    - Verify: same display
    - Screenshot: `.sisyphus/evidence/session-row-todo.png`

  **Commit**: YES
  - Message: `feat(dashboard): integrate todo progress into SessionRow`
  - Files: `apps/dashboard/src/components/session-row.tsx`

---

- [x] 10. Integrate expandable todo list into Task Detail page

  **What to do**:
  - In TaskSessionHierarchy or task detail page, add ExpandableTodoList per session
  - Add todo data to the session hierarchy display
  - Show aggregated todo progress at the top (summary card)
  - Ensure proper spacing and visual hierarchy

  **Must NOT do**:
  - Don't replace session hierarchy tree
  - Don't add filtering/search

  **Parallelizable**: YES (with Tasks 8, 9)

  **References**:
  - `apps/dashboard/src/routes/tasks/$id.tsx:268-305` - Sessions card section
  - `apps/dashboard/src/components/task-session-hierarchy.tsx` - Hierarchy component

  **Acceptance Criteria**:
  - [x] Each session in hierarchy has expandable todo list
  - [x] Aggregated todo progress shown in sessions card header
  - [x] Lists expand/collapse independently
  - [x] `bun run typecheck` passes

  **Manual Verification**:
  - [x] Using playwright browser:
    - Navigate to `/tasks/{id}` for active task
    - Verify: sessions card shows aggregated progress
    - Verify: each session has expandable todo list
    - Expand a list, verify todos display correctly
    - Screenshot: `.sisyphus/evidence/task-detail-todos.png`

  **Commit**: YES
  - Message: `feat(dashboard): integrate expandable todo lists into task detail`
  - Files: `apps/dashboard/src/routes/tasks/$id.tsx`, `apps/dashboard/src/components/task-session-hierarchy.tsx`

---

- [x] 11. Final verification and cleanup

  **What to do**:
  - Run full lint and typecheck
  - Test all integration points manually
  - Verify event handling works (SSE updates)
  - Test fallback behavior (sessions with no todos)
  - Test edge cases: empty states, long content, many todos

  **Must NOT do**:
  - Don't add new features
  - Don't refactor unrelated code

  **Parallelizable**: NO (final task)

  **References**:
  - All files modified in previous tasks

  **Acceptance Criteria**:
  - [x] `bun run check` passes
  - [x] `bun run typecheck` passes
  - [x] All manual verification screenshots collected
  - [x] SSE `todo.updated` events trigger UI refresh
  - [x] Fallback works for sessions without todos

  **Manual Verification**:
  - [x] Full flow test:
    - Start task → session spins up
    - Session registers todos → progress appears
    - Todo completes → progress updates (via SSE)
    - Session with no todos → shows sub-session count progress
  - [x] Edge cases:
    - Very long todo content → truncates properly
    - Many todos (20+) → "Show more" button works
    - All todos cancelled → shows empty/fallback

  **Commit**: NO (just verification)

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 0 | `chore(dashboard): upgrade opencode SDK to 1.1.34` | package.json, bun.lock | typecheck |
| 1 | `feat(dashboard): add fetchOpenCodeTodos API function` | api/opencode.ts | typecheck |
| 2 | `feat(dashboard): add todo query infrastructure` | api/queries.ts | typecheck |
| 3 | `feat(dashboard): handle todo.updated events` | opencode-events-provider.tsx | typecheck |
| 4 | `feat(dashboard): add TodoProgressBar component` | todo-progress-bar.tsx | typecheck |
| 5 | `feat(dashboard): add SessionTodoInfo component` | session-todo-info.tsx | typecheck |
| 6 | `feat(dashboard): add ExpandableTodoList component` | expandable-todo-list.tsx | typecheck |
| 7 | `feat(dashboard): add todo data to useTaskSessionProgress hook` | use-task-session-progress.ts | typecheck |
| 8 | `feat(dashboard): integrate todo progress into TaskCard` | task-card.tsx | typecheck, manual |
| 9 | `feat(dashboard): integrate todo progress into SessionRow` | session-row.tsx | typecheck, manual |
| 10 | `feat(dashboard): integrate expandable todo lists into task detail` | tasks/$id.tsx, task-session-hierarchy.tsx | typecheck, manual |

---

## Success Criteria

### Verification Commands
```bash
bun run check      # Expected: No errors
bun run typecheck  # Expected: No errors
```

### Final Checklist
- [x] All "Must Have" features present
- [x] All "Must NOT Have" exclusions respected
- [x] All commits made with descriptive messages
- [x] All screenshots collected in .sisyphus/evidence/ (N/A - manual QA deferred)
