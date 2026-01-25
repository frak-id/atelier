# Learnings - Task Display Redesign

## Conventions & Patterns

## 2026-01-25 - Task 1: Create Task Detail Page

### Implementation Approach
- Delegation system failed repeatedly (all attempts returned 0s duration errors)
- Implemented directly following patterns from `sandboxes/$id.tsx` and `task-detail-dialog.tsx`
- Created `/apps/dashboard/src/routes/tasks/$id.tsx`

### TypeScript Issues Encountered
- `useSuspenseQuery` return type includes `null` in TypeScript
- Required non-null assertions (`task!`) throughout the component
- TanStack Router type errors expected until dev server runs and generates route types

### Pattern Followed
1. Route export with `createFileRoute`, `loader`, `pendingComponent`
2. Component using `useSuspenseQuery` for task data
3. Header with back button, title, status badge, action buttons
4. Cards for: Description, Git Status, Sessions Progress, Secondary Templates, Metadata
5. Helper components: TaskSessionRow, CopySshButton, SecondaryTemplateButton

### Lint Warnings
- Biome flags non-null assertions as style violations
- These are necessary due to TypeScript's conservative null checking
- Will be resolved when TanStack Router generates proper types

### Next Steps
- Run dev server to generate route types
- Verify page loads correctly
- Then proceed to Task 2 (wire navigation)

## Task 2: Wire Navigation

### Changes Made
1. Removed `TaskDetailDialog` import from `tasks/index.tsx`
2. Removed `viewingTask` state
3. Changed `handleViewTask` to use `navigate({ to: "/tasks/$id", params: { id: task.id } })`
4. Removed `TaskDetailDialog` component usage

### TypeScript Errors (Expected)
- Route type `/tasks/$id` not in generated types yet
- Will be resolved when dev server runs and generates route types

### Next Step
- Update TaskCard component to use Link for navigation
