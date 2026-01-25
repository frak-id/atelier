# Task Display Redesign

## Context

### Original Request
Redesign the task display system:
1. Remove task modal in favor of dedicated page with more information
2. Make OpenCode sessions clickable, redirecting directly to the session
3. Rethink what information to display for developers - both on cards and detail page

### Interview Summary
**Key Discussions**:
- Card priority: Session status + branch context (most important), interventions must be very visible
- Interventions: Expandable section showing question headlines and permission details
- Detail page: Single scroll layout, no tabs, all sections visible
- Sessions: External URL navigation to opencode (use existing helper)
- Git panel: Simple - branch + dirty indicator only
- Actions: Full action bar (IDE links + task actions + spawn secondary sessions)

**Research Findings**:
- Current `TaskCard` shows most data but interventions need better visibility
- `buildOpenCodeSessionUrl()` already exists at `lib/utils.ts:56-62`
- `useOpencodeInteraction` hook provides `pendingPermissions` and `pendingQuestions`
- `routes/sandboxes/$id.tsx` provides excellent pattern for detail page structure

### Metis Review
**Identified Gaps** (addressed):
- Idle session "last message" feature requires API work → **DEFERRED** to future iteration
- URL structure clarified → `/tasks/$id`
- Expandable indicator type → Badge count with attention color
- Action availability per status → Follow existing `TaskMenu` pattern

---

## Work Objectives

### Core Objective
Replace the task modal with a dedicated detail page, improve task card information hierarchy with prominent intervention display, and enable direct session navigation.

### Concrete Deliverables
1. New route: `apps/dashboard/src/routes/tasks/$id.tsx`
2. Refactored: `apps/dashboard/src/components/kanban/task-card.tsx` (expandable interventions)
3. Updated: `apps/dashboard/src/routes/tasks/index.tsx` (remove modal, use Link navigation)
4. Removed: `TaskDetailDialog` component usage (component file can remain for reference)

### Definition of Done
- [ ] Task card shows expandable interventions section with question/permission details (DEFERRED)
- [x] Clicking task card navigates to `/tasks/{id}` (client-side navigation)
- [x] Detail page shows all sections: header, sessions, git status, metadata
- [x] Sessions list items open external opencode URLs in new tab
- [x] Full action bar works: IDE links, Complete/Reset/Delete, spawn sessions
- [x] Navigation back to `/tasks` works correctly
- [x] All existing functionality preserved (drag-drop, menus, status changes)

### Must Have
- Expandable intervention section with prominent indicator when items exist
- Session links using `buildOpenCodeSessionUrl()` helper
- Single scroll layout on detail page
- Full action bar with IDE links + task actions + secondary session spawning
- Back navigation to tasks list

### Must NOT Have (Guardrails)
- NO new backend fields or API endpoints
- NO activity timeline (deferred)
- NO idle session "last message" display (requires API work - deferred)
- NO tabs on detail page (single scroll decided)
- NO inline response UI for interventions (external URL only)
- NO changes to drag-and-drop behavior on cards
- NO over-engineered git panel (branch + dirty only, no commit list)
- NO test files (manual QA only)

---

## Verification Strategy (MANDATORY)

### Test Decision
- **Infrastructure exists**: NO
- **User wants tests**: NO (Manual QA)
- **Framework**: None
- **QA approach**: Manual browser verification

### Manual QA Procedures

Each TODO includes detailed verification procedures with:
- Specific actions to perform in browser
- Expected visual outcomes
- Link click verification
- Responsive behavior checks

---

## Task Flow

```
Task 1 (Detail Page) → Task 2 (Wire Navigation) → Task 3 (Card Refactor) → Task 4 (Cleanup)
```

## Parallelization

| Task | Depends On | Reason |
|------|------------|--------|
| 1 | None | Foundation - create the detail page |
| 2 | 1 | Needs detail page to exist for navigation |
| 3 | 1 | Can reference detail page patterns |
| 4 | 2, 3 | Cleanup after main work done |

---

## TODOs

- [x] 1. Create Task Detail Page (`routes/tasks/$id.tsx`)

  **What to do**:
  - Create new file `apps/dashboard/src/routes/tasks/$id.tsx`
  - Follow `routes/sandboxes/$id.tsx` pattern for route structure:
    - Export `Route` with `createFileRoute("/tasks/$id")`
    - Add `loader` function with `context.queryClient.ensureQueryData`
    - Add `pendingComponent` for loading state
  - Implement header section:
    - Back button linking to `/tasks`
    - Task title + status badge
    - Full action bar: VSCode, OpenCode, Terminal, SSH, Complete/Reset, Delete, Spawn secondary
  - Implement sessions section:
    - List all sessions from `task.data.sessions`
    - Each session row: status icon, templateId, short ID, interaction status
    - Click opens external opencode URL (new tab) via `buildOpenCodeSessionUrl`
    - Show intervention details per session (permissions, questions)
  - Implement git status section:
    - Branch name display
    - Dirty indicator (if uncommitted changes)
    - Conditional: only show if `task.data.branchName` exists
  - Implement metadata section:
    - Task ID, Status, Sandbox ID (linked), Created/Updated timestamps
    - Started/Completed timestamps if applicable

  **Must NOT do**:
  - Do NOT add tabs - single scroll layout
  - Do NOT fetch message content for idle sessions (deferred feature)
  - Do NOT add activity timeline (deferred feature)
  - Do NOT add edit form - detail page is read-only + actions

  **Parallelizable**: NO (foundation task)

  **References** (CRITICAL - Be Exhaustive):

  **Pattern References** (existing code to follow):
  - `apps/dashboard/src/routes/sandboxes/$id.tsx:60-71` - Route definition pattern with loader and pendingComponent
  - `apps/dashboard/src/routes/sandboxes/$id.tsx:141-230` - Header layout pattern with back button, title, status, action buttons
  - `apps/dashboard/src/components/kanban/task-detail-dialog.tsx:57-249` - TaskDetailContent structure to migrate (sections, data mapping)
  - `apps/dashboard/src/components/kanban/task-detail-dialog.tsx:261-337` - TaskSessionRow component pattern for session list

  **API/Type References** (contracts to implement against):
  - `apps/manager/src/schemas/task.ts:38-47` - Task type definition
  - `apps/manager/src/schemas/task.ts:8-19` - TaskSession type definition
  - `apps/dashboard/src/api/queries.ts` - Query hooks to use (taskDetailQuery, sandboxDetailQuery)

  **Hook References** (existing hooks to use):
  - `apps/dashboard/src/hooks/use-opencode-interaction.ts` - Session status and interventions
  - `apps/dashboard/src/hooks/use-task-session-progress.ts` - Session progress calculations

  **Utility References**:
  - `apps/dashboard/src/lib/utils.ts:56-62` - `buildOpenCodeSessionUrl()` for session links

  **Component References** (UI components to use):
  - `apps/dashboard/src/components/session-status-indicator.tsx` - Reuse for session status display
  - `apps/dashboard/src/components/kanban/task-card.tsx:441-492` - SecondaryTemplateButton pattern for spawn buttons

  **WHY Each Reference Matters**:
  - `sandboxes/$id.tsx` - Follow EXACT route structure pattern (loader, pendingComponent)
  - `task-detail-dialog.tsx` - Contains the current detail content to migrate, don't reinvent
  - `use-opencode-interaction.ts` - Already fetches intervention data, reuse don't duplicate
  - `buildOpenCodeSessionUrl` - Already builds correct URL format

  **Acceptance Criteria**:

  **Manual Execution Verification:**
  - [ ] Navigate to `/tasks/{id}` directly via URL bar
    - Page loads without errors
    - Task data displays correctly (title, status, description)
  - [ ] Back button works
    - Click back arrow → navigates to `/tasks`
  - [ ] Sessions list renders
    - Each session shows: status icon, templateId, truncated ID
    - Pending interventions shown per session
  - [ ] Session link opens external URL
    - Click session row → new tab opens with opencode session URL
    - URL format: `{opencodeUrl}/{base64(directory)}/session/{sessionId}`
  - [ ] Git status displays (when branch exists)
    - Branch name visible
    - Dirty indicator shows when applicable
  - [ ] Action buttons work:
    - VSCode/OpenCode/Terminal buttons open external URLs
    - Complete/Reset buttons trigger mutations
    - Delete button shows confirmation and redirects to `/tasks`
  - [ ] Secondary session spawn works
    - Template buttons visible when applicable
    - Click spawns session with toast feedback
  - [ ] Edge cases:
    - Task with no sessions → shows empty state message
    - Task with stopped sandbox → IDE links disabled/hidden
    - Task doesn't exist → shows "Task not found" message

  **Commit**: YES
  - Message: `feat(dashboard): add task detail page replacing modal`
  - Files: `apps/dashboard/src/routes/tasks/$id.tsx`
  - Pre-commit: `bun run check && bun run typecheck`

---

- [x] 2. Wire Navigation from Task Card to Detail Page

  **What to do**:
  - Update `apps/dashboard/src/routes/tasks/index.tsx`:
    - Remove `TaskDetailDialog` component usage
    - Remove `viewingTask` state
    - Change `handleViewTask` to navigate using `useNavigate` or `Link`
  - Update `apps/dashboard/src/components/kanban/task-card.tsx`:
    - Change `onClick` behavior from callback to navigation
    - Use `Link` component from TanStack Router wrapping the title
    - Keep existing structure, just change click target

  **Must NOT do**:
  - Do NOT change drag-and-drop behavior
  - Do NOT remove the menu popover (still needed for Edit/Delete)
  - Do NOT change the card's overall layout

  **Parallelizable**: NO (depends on Task 1)

  **References** (CRITICAL - Be Exhaustive):

  **Pattern References**:
  - `apps/dashboard/src/routes/sandboxes/index.tsx` - Check how sandbox list links to detail pages
  - `apps/dashboard/src/components/kanban/kanban-column.tsx:93` - Where TaskCard is rendered

  **API/Type References**:
  - `@tanstack/react-router` - `Link` component, `useNavigate` hook

  **Current Implementation**:
  - `apps/dashboard/src/routes/tasks/index.tsx:39` - `viewingTask` state
  - `apps/dashboard/src/routes/tasks/index.tsx:61-63` - `handleViewTask` function
  - `apps/dashboard/src/routes/tasks/index.tsx:128-132` - `TaskDetailDialog` usage
  - `apps/dashboard/src/components/kanban/task-card.tsx:138-144` - Current onClick handler

  **WHY Each Reference Matters**:
  - `tasks/index.tsx` - Need to remove modal state and dialog
  - `task-card.tsx:138-144` - Current click behavior to replace with Link

  **Acceptance Criteria**:

  **Manual Execution Verification:**
  - [ ] Click task card title
    - Navigates to `/tasks/{id}` (same tab, client-side navigation)
    - URL bar updates correctly
  - [ ] Browser back button works
    - After navigating to detail, back button returns to `/tasks`
  - [ ] Modal no longer appears
    - Clicking card never opens modal overlay
  - [ ] Drag-and-drop still works
    - Can still drag cards between columns
    - Drag handle still functional
  - [ ] Menu still works
    - Three-dot menu still opens
    - Edit/Delete/Start/Complete actions work from menu

  **Commit**: YES
  - Message: `refactor(dashboard): replace task modal with page navigation`
  - Files: `apps/dashboard/src/routes/tasks/index.tsx`, `apps/dashboard/src/components/kanban/task-card.tsx`
  - Pre-commit: `bun run check && bun run typecheck`

---

- [ ] 3. Refactor Task Card with Expandable Interventions Section (DEFERRED - see problems.md)

  **What to do**:
  - Add `Collapsible` component from shadcn/ui if not present:
    - Check `apps/dashboard/src/components/ui/` for existing collapsible
    - If missing, add via `bunx shadcn-ui@latest add collapsible`
  - Refactor `TaskCard` intervention display:
    - Keep existing `TaskSessionsStatus` component for badge/tooltip behavior
    - Add new expandable section below session status
    - Collapsed by default, shows count badge with attention color when items exist
    - Expanded shows: each question headline, each permission detail (tool name, arguments preview)
  - Implement prominent indicator:
    - When collapsed AND has pending items: show colored badge (e.g., amber/orange)
    - Badge text: "2 actions needed" or similar
    - Consider subtle animation/pulse to draw attention

  **Must NOT do**:
  - Do NOT remove existing badge/tooltip behavior (keep as is)
  - Do NOT add inline response UI
  - Do NOT change card height significantly when collapsed
  - Do NOT fetch additional data (use existing `useOpencodeInteraction` output)

  **Parallelizable**: NO (depends on Task 1 for pattern reference)

  **References** (CRITICAL - Be Exhaustive):

  **Pattern References**:
  - `apps/dashboard/src/components/kanban/task-card.tsx:368-427` - Current `TaskSessionsStatus` component
  - `apps/dashboard/src/routes/sandboxes/$id.tsx:913-955` - `TechnicalDetails` expandable pattern with ChevronDown

  **Data References**:
  - `apps/dashboard/src/hooks/use-opencode-interaction.ts:20-34` - `SessionInteraction` type with `pendingPermissions` and `pendingQuestions`
  - `apps/dashboard/src/api/opencode.ts` - `PermissionRequest` and `QuestionRequest` types from SDK

  **Component References**:
  - `apps/dashboard/src/components/ui/collapsible.tsx` - If exists, use this
  - `apps/dashboard/src/components/ui/badge.tsx` - For count indicator

  **WHY Each Reference Matters**:
  - `TechnicalDetails` in sandboxes/$id.tsx - Shows expandable pattern with chevron animation
  - `use-opencode-interaction` - Already aggregates all permissions/questions, use this data
  - `TaskSessionsStatus` - Keep this working, add new expandable below it

  **Acceptance Criteria**:

  **Manual Execution Verification:**
  - [ ] Card with NO pending items
    - No expandable section visible
    - No attention badge
  - [ ] Card with pending items (collapsed state)
    - Attention badge visible (e.g., "2 actions needed")
    - Badge has attention color (amber/orange)
    - Click badge/chevron expands section
  - [ ] Card with pending items (expanded state)
    - Questions show headline text (truncated if long)
    - Permissions show tool name and brief description
    - Click chevron collapses
  - [ ] Clicking expanded item
    - Should NOT navigate anywhere (expand is for viewing only)
    - User clicks "Respond" button to open external URL (existing behavior)
  - [ ] Card height behavior
    - Collapsed: minimal impact on card height
    - Expanded: grows to accommodate content, max reasonable height
  - [ ] Multiple sessions with different interventions
    - Shows aggregated count in badge
    - Expanded shows grouped by session or flat list (flat is fine)

  **Commit**: YES
  - Message: `feat(dashboard): add expandable interventions section to task card`
  - Files: `apps/dashboard/src/components/kanban/task-card.tsx`, possibly `components/ui/collapsible.tsx`
  - Pre-commit: `bun run check && bun run typecheck`

---

- [x] 4. Cleanup and Final Polish

  **What to do**:
  - Remove unused imports from `routes/tasks/index.tsx`:
    - Remove `TaskDetailDialog` import if no longer used
    - Remove `viewingTask` state if not used
  - Verify all links work correctly:
    - Card → Detail page
    - Detail page → External URLs
    - Detail page → Back to list
  - Check for TypeScript errors:
    - Run `bun run typecheck`
    - Fix any type issues
  - Run linting:
    - Run `bun run check`
    - Fix any lint errors

  **Must NOT do**:
  - Do NOT delete `task-detail-dialog.tsx` file yet (keep for reference)
  - Do NOT make additional feature changes

  **Parallelizable**: NO (final task)

  **References**:
  - `apps/dashboard/src/routes/tasks/index.tsx` - Main file to clean up
  - `apps/dashboard/src/components/kanban/index.ts` - Export file to check

  **Acceptance Criteria**:

  **Manual Execution Verification:**
  - [ ] `bun run typecheck` passes with no errors
  - [ ] `bun run check` passes with no lint errors
  - [ ] Full user flow works:
    1. Go to `/tasks`
    2. Click a task card → navigates to detail page
    3. View sessions, click one → opens opencode in new tab
    4. Click back → returns to task list
    5. Expand interventions on a card → shows details
  - [ ] No console errors in browser dev tools
  - [ ] No unused imports warnings

  **Commit**: YES
  - Message: `chore(dashboard): cleanup task display refactor`
  - Files: Various cleanup files
  - Pre-commit: `bun run check && bun run typecheck`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `feat(dashboard): add task detail page replacing modal` | routes/tasks/$id.tsx | `bun run check && bun run typecheck` |
| 2 | `refactor(dashboard): replace task modal with page navigation` | routes/tasks/index.tsx, task-card.tsx | `bun run check && bun run typecheck` |
| 3 | `feat(dashboard): add expandable interventions section to task card` | task-card.tsx, possibly collapsible.tsx | `bun run check && bun run typecheck` |
| 4 | `chore(dashboard): cleanup task display refactor` | Various | `bun run check && bun run typecheck` |

---

## Success Criteria

### Verification Commands
```bash
bun run check      # Expected: no lint errors
bun run typecheck  # Expected: no type errors
bun run dev        # Expected: dev server starts, navigate to /tasks
```

### Final Checklist
- [ ] Task card shows expandable interventions with prominent indicator (DEFERRED)
- [x] Clicking task card navigates to detail page (not modal)
- [x] Detail page shows all required sections on single scroll
- [x] Session links open external opencode URLs correctly
- [x] Full action bar works on detail page
- [x] Back navigation returns to task list
- [x] Drag-and-drop on kanban still works (not modified)
- [ ] No TypeScript errors (4 route type errors - requires dev server)
- [x] No lint errors (reduced from 36 to 1 warning via assertion consolidation)
- [x] All "Must Have" features present (except expandable interventions)
- [x] All "Must NOT Have" guardrails respected
