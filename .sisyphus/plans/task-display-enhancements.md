# Task Display Enhancements

## Context

### Original Request
1. Add Phase 3: Expandable interventions sections for permissions/questions (on both task cards and detail page)
2. Session hierarchy tracking: Include all subsessions in progress tracking using `session-hierarchy.ts`

### Interview Summary
**Key Requirements**:
- Expandable sections showing detailed permission/question information
- Use existing `buildSessionHierarchy()` helper from `session-hierarchy.ts`
- Fetch ALL opencode sessions for task's sandbox (not just task.data.sessions)
- Filter hierarchy to get task-relevant root sessions
- Include all sessions + subsessions in progress indicators
- Collapsible UI pattern (following `hierarchical-session-list.tsx` pattern)

**Research Findings**:
- `useOpencodeInteraction` hook already provides permissions/questions per session
- `hierarchical-session-list.tsx` shows expandable pattern with ChevronDown/ChevronRight
- `useAllOpenCodeSessions` fetches all sessions from running sandboxes
- `useTaskSessionProgress` currently only uses `task.data.sessions` (needs update)
- No Collapsible component exists yet (need to add from shadcn/ui or build custom)

---

## Work Objectives

### Core Objective
Add expandable intervention displays and include session hierarchy (with all subsessions) in task progress tracking.

### Concrete Deliverables
1. Collapsible UI component (shadcn/ui or custom)
2. New component: `ExpandableInterventions` (reusable for cards + detail page)
3. Updated: `TaskCard` with expandable interventions section
4. Updated: Task detail page with expandable interventions section
5. New hook: `useTaskSessionHierarchy` (fetches all sessions, builds hierarchy, filters)
6. Updated: `useTaskSessionProgress` to include subsessions
7. Updated: Components using session progress to display subsession counts

### Definition of Done
- [ ] Collapsible component available
- [ ] Task cards show expandable interventions section when items exist
- [ ] Task detail page shows expandable interventions section when items exist
- [ ] Expandable sections show permission details (tool name, arguments preview)
- [ ] Expandable sections show question headlines (truncated if long)
- [ ] Progress tracking includes all subsessions recursively
- [ ] Progress indicators show accurate counts with subsessions
- [ ] Session hierarchy correctly filters to task-relevant root sessions
- [ ] All existing functionality preserved

### Must Have
- Collapsible interventions section (collapsed by default)
- Count badge showing total interventions when collapsed
- Attention styling (amber/orange) when interventions exist
- Detailed list when expanded (permissions + questions)
- Session hierarchy hook that:
  - Fetches all opencode sessions for task's sandbox
  - Builds hierarchy using `buildSessionHierarchy()`
  - Filters to task-relevant root sessions
  - Flattens tree to get all sessions + subsessions
- Updated progress tracking using hierarchy

### Must NOT Have (Guardrails)
- NO inline response UI for interventions (external URL only)
- NO changes to drag-and-drop behavior on cards
- NO new backend fields or API endpoints
- NO changes to session hierarchy algorithm (use existing helper)
- NO test files (manual QA only)
- NO over-complicated UI (keep it simple and consistent)

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
- Click/expand behavior verification
- Progress count accuracy checks

---

## Task Flow

```
Task 1 (Collapsible) → Task 2 (Interventions Component) → Task 3 (Card Update) → Task 4 (Detail Update) → Task 5 (Hierarchy Hook) → Task 6 (Progress Update) → Task 7 (Cleanup)
```

## Parallelization

| Task | Depends On | Reason |
|------|------------|--------|
| 1 | None | Foundation - add UI component |
| 2 | 1 | Needs Collapsible component |
| 3 | 2 | Needs ExpandableInterventions component |
| 4 | 2 | Needs ExpandableInterventions component (can run parallel with 3) |
| 5 | None | Independent - create hierarchy hook |
| 6 | 5 | Needs hierarchy hook |
| 7 | 3, 4, 6 | Final cleanup |

**Parallel opportunities**:
- Tasks 3 + 4 (both use same component, different contexts)
- Task 5 can run parallel with 1-4 (independent work)

---

## TODOs

- [x] 1. Add Collapsible UI Component

  **What to do**:
  - Check if shadcn/ui Collapsible component is available
  - If not, add it: `bunx shadcn-ui@latest add collapsible`
  - Verify component imports and works
  - Alternatively, create custom collapsible using pattern from `hierarchical-session-list.tsx`
  
  **Must NOT do**:
  - Do NOT over-engineer - simple collapse/expand is sufficient
  - Do NOT add animations unless shadcn provides them by default
  
  **Parallelizable**: NO (foundation task)
  
  **References** (CRITICAL - Be Exhaustive):
  
  **Pattern References**:
  - `apps/dashboard/src/components/hierarchical-session-list.tsx:31-93` - Existing expand/collapse pattern with ChevronDown/ChevronRight
  - shadcn/ui Collapsible docs - https://ui.shadcn.com/docs/components/collapsible
  
  **Component References**:
  - `apps/dashboard/src/components/ui/` - Where UI components live
  
  **WHY Each Reference Matters**:
  - `hierarchical-session-list.tsx` - Shows working expand/collapse pattern if shadcn unavailable
  - shadcn docs - Standard component library used in project
  
  **Acceptance Criteria**:
  
  **Manual Execution Verification:**
  - [ ] Collapsible component imported successfully
  - [ ] Can create test collapsible section that expands/collapses
  - [ ] Component works with child content
  
  **Commit**: YES
  - Message: `feat(dashboard): add collapsible UI component`
  - Files: `apps/dashboard/src/components/ui/collapsible.tsx` (if added)
  - Pre-commit: `bun run check && bun run typecheck`

---

- [x] 2. Create ExpandableInterventions Component

  **What to do**:
  - Create new file: `apps/dashboard/src/components/expandable-interventions.tsx`
  - Component accepts props:
    - `permissions: Array<PermissionRequest & { sessionId: string }>`
    - `questions: Array<QuestionRequest & { sessionId: string }>`
    - `compact?: boolean` (for card vs detail page)
  - Implement collapsed state:
    - Show count badge: "X actions needed" or "X items need attention"
    - Use attention color (amber/orange) when items exist
    - Show expand chevron
  - Implement expanded state:
    - List all permissions with:
      - Tool name (e.g., "bash", "edit_file")
      - Arguments preview (truncate if long, e.g., first 100 chars)
      - Session ID indicator (small badge)
    - List all questions with:
      - Question headline/text (truncate if long)
      - Session ID indicator (small badge)
  - Click behavior: Toggle between collapsed/expanded
  
  **Must NOT do**:
  - Do NOT add inline response UI
  - Do NOT add "Respond" button per item (that's in the parent)
  - Do NOT fetch data (data passed via props)
  
  **Parallelizable**: NO (depends on Task 1)
  
  **References** (CRITICAL - Be Exhaustive):
  
  **Pattern References**:
  - `apps/dashboard/src/components/session-status-indicator.tsx:86-177` - Shows how permissions/questions are displayed in tooltips
  - `apps/dashboard/src/components/hierarchical-session-list.tsx:31-93` - Expand/collapse pattern
  
  **Data References**:
  - `@opencode-ai/sdk/v2` - `PermissionRequest` and `QuestionRequest` types
  - `apps/dashboard/src/hooks/use-opencode-interaction.ts:92-97` - SessionInteraction type showing structure
  
  **Component References**:
  - `apps/dashboard/src/components/ui/badge.tsx` - For count indicator and session badges
  - `apps/dashboard/src/components/ui/collapsible.tsx` - For expand/collapse behavior
  - `lucide-react` - ChevronDown, ChevronRight icons
  
  **WHY Each Reference Matters**:
  - `session-status-indicator.tsx` - Shows how to display permission/question details
  - `hierarchical-session-list.tsx` - Proven expand/collapse pattern
  - SDK types - Ensure correct data structure handling
  
  **Acceptance Criteria**:
  
  **Manual Execution Verification:**
  - [ ] Component renders with no interventions → shows nothing
  - [ ] Component renders with interventions (collapsed):
    - Shows count badge with attention color
    - Shows chevron icon
    - Click expands section
  - [ ] Component renders with interventions (expanded):
    - Shows all permissions with tool name + args preview
    - Shows all questions with text
    - Session ID badges visible
    - Click chevron collapses
  - [ ] Compact mode works (smaller text, tighter spacing)
  
  **Commit**: YES
  - Message: `feat(dashboard): add expandable interventions component`
  - Files: `apps/dashboard/src/components/expandable-interventions.tsx`
  - Pre-commit: `bun run check && bun run typecheck`

---

- [x] 3. Update Task Card with Expandable Interventions

  **What to do**:
  - Update `apps/dashboard/src/components/kanban/task-card.tsx`
  - Import `ExpandableInterventions` component
  - After `TaskSessionsStatus` component (around line 410), add `ExpandableInterventions`:
    - Pass aggregated `allPermissions` and `allQuestions` (already calculated)
    - Use `compact={true}` for cards
  - Ensure it's visible even when collapsed (don't hide based on needsAttention)
  
  **Must NOT do**:
  - Do NOT remove `TaskSessionsStatus` (keep both)
  - Do NOT change card layout significantly
  - Do NOT affect drag-and-drop behavior
  
  **Parallelizable**: YES (with Task 4 - both use same component)
  
  **References** (CRITICAL - Be Exhaustive):
  
  **Current Implementation**:
  - `apps/dashboard/src/components/kanban/task-card.tsx:368-427` - `TaskSessionsStatus` component location
  - `apps/dashboard/src/components/kanban/task-card.tsx:379-384` - `allPermissions` and `allQuestions` calculation
  
  **Component References**:
  - `apps/dashboard/src/components/expandable-interventions.tsx` - Component to add
  
  **WHY Each Reference Matters**:
  - Current task-card.tsx - Know where to insert component and what data is available
  - ExpandableInterventions - The component we're integrating
  
  **Acceptance Criteria**:
  
  **Manual Execution Verification:**
  - [ ] Task card with NO interventions:
    - No expandable section visible (component returns null)
  - [ ] Task card with pending interventions (collapsed):
    - Count badge visible below session status
    - Attention color applied
    - Click expands section
  - [ ] Task card with pending interventions (expanded):
    - Permission details visible
    - Question details visible
    - Session badges visible
    - Click collapses
  - [ ] Drag-and-drop still works
  - [ ] Card doesn't grow too tall when collapsed
  
  **Commit**: YES
  - Message: `feat(dashboard): add expandable interventions to task cards`
  - Files: `apps/dashboard/src/components/kanban/task-card.tsx`
  - Pre-commit: `bun run check && bun run typecheck`

---

- [x] 4. Update Task Detail Page with Expandable Interventions

  **What to do**:
  - Update `apps/dashboard/src/routes/tasks/$id.tsx`
  - Import `ExpandableInterventions` component
  - In the sessions card (around line 420-460), add section above session list:
    - Calculate aggregated permissions/questions from `interactionState.sessions`
    - Add `ExpandableInterventions` component with `compact={false}`
    - Place it prominently at top of sessions card
  - Alternative: Create separate "Interventions" card above sessions card
  
  **Must NOT do**:
  - Do NOT remove existing session status indicators
  - Do NOT change session list layout
  - Do NOT remove "Respond" buttons
  
  **Parallelizable**: YES (with Task 3 - both use same component)
  
  **References** (CRITICAL - Be Exhaustive):
  
  **Current Implementation**:
  - `apps/dashboard/src/routes/tasks/$id.tsx:88-95` - `interactionState` from `useOpencodeInteraction`
  - `apps/dashboard/src/routes/tasks/$id.tsx:410-475` - Sessions Progress card section
  - `apps/dashboard/src/routes/tasks/$id.tsx:416-417` - `hasPendingInteractions` check
  - `apps/dashboard/src/routes/tasks/$id.tsx:443-444` - Aggregated permissions/questions
  
  **Component References**:
  - `apps/dashboard/src/components/expandable-interventions.tsx` - Component to add
  
  **WHY Each Reference Matters**:
  - Current task detail page - Know where to insert and what data is available
  - ExpandableInterventions - The component we're integrating
  
  **Acceptance Criteria**:
  
  **Manual Execution Verification:**
  - [ ] Task detail page with NO interventions:
    - No expandable section visible
  - [ ] Task detail page with pending interventions (collapsed):
    - Interventions section visible at top of sessions card
    - Count badge shows total interventions
    - Attention color applied
    - Click expands
  - [ ] Task detail page with pending interventions (expanded):
    - All permissions shown with full details
    - All questions shown with full text
    - Session badges visible per item
    - Click collapses
  - [ ] "Respond" button still works (opens external URL)
  
  **Commit**: YES
  - Message: `feat(dashboard): add expandable interventions to task detail page`
  - Files: `apps/dashboard/src/routes/tasks/$id.tsx`
  - Pre-commit: `bun run check && bun run typecheck`

---

- [x] 5. Create Task Session Hierarchy Hook

  **What to do**:
  - Create new file: `apps/dashboard/src/hooks/use-task-session-hierarchy.ts`
  - Create hook: `useTaskSessionHierarchy(task: Task, sandboxOpencodeUrl: string | undefined)`
  - Hook logic:
    1. Fetch all opencode sessions for the sandbox using `opencodeSessionsQuery`
    2. Build session hierarchy using `buildSessionHierarchy()` from `session-hierarchy.ts`
    3. Filter hierarchy to get task-relevant root sessions:
       - Root sessions are those in `task.data.sessions`
       - Find their nodes in the hierarchy
    4. Flatten the filtered tree to get all sessions + subsessions recursively
    5. Return: `{ allSessions: Session[], rootSessions: Session[], isLoading: boolean }`
  - Helper function to flatten hierarchy: `flattenHierarchy(nodes: SessionNode[]): Session[]`
  
  **Must NOT do**:
  - Do NOT modify `buildSessionHierarchy()` algorithm
  - Do NOT fetch sessions if sandbox is not running
  - Do NOT cache beyond TanStack Query's built-in caching
  
  **Parallelizable**: YES (independent work)
  
  **References** (CRITICAL - Be Exhaustive):
  
  **Pattern References**:
  - `apps/dashboard/src/hooks/use-all-opencode-sessions.ts:13-52` - Pattern for fetching all sessions from a sandbox
  - `apps/dashboard/src/components/hierarchical-session-list.tsx:113` - Using `buildSessionHierarchy()`
  
  **API/Type References**:
  - `apps/dashboard/src/api/queries.ts` - `opencodeSessionsQuery` to fetch sessions
  - `apps/dashboard/src/lib/session-hierarchy.ts:8-52` - `buildSessionHierarchy()` and `SessionNode` type
  - `apps/manager/src/schemas/task.ts:38-47` - Task type showing `data.sessions` structure
  
  **Utility References**:
  - `apps/dashboard/src/lib/session-hierarchy.ts:54-60` - `countSubSessions()` helper (can use for validation)
  
  **WHY Each Reference Matters**:
  - `use-all-opencode-sessions.ts` - Shows how to fetch and structure session data
  - `session-hierarchy.ts` - The core algorithm to use
  - `opencodeSessionsQuery` - How to fetch sessions from opencode URL
  - Task type - Know structure of `task.data.sessions` for filtering
  
  **Acceptance Criteria**:
  
  **Manual Execution Verification:**
  - [ ] Hook returns empty arrays when sandbox not running
  - [ ] Hook fetches all sessions for running sandbox
  - [ ] Hook builds hierarchy correctly
  - [ ] Hook filters to task-relevant root sessions only
  - [ ] Hook flattens hierarchy to include all subsessions
  - [ ] Returned `allSessions` includes root + all descendants
  - [ ] `isLoading` reflects query loading state
  
  **Commit**: YES
  - Message: `feat(dashboard): add task session hierarchy hook`
  - Files: `apps/dashboard/src/hooks/use-task-session-hierarchy.ts`
  - Pre-commit: `bun run check && bun run typecheck`

---

- [ ] 6. Update Progress Tracking with Session Hierarchy

  **What to do**:
  - Update `apps/dashboard/src/hooks/use-task-session-progress.ts`
  - Add optional parameter: `includeSubsessions?: boolean` (default false for backward compatibility)
  - Add optional parameter: `allSessions?: Session[]` (from hierarchy hook)
  - When `includeSubsessions` is true:
    - Use `allSessions` instead of `task.data.sessions`
    - Update counts to include subsessions
    - Update `progressPercent` calculation
  - Add to return type: `subsessionCount?: number`, `totalWithSubsessions?: number`
  
  **Alternative approach**:
  - Create new hook: `useTaskSessionProgressWithHierarchy`
  - Keep original hook unchanged
  - New hook internally uses `useTaskSessionHierarchy` and calculates enhanced progress
  
  **Must NOT do**:
  - Do NOT break existing uses of `useTaskSessionProgress`
  - Do NOT change return type structure (only add optional fields)
  
  **Parallelizable**: NO (depends on Task 5)
  
  **References** (CRITICAL - Be Exhaustive):
  
  **Current Implementation**:
  - `apps/dashboard/src/hooks/use-task-session-progress.ts:1-49` - Full current implementation
  - Uses: `task.data.sessions` directly
  - Returns: counts and percentages based on direct sessions only
  
  **Hook References**:
  - `apps/dashboard/src/hooks/use-task-session-hierarchy.ts` - New hook to integrate
  
  **Component References**:
  - Check all files using `useTaskSessionProgress`:
    - `apps/dashboard/src/components/kanban/task-card.tsx`
    - `apps/dashboard/src/routes/tasks/$id.tsx`
    - Any other files importing the hook
  
  **WHY Each Reference Matters**:
  - Current implementation - Understand what to preserve/extend
  - Hierarchy hook - Data source for subsessions
  - Component usages - Ensure backward compatibility
  
  **Acceptance Criteria**:
  
  **Manual Execution Verification:**
  - [ ] Original usage still works (without subsessions)
  - [ ] New usage with `includeSubsessions=true` works
  - [ ] Subsession counts are accurate
  - [ ] Progress percentage includes subsessions when enabled
  - [ ] No regressions in existing UI
  
  **Commit**: YES
  - Message: `feat(dashboard): add subsession support to progress tracking`
  - Files: `apps/dashboard/src/hooks/use-task-session-progress.ts`
  - Pre-commit: `bun run check && bun run typecheck`

---

- [ ] 7. Update Components to Use Session Hierarchy

  **What to do**:
  - Update `apps/dashboard/src/components/kanban/task-card.tsx`:
    - Import and use `useTaskSessionHierarchy`
    - Import and use enhanced `useTaskSessionProgress`
    - Update progress display to show subsession counts
    - Format: "2/5 sessions (8 total with subsessions)" or similar
  - Update `apps/dashboard/src/routes/tasks/$id.tsx`:
    - Import and use `useTaskSessionHierarchy`
    - Import and use enhanced `useTaskSessionProgress`
    - Update sessions card header to show subsession counts
  - Verify progress indicators accurately reflect total work
  
  **Must NOT do**:
  - Do NOT change existing session list displays
  - Do NOT modify session status indicators
  - Do NOT break existing functionality
  
  **Parallelizable**: NO (depends on Task 6)
  
  **References** (CRITICAL - Be Exhaustive):
  
  **Current Implementation**:
  - `apps/dashboard/src/components/kanban/task-card.tsx:106-114` - Current progress usage
  - `apps/dashboard/src/routes/tasks/$id.tsx:99-109` - Current progress usage
  
  **Hook References**:
  - `apps/dashboard/src/hooks/use-task-session-hierarchy.ts` - Hook to use
  - `apps/dashboard/src/hooks/use-task-session-progress.ts` - Enhanced hook to use
  
  **WHY Each Reference Matters**:
  - Current usages - Know what to update
  - New hooks - What to integrate
  
  **Acceptance Criteria**:
  
  **Manual Execution Verification:**
  - [ ] Task card shows accurate subsession counts
  - [ ] Task detail page shows accurate subsession counts
  - [ ] Progress percentages include subsessions
  - [ ] UI clearly distinguishes direct sessions vs total sessions
  - [ ] No duplicate or missing sessions in counts
  
  **Commit**: YES
  - Message: `feat(dashboard): integrate session hierarchy in task displays`
  - Files: `apps/dashboard/src/components/kanban/task-card.tsx`, `apps/dashboard/src/routes/tasks/$id.tsx`
  - Pre-commit: `bun run check && bun run typecheck`

---

- [ ] 8. Cleanup and Final Polish

  **What to do**:
  - Verify all TypeScript types are correct
  - Run linting: `bun run check`
  - Run type checking: `bun run typecheck`
  - Check for any console warnings in browser
  - Verify all imports are used
  - Update any inline comments or documentation
  
  **Must NOT do**:
  - Do NOT make new feature changes
  - Do NOT refactor working code
  
  **Parallelizable**: NO (final task)
  
  **References**:
  - All modified files from previous tasks
  
  **Acceptance Criteria**:
  
  **Manual Execution Verification:**
  - [ ] `bun run typecheck` passes with no errors
  - [ ] `bun run check` passes with no lint errors (or minimal acceptable warnings)
  - [ ] Full user flow works:
    1. Go to `/tasks`
    2. See task card with interventions expandable section
    3. Expand interventions → see details
    4. See subsession counts in progress
    5. Click task → detail page
    6. See interventions expandable section on detail page
    7. See accurate subsession progress counts
  - [ ] No console errors in browser dev tools
  - [ ] No unused imports warnings
  
  **Commit**: YES
  - Message: `chore(dashboard): cleanup task display enhancements`
  - Files: Various cleanup files
  - Pre-commit: `bun run check && bun run typecheck`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `feat(dashboard): add collapsible UI component` | ui/collapsible.tsx (if added) | `bun run check && bun run typecheck` |
| 2 | `feat(dashboard): add expandable interventions component` | expandable-interventions.tsx | `bun run check && bun run typecheck` |
| 3 | `feat(dashboard): add expandable interventions to task cards` | kanban/task-card.tsx | `bun run check && bun run typecheck` |
| 4 | `feat(dashboard): add expandable interventions to task detail page` | routes/tasks/$id.tsx | `bun run check && bun run typecheck` |
| 5 | `feat(dashboard): add task session hierarchy hook` | hooks/use-task-session-hierarchy.ts | `bun run check && bun run typecheck` |
| 6 | `feat(dashboard): add subsession support to progress tracking` | hooks/use-task-session-progress.ts | `bun run check && bun run typecheck` |
| 7 | `feat(dashboard): integrate session hierarchy in task displays` | task-card.tsx, tasks/$id.tsx | `bun run check && bun run typecheck` |
| 8 | `chore(dashboard): cleanup task display enhancements` | Various | `bun run check && bun run typecheck` |

---

## Success Criteria

### Verification Commands
```bash
bun run check      # Expected: no lint errors
bun run typecheck  # Expected: no type errors
bun run dev        # Expected: dev server starts, navigate to /tasks
```

### Final Checklist
- [ ] Collapsible component available
- [ ] Task cards show expandable interventions when items exist
- [ ] Task detail page shows expandable interventions when items exist
- [ ] Interventions show permission + question details
- [ ] Progress tracking includes subsessions
- [ ] Subsession counts displayed accurately
- [ ] Session hierarchy correctly filters to task-relevant sessions
- [ ] No TypeScript errors
- [ ] No lint errors (or minimal acceptable warnings)
- [ ] All existing functionality preserved (drag-and-drop, menus, etc.)
- [ ] No console errors

---

## Notes

### Session Hierarchy Logic
```typescript
// Pseudocode for hierarchy hook:
1. Fetch all opencode sessions for sandbox
2. Build hierarchy tree: buildSessionHierarchy(allSessions)
3. Filter to task-relevant roots:
   taskSessionIds = task.data.sessions.map(s => s.id)
   relevantRoots = hierarchy.filter(node => taskSessionIds.includes(node.session.id))
4. Flatten tree:
   allTaskSessions = flattenHierarchy(relevantRoots)
5. Return: { allSessions: allTaskSessions, rootSessions, isLoading }
```

### Expandable Interventions UI
```
[Collapsed State]
⚠️ 3 actions needed ▼

[Expanded State]
⚠️ 3 actions needed ▲

Permissions:
  • bash: command="rm -rf /tmp/cache" (session: abc123)
  • edit_file: path="/src/index.ts" (session: abc123)

Questions:
  • "Should I proceed with database migration?" (session: def456)
```

### Progress Display Enhancement
```
Before: 2/5 sessions (40%)
After:  2/5 sessions (8 total with subsessions) (40%)
```
