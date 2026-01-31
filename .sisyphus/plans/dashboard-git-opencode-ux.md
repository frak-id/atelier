# Dashboard Git + OpenCode Integration UX Overhaul

## TL;DR

> **Quick Summary**: Overhaul the dashboard to support inline permission/question answering, rich git operations (diff/commit/push), redesigned session hierarchy display, and session activity on sandbox cards. Spans agent → manager → dashboard layers.
> 
> **Deliverables**:
> - Inline permission approve/deny and question answering directly in dashboard UI
> - New git endpoints (diff-stat, commit, push) on agent + manager
> - Expandable file-level diff list with commit/push form in drawers
> - Dirty/unpushed git badges on task cards and sandbox cards
> - Redesigned accordion-based session hierarchy tree
> - Session/activity info in sandbox drawer and sandbox cards
> 
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: Task 1 → Task 4 → Task 7 → Task 10

---

## Context

### Original Request
Improve the git and opencode integration UX/UI on the dashboard. The current state has poor readability for session hierarchies, no inline intervention answering (must open OpenCode TUI), minimal git info (only branch name on task cards, basic status in sandbox drawer), and no session activity on sandbox cards.

### Interview Summary
**Key Decisions**:
- Oracle recommended: Option C for interventions (inline buttons for permissions, expandable forms for questions), accordion tree for sessions, manager→agent routing for git, single activity row for sandbox cards
- Metis identified: Drop "always" permission in v1, safety-limit git diff output, no syntax-highlighted diff viewer, no git pull/branch ops/merge, 4 independent work streams

**Research Findings**:
- OpenCode SDK v2 confirmed: `client.permission.reply({requestID, reply})`, `client.question.reply({requestID, answers})`, `client.question.reject({requestID})`, `client.session.abort({sessionID})`
- Agent has no dedicated git routes — uses generic `/exec` endpoint. New operations follow existing `AgentOperations` pattern (batchExec + parse output)
- Manager has only `GET /api/sandboxes/:id/git/status`. New POST endpoints needed for diff/commit/push
- Dashboard uses TanStack Query with 5s refetch + OpenCode SSE events for real-time cache invalidation
- Session hierarchy builder exists in `lib/session-hierarchy.ts` — reusable for sandbox drawer
- Git auth: SSH keys injected during provisioning, credential helper configured in `.gitconfig`

### Metis Review
**Identified Gaps** (addressed):
- Git push auth validation: Added preflight check in commit/push flow
- Race condition on permission expiry: Handle 404/gone errors gracefully with toast
- Large diff buffer overflow: Use `git diff --stat | head -200` safety valve
- Scope creep on diff viewer: Locked to file list + raw monospace, no syntax highlighting
- "Always" permission complexity: Deferred to v2, v1 has "Allow Once" and "Deny" only

---

## Work Objectives

### Core Objective
Transform the dashboard from a passive monitoring tool into an active control surface for AI coding agents — enabling inline intervention responses, git operations, and rich session visibility without leaving the dashboard.

### Concrete Deliverables
- `apps/dashboard/src/api/opencode.ts` — New reply/reject wrapper functions
- `apps/dashboard/src/api/queries/opencode.ts` — New TanStack mutations for permission/question replies
- `apps/manager/src/infrastructure/agent/agent.operations.ts` — New `gitDiffStat()`, `gitCommit()`, `gitPush()` methods
- `apps/manager/src/api/sandbox.routes.ts` — New POST endpoints for git operations
- `apps/manager/src/schemas/sandbox.ts` — New TypeBox schemas for git operations
- `apps/dashboard/src/components/expandable-interventions.tsx` — Inline action buttons + question forms
- `apps/dashboard/src/components/task-session-hierarchy.tsx` — Accordion redesign with summary headers
- `apps/dashboard/src/components/sandbox-drawer.tsx` — New Sessions tab + enhanced Repositories tab
- `apps/dashboard/src/components/sandbox-card.tsx` — Activity row
- `apps/dashboard/src/components/kanban/task-card.tsx` — Git dirty/unpushed badges

### Definition of Done
- [ ] Permissions can be approved/denied inline without opening OpenCode TUI
- [ ] Questions can be answered (option selection + freetext) inline
- [ ] Git file diff list visible in sandbox drawer per repo
- [ ] Commit + push actions work from sandbox drawer
- [ ] Dirty/unpushed badges visible on task cards
- [ ] Session hierarchy is accordion-based with summary headers
- [ ] Sandbox drawer has Sessions tab showing hierarchy
- [ ] Sandbox cards show session activity summary
- [ ] `bun run check` passes
- [ ] `bun run typecheck` passes

### Must Have
- Inline permission approve/deny (Allow Once / Deny)
- Inline question answering with option selection and optional freetext
- Git diff file list (filepath, additions, deletions)
- Git commit with message input
- Git push
- Accordion session hierarchy with summary headers
- Sessions tab in sandbox drawer
- Activity row on sandbox cards

### Must NOT Have (Guardrails)
- No syntax-highlighted diff viewer — raw monospace text only
- No multi-file selective staging — commit is all-or-nothing (`git add -A`)
- No branch switching, creation, or deletion
- No git merge, rebase, or stash
- No git pull (adds conflict resolution complexity)
- No "Always Allow" permission reply (defer to v2)
- No session message sending from hierarchy tree
- No drag-and-drop session reordering
- No inline diff line-by-line view
- No chat/conversation UI for sessions

---

## Verification Strategy

### Test Decision
- **Infrastructure exists**: NO (no test framework configured)
- **User wants tests**: NO
- **QA approach**: Manual verification via dev server + automated Playwright checks

### Verification Approach
Each TODO includes executable verification procedures using:
- `bun run check` and `bun run typecheck` for lint/type safety
- `curl` commands for API endpoint verification
- Playwright browser automation for UI verification
- Dev server at `http://localhost:5173` (Vite dashboard)

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — Backend + SDK wrappers):
├── Task 1: OpenCode SDK reply wrappers + mutations
├── Task 2: Agent git operations (diffStat, commit, push)
└── Task 3: Manager git proxy endpoints

Wave 2 (After Wave 1 — UI Components):
├── Task 4: Inline intervention actions UI
├── Task 5: Session hierarchy accordion redesign
└── Task 6: Git diff/commit/push UI in sandbox drawer

Wave 3 (After Wave 2 — Integration):
├── Task 7: Wire interventions into task drawer + task cards
├── Task 8: Sessions tab in sandbox drawer
└── Task 9: Sandbox card activity row + git badges on task cards

Wave 4 (After Wave 3 — Polish):
└── Task 10: Cross-cutting polish, edge cases, error handling

Critical Path: Task 1 → Task 4 → Task 7 → Task 10
Parallel Speedup: ~50% faster than sequential
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 4, 7 | 2, 3 |
| 2 | None | 6 | 1, 3 |
| 3 | None | 6 | 1, 2 |
| 4 | 1 | 7 | 5, 6 |
| 5 | None | 7, 8 | 4, 6 |
| 6 | 2, 3 | 9 | 4, 5 |
| 7 | 4, 5 | 10 | 8, 9 |
| 8 | 5 | 10 | 7, 9 |
| 9 | 6 | 10 | 7, 8 |
| 10 | 7, 8, 9 | None | None (final) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1, 2, 3 | 3x `delegate_task(category="quick", load_skills=[], run_in_background=true)` |
| 2 | 4, 5, 6 | 3x `delegate_task(category="visual-engineering", load_skills=["frontend-ui-ux"], run_in_background=true)` |
| 3 | 7, 8, 9 | 3x `delegate_task(category="visual-engineering", load_skills=["frontend-ui-ux"], run_in_background=true)` |
| 4 | 10 | 1x `delegate_task(category="unspecified-low", load_skills=[], run_in_background=false)` |

---

## TODOs

- [ ] 1. OpenCode SDK Reply Wrappers + TanStack Mutations

  **What to do**:
  - Add `replyPermission(baseUrl, requestID, reply)` function to `apps/dashboard/src/api/opencode.ts`
    - Uses `createOpencodeClient({baseUrl}).permission.reply({requestID, reply})` where reply is `"once" | "reject"`
  - Add `replyQuestion(baseUrl, requestID, answers)` function
    - Uses `client.question.reply({requestID, answers})` where answers is `Array<QuestionAnswer>` (each `QuestionAnswer` is `Array<string>`)
  - Add `rejectQuestion(baseUrl, requestID)` function
    - Uses `client.question.reject({requestID})`
  - Add `abortSession(baseUrl, sessionID)` function
    - Uses `client.session.abort({sessionID})`
  - Add TanStack Query mutations in `apps/dashboard/src/api/queries/opencode.ts`:
    - `useReplyPermission(opencodeUrl)` — calls `replyPermission()`, invalidates `queryKeys.opencode.permissions(opencodeUrl)` on success
    - `useReplyQuestion(opencodeUrl)` — calls `replyQuestion()`, invalidates `queryKeys.opencode.questions(opencodeUrl)` on success
    - `useRejectQuestion(opencodeUrl)` — calls `rejectQuestion()`, invalidates `queryKeys.opencode.questions(opencodeUrl)` on success
    - `useAbortSession(opencodeUrl)` — calls `abortSession()`, invalidates `queryKeys.opencode.sessions(opencodeUrl)` and `queryKeys.opencode.sessionStatuses(opencodeUrl)` on success

  **Must NOT do**:
  - Do NOT add "always" reply option — v1 only supports "once" and "reject"
  - Do NOT proxy through manager — SDK calls go directly to OpenCode baseUrl (dashboard already reaches it for sessions/permissions/questions)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Pure function additions + mutation boilerplate, follows existing patterns exactly
  - **Skills**: `[]`
    - No special skills needed — straightforward TypeScript
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: No UI work in this task

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 3)
  - **Blocks**: Tasks 4, 7
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/api/opencode.ts:14-26` — Existing `fetchOpenCodeSessions()` pattern: create client, call method, handle errors, return data. Follow this exact pattern for new functions.
  - `apps/dashboard/src/api/opencode.ts:115-137` — `fetchOpenCodePermissions()` and `fetchOpenCodeQuestions()` — these are the read-side; new functions are the write-side.
  - `apps/dashboard/src/api/queries/opencode.ts` — Existing query definitions. Add mutations following the same file structure.
  - `apps/dashboard/src/api/queries/task.ts` — Example TanStack mutations with `useMutation`, `onSuccess` invalidation. Follow this pattern for new mutations.

  **API/Type References**:
  - `node_modules/.bun/@opencode-ai+sdk@1.1.44/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts` — SDK client class. `permission.reply({requestID, reply, directory?, message?})`, `question.reply({requestID, answers, directory?})`, `question.reject({requestID, directory?})`, `session.abort({sessionID, directory?})`
  - `node_modules/.bun/@opencode-ai+sdk@1.1.44/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` — Types: `PermissionRequest`, `QuestionRequest`, `QuestionInfo`, `QuestionOption`, `QuestionAnswer = Array<string>`
  - `apps/dashboard/src/api/queries/keys.ts` — Query key factory. Use `queryKeys.opencode.permissions(url)`, `queryKeys.opencode.questions(url)`, `queryKeys.opencode.sessions(url)` for invalidation.

  **WHY Each Reference Matters**:
  - `opencode.ts` functions: Follow the exact error handling pattern (try/catch, return empty/false on error) for consistency
  - `queries/task.ts` mutations: Shows the `useMutation` + `queryClient.invalidateQueries` pattern used throughout the app
  - SDK types: Need exact parameter shapes to build correct function signatures
  - Query keys: Must invalidate the right cache entries so UI updates immediately after actions

  **Acceptance Criteria**:

  ```bash
  # Verify TypeScript compiles
  bun run typecheck
  # Assert: Exit code 0, no errors in dashboard package

  # Verify lint passes
  bun run check
  # Assert: Exit code 0
  ```

  ```bash
  # Verify new functions exist and are exported
  bun -e "import { replyPermission, replyQuestion, rejectQuestion, abortSession } from './apps/dashboard/src/api/opencode.ts'; console.log('exports OK')"
  # Assert: Output "exports OK"
  ```

  **Evidence to Capture:**
  - [ ] Terminal output from typecheck and lint commands

  **Commit**: YES
  - Message: `feat(dashboard): add OpenCode SDK reply wrappers and TanStack mutations`
  - Files: `apps/dashboard/src/api/opencode.ts`, `apps/dashboard/src/api/queries/opencode.ts`
  - Pre-commit: `bun run typecheck`

---

- [ ] 2. Agent Git Operations (diffStat, commit, push)

  **What to do**:
  - Add `gitDiffStat()` method to `apps/manager/src/infrastructure/agent/agent.operations.ts`:
    - Takes `sandboxId: string`, `repos: {clonePath: string}[]`
    - For each repo, executes via `batchExec`:
      ```bash
      su - dev -c 'cd /home/dev{clonePath} && git diff --numstat HEAD 2>/dev/null | head -200'
      ```
    - Parses output: each line is `added\tremoved\tfilepath` (tab-separated)
    - Also includes staged changes: `git diff --numstat --cached HEAD 2>/dev/null | head -200`
    - Returns `{ repos: Array<{ path: string, files: Array<{ filepath: string, added: number, removed: number }> }> }`
    - For untracked files, add: `git ls-files --others --exclude-standard 2>/dev/null | head -100` and mark them as fully new
  - Add `gitCommit()` method:
    - Takes `sandboxId: string`, `repoPath: string`, `message: string`
    - Executes via `exec`: `su - dev -c 'cd /home/dev{repoPath} && git add -A && git commit -m "{escaped_message}"'`
    - Escape single quotes in message: replace `'` with `'\''`
    - Returns `{ success: boolean, commitHash?: string, error?: string }`
    - On success, extract commit hash: `git rev-parse --short HEAD`
  - Add `gitPush()` method:
    - Takes `sandboxId: string`, `repoPath: string`
    - Executes via `exec` with 30s timeout: `su - dev -c 'cd /home/dev{repoPath} && git push 2>&1'`
    - If push fails with "no upstream", try: `git push --set-upstream origin $(git branch --show-current) 2>&1`
    - Returns `{ success: boolean, output?: string, error?: string }`
  - Add types to `apps/manager/src/infrastructure/agent/agent.types.ts`:
    - `GitDiffFile`, `GitDiffRepo`, `GitDiffResult`, `GitCommitResult`, `GitPushResult`

  **Must NOT do**:
  - Do NOT add dedicated agent-side routes — use existing `/exec` and `/exec/batch` via `AgentClient`
  - Do NOT add `git pull`, `git stash`, `git merge`, or branch operations
  - Do NOT allow selective file staging — always `git add -A`

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Adding methods to existing class, follows established pattern
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: Backend-only task

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 3)
  - **Blocks**: Task 6
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `apps/manager/src/infrastructure/agent/agent.operations.ts:67-146` — Existing `gitStatus()` method. This is THE pattern to follow: construct shell script strings, call `batchExec()`, parse stdout lines with split/trim. New methods must follow this exact structure.
  - `apps/manager/src/infrastructure/agent/agent.operations.ts:30-65` — `batchHealth()` pattern for parallel operations across multiple repos.
  - `apps/manager/src/infrastructure/agent/agent.client.ts:45-75` — `exec()` method with timeout parameter. Use for single-repo operations (commit, push).

  **API/Type References**:
  - `apps/manager/src/infrastructure/agent/agent.types.ts` — Existing types: `GitRepoStatus`, `GitStatus`. Add new types alongside these.
  - `apps/manager/src/infrastructure/agent/agent.client.ts` — `AgentClient.exec(sandboxId, command, {timeout?})` and `AgentClient.batchExec(sandboxId, commands[])` signatures.

  **WHY Each Reference Matters**:
  - `gitStatus()` method: Shows exact pattern for shell command construction, `su - dev -c` wrapper, output parsing, error handling per-repo
  - `agent.client.ts`: Shows how to set longer timeouts for slow operations (push needs 30s)
  - `agent.types.ts`: Maintain type co-location with existing git types

  **Acceptance Criteria**:

  ```bash
  # Verify TypeScript compiles
  bun run typecheck
  # Assert: Exit code 0

  # Verify lint passes
  bun run check
  # Assert: Exit code 0
  ```

  **Evidence to Capture:**
  - [ ] Terminal output from typecheck

  **Commit**: YES
  - Message: `feat(manager): add git diffStat, commit, and push agent operations`
  - Files: `apps/manager/src/infrastructure/agent/agent.operations.ts`, `apps/manager/src/infrastructure/agent/agent.types.ts`
  - Pre-commit: `bun run typecheck`

---

- [ ] 3. Manager Git Proxy Endpoints

  **What to do**:
  - Add three new endpoints to `apps/manager/src/api/sandbox.routes.ts`:
  
  **GET `/:id/git/diff`**:
  - Requires sandbox to be running
  - Gets workspace config for repo list
  - Calls `agentOperations.gitDiffStat(sandbox.id, repos)`
  - Returns `{ repos: Array<{ path, files: Array<{ filepath, added, removed }> }> }`
  
  **POST `/:id/git/commit`**:
  - Body: `{ repoPath: string, message: string }`
  - Validates `repoPath` is in workspace repos list
  - Calls `agentOperations.gitCommit(sandbox.id, repoPath, message)`
  - Returns `{ success, commitHash?, error? }`
  - On success, also invalidates git status cache if applicable
  
  **POST `/:id/git/push`**:
  - Body: `{ repoPath: string }`
  - Validates `repoPath` is in workspace repos list
  - Calls `agentOperations.gitPush(sandbox.id, repoPath)`
  - Returns `{ success, output?, error? }`

  - Add TypeBox schemas to `apps/manager/src/schemas/sandbox.ts`:
    - `GitDiffResponseSchema` — response for diff endpoint
    - `GitCommitBodySchema` — `{ repoPath: t.String(), message: t.String({ minLength: 1 }) }`
    - `GitCommitResponseSchema` — `{ success: t.Boolean(), commitHash: t.Optional(t.String()), error: t.Optional(t.String()) }`
    - `GitPushBodySchema` — `{ repoPath: t.String() }`
    - `GitPushResponseSchema` — `{ success: t.Boolean(), output: t.Optional(t.String()), error: t.Optional(t.String()) }`

  **Must NOT do**:
  - Do NOT expose raw shell command execution — only structured git operations
  - Do NOT add git pull, merge, or branch endpoints

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Route + schema boilerplate following existing patterns exactly
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: Backend-only task

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 1, 2)
  - **Blocks**: Task 6
  - **Blocked By**: None (can stub with TODO if Task 2 not complete)

  **References**:

  **Pattern References**:
  - `apps/manager/src/api/sandbox.routes.ts:245-258` — Existing `GET /:id/git/status` endpoint. Follow this EXACT pattern: check sandbox exists, check workspace has repos, call agentOperations method, return result.
  - `apps/manager/src/api/sandbox.routes.ts:200-244` — Dev command start/stop endpoints (POST patterns). Follow for commit/push POST handlers.

  **API/Type References**:
  - `apps/manager/src/schemas/sandbox.ts:177-198` — Existing `GitStatusResponseSchema` and `RepoGitStatusSchema`. Add new schemas alongside.
  - `apps/manager/src/container.ts` — `agentOperations` import. Already available in sandbox routes.

  **WHY Each Reference Matters**:
  - Git status endpoint: Shows the exact middleware chain (auth → sandbox lookup → workspace lookup → agent call → response)
  - Dev command endpoints: Shows POST pattern with body validation and TypeBox schemas
  - Container: Confirms `agentOperations` is already wired and importable

  **Acceptance Criteria**:

  ```bash
  # Verify TypeScript compiles
  bun run typecheck
  # Assert: Exit code 0

  # Verify lint passes
  bun run check
  # Assert: Exit code 0
  ```

  **Evidence to Capture:**
  - [ ] Terminal output from typecheck

  **Commit**: YES
  - Message: `feat(manager): add git diff, commit, and push API endpoints`
  - Files: `apps/manager/src/api/sandbox.routes.ts`, `apps/manager/src/schemas/sandbox.ts`
  - Pre-commit: `bun run typecheck`

---

- [ ] 4. Inline Intervention Actions UI

  **What to do**:
  - Redesign `apps/dashboard/src/components/expandable-interventions.tsx` to support inline actions:
  
  **Permission Items** — Add action buttons directly in each permission row:
  - "Allow Once" button (primary/small) → calls `useReplyPermission` with `reply: "once"`
  - "Deny" button (destructive/small) → calls `useReplyPermission` with `reply: "reject"`
  - Show loading spinner on the clicked button while mutation is pending
  - On success: toast "Permission approved" / "Permission denied", item disappears on refetch
  - On error (404/gone): toast "Permission request expired", invalidate cache
  
  **Question Items** — Expandable inline form:
  - Each question row is clickable to expand
  - Expanded area shows for each `QuestionInfo` in `questions` array:
    - The `question` text as a label
    - Radio buttons for `options` array (if `!multiple`) or checkboxes (if `multiple`)
    - Each option shows `label` as button text, `description` as help text below
    - If `custom` is true (default), show a text input at the bottom labeled "Or type your answer"
    - Submit button → calls `useReplyQuestion` with `answers` array (one `QuestionAnswer` per `QuestionInfo`)
    - "Skip" button → calls `useRejectQuestion`
  - Show loading state while mutation pending
  - On success: toast, item disappears
  - On error: toast with error message

  - The component needs `opencodeUrl` as a new prop (needed for mutations)
  - Update all call sites to pass `opencodeUrl`

  **Must NOT do**:
  - Do NOT add "Always Allow" option
  - Do NOT allow editing question text
  - Do NOT build a separate panel/dialog — everything is inline in the existing intervention area

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Interactive UI with forms, buttons, loading states, conditional rendering
  - **Skills**: `["frontend-ui-ux"]`
    - `frontend-ui-ux`: Complex interactive component with multiple states and form handling
  - **Skills Evaluated but Omitted**:
    - `playwright`: Not needed for building, only for verification

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 5, 6)
  - **Blocks**: Task 7
  - **Blocked By**: Task 1 (needs mutations)

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/components/expandable-interventions.tsx:1-159` — THE file to modify. Current structure: Collapsible with permission rows and question rows. Add action buttons to each row.
  - `apps/dashboard/src/components/kanban/task-card.tsx:318-361` — `TaskSessionsStatus` component shows how `ExpandableInterventions` is currently used with `aggregatedInteraction` data.
  - `apps/dashboard/src/components/task-drawer.tsx:384-390` — Another call site for `ExpandableInterventions`.

  **API/Type References**:
  - `node_modules/.bun/@opencode-ai+sdk@1.1.44/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts` — `QuestionRequest.questions: Array<QuestionInfo>`, `QuestionInfo.options: Array<QuestionOption>`, `QuestionInfo.custom?: boolean`, `QuestionInfo.multiple?: boolean`, `QuestionOption.label: string`, `QuestionOption.description: string`
  - From Task 1 outputs: `useReplyPermission(opencodeUrl)`, `useReplyQuestion(opencodeUrl)`, `useRejectQuestion(opencodeUrl)` mutation hooks

  **External References**:
  - shadcn/ui RadioGroup: Already available via Radix in the project's UI components

  **WHY Each Reference Matters**:
  - `expandable-interventions.tsx`: This IS the file being modified — understand its current Collapsible + badge structure
  - `task-card.tsx:318-361`: Shows how `ExpandableInterventions` receives data — new `opencodeUrl` prop needs to flow from here
  - SDK types: Exact shape of `QuestionInfo` determines the form UI (radio vs checkbox, freetext field)

  **Acceptance Criteria**:

  ```bash
  # Verify TypeScript compiles
  bun run typecheck
  # Assert: Exit code 0

  # Verify lint passes  
  bun run check
  # Assert: Exit code 0
  ```

  ```
  # Playwright verification:
  1. Navigate to dashboard with an active task that has pending permissions
  2. Find the amber "actions needed" section
  3. Assert: "Allow Once" and "Deny" buttons visible next to each permission
  4. Click "Allow Once" on a permission
  5. Assert: Button shows loading spinner
  6. Assert: Toast notification appears
  7. Assert: Permission count decreases
  ```

  **Evidence to Capture:**
  - [ ] Terminal output from typecheck
  - [ ] Screenshot of inline permission buttons
  - [ ] Screenshot of expanded question form

  **Commit**: YES
  - Message: `feat(dashboard): add inline permission/question answering in interventions`
  - Files: `apps/dashboard/src/components/expandable-interventions.tsx`, call sites that pass `opencodeUrl`
  - Pre-commit: `bun run typecheck`

---

- [ ] 5. Session Hierarchy Accordion Redesign

  **What to do**:
  - Redesign `apps/dashboard/src/components/task-session-hierarchy.tsx` as an accordion-based tree:
  
  **Root Session Headers** (always visible):
  - Each root session gets a summary header row showing:
    - Expand/collapse chevron
    - Status icon (spinning blue = busy, amber clock = idle, green check = done)
    - Session name/template ID
    - Summary badges: `{N} sub-sessions` | `{N} working` | `⚠️ {N} need attention` | `{completed}/{total} tasks`
    - "Open in OpenCode" link icon
  - Collapsed by default for idle/done sessions
  - Auto-expanded for sessions that need attention (have pending permissions/questions)
  - Auto-expanded for sessions that are busy

  **Expanded Children**:
  - Indented child session rows (current pattern but cleaner)
  - Each child shows: status icon, short ID, current todo text (if in_progress), status badge
  - Inline intervention actions (from Task 4) appear directly under the relevant session node
  - Todos are shown as a compact expandable list under each session (existing `ExpandableTodoList`)

  **Extract reusable component**:
  - Create `apps/dashboard/src/components/session-hierarchy.tsx` — generic component that takes hierarchy + interactions + opencodeUrl
  - `TaskSessionHierarchy` becomes a thin wrapper that filters by task sessions
  - New component is reusable in sandbox drawer (Task 8)

  **Must NOT do**:
  - Do NOT add session deletion from the tree
  - Do NOT add message sending from the tree
  - Do NOT add drag-and-drop reordering

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Complex tree UI with accordion behavior, summary computation, auto-expand logic
  - **Skills**: `["frontend-ui-ux"]`
    - `frontend-ui-ux`: Needs good visual hierarchy, readable at-a-glance summaries
  - **Skills Evaluated but Omitted**:
    - `playwright`: Not needed for building

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 6)
  - **Blocks**: Tasks 7, 8
  - **Blocked By**: None (can use existing data structures)

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/components/task-session-hierarchy.tsx:1-211` — Current implementation to redesign. Understand the recursive `TaskSessionNode` component and `TaskSessionHierarchy` wrapper.
  - `apps/dashboard/src/components/expandable-todo-list.tsx` — Existing todo list component, already used in session nodes. Keep using this.
  - `apps/dashboard/src/components/session-status-indicator.tsx` — Existing status badge component. Keep using this.
  - `apps/dashboard/src/components/ui/collapsible.tsx` — shadcn Collapsible component for accordion behavior.

  **API/Type References**:
  - `apps/dashboard/src/lib/session-hierarchy.ts` — `SessionNode`, `SessionWithSandboxInfo`, `buildSessionHierarchy()`, `flattenHierarchy()`, `countSubSessions()` — all the tree data structures.
  - `apps/dashboard/src/hooks/use-task-session-progress.ts:22-28` — `SessionInteractionState` type with `sessionId`, `status`, `pendingPermissions`, `pendingQuestions`, `todos`.

  **WHY Each Reference Matters**:
  - Current `task-session-hierarchy.tsx`: Must understand the recursive rendering and data flow to refactor without breaking
  - `session-hierarchy.ts`: These utility functions remain unchanged — the redesign is purely visual
  - `SessionInteractionState`: Drives the summary badges (count permissions, count questions, check status)

  **Acceptance Criteria**:

  ```bash
  bun run typecheck
  # Assert: Exit code 0

  bun run check
  # Assert: Exit code 0
  ```

  ```
  # Playwright verification:
  1. Open task drawer for an active task with sessions
  2. Assert: Root session headers visible with summary badges
  3. Assert: Sessions needing attention are auto-expanded
  4. Assert: Idle sessions are collapsed
  5. Click collapsed session header
  6. Assert: Children expand with indentation
  7. Assert: Todo list visible under active sessions
  ```

  **Evidence to Capture:**
  - [ ] Screenshot of accordion hierarchy with summary headers
  - [ ] Screenshot of expanded session showing children + todos

  **Commit**: YES
  - Message: `feat(dashboard): redesign session hierarchy as accordion with summary headers`
  - Files: `apps/dashboard/src/components/session-hierarchy.tsx` (new), `apps/dashboard/src/components/task-session-hierarchy.tsx` (refactored to use new component)
  - Pre-commit: `bun run typecheck`

---

- [ ] 6. Git Diff/Commit/Push UI in Sandbox Drawer

  **What to do**:
  - Enhance the `RepositoriesTab` in `apps/dashboard/src/components/sandbox-drawer.tsx`:
  
  **Add TanStack Query hooks** in `apps/dashboard/src/api/queries/sandbox.ts`:
  - `sandboxGitDiffQuery(sandboxId)` — fetches `GET /api/sandboxes/:id/git/diff`
  - `useGitCommit(sandboxId)` — mutation for `POST /api/sandboxes/:id/git/commit`
  - `useGitPush(sandboxId)` — mutation for `POST /api/sandboxes/:id/git/push`
  - Both mutations invalidate `sandboxGitStatusQuery` and `sandboxGitDiffQuery` on success

  **Expandable Repo Rows**:
  - Each repo row in `RepositoriesTab` becomes expandable (click to expand)
  - When expanded, fetch and show git diff:
    - File list: each file as a row with `filepath`, `+{added}` (green), `-{removed}` (red)
    - Untracked files shown with "new" badge
    - If no changes: "Working tree clean" message
  - Diff is fetched on-demand (NOT polled) — only when user expands a repo

  **Commit Form** (shown when repo is dirty):
  - Text input for commit message (required, placeholder: "Commit message...")
  - Three action buttons:
    - "Commit" — commits only, `useGitCommit`
    - "Push" — pushes only (for already committed but unpushed), `useGitPush`
    - "Commit & Push" — commits then pushes sequentially
  - Loading states on buttons during mutations
  - Success/error toasts
  - After successful commit: refetch diff (should show empty)
  - After successful push: refetch git status (ahead count should decrease)

  **Must NOT do**:
  - Do NOT add line-level diff viewer
  - Do NOT add selective file staging
  - Do NOT add syntax highlighting to diff
  - Do NOT poll git diff — fetch on-demand only

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Interactive UI with expandable sections, forms, mutation chaining
  - **Skills**: `["frontend-ui-ux"]`
    - `frontend-ui-ux`: File diff display layout, commit form UX
  - **Skills Evaluated but Omitted**:
    - `playwright`: Not needed for building

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 4, 5)
  - **Blocks**: Task 9
  - **Blocked By**: Tasks 2, 3 (needs API endpoints)

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/components/sandbox-drawer.tsx:604-703` — Current `RepositoriesTab` component. This is THE component to enhance. Shows existing repo rows with git status badges.
  - `apps/dashboard/src/api/queries/sandbox.ts` — Existing sandbox queries and mutations. Add new git queries/mutations here following the same patterns.
  - `apps/dashboard/src/components/dev-commands-panel.tsx` — Example of expandable sections with action buttons in sandbox drawer. Good pattern reference for the expand/collapse + action buttons.

  **API/Type References**:
  - From Task 3: `GET /api/sandboxes/:id/git/diff`, `POST /api/sandboxes/:id/git/commit`, `POST /api/sandboxes/:id/git/push` endpoint signatures and response shapes.
  - `apps/dashboard/src/api/client.ts` — Elysia Eden Treaty client. New endpoints auto-available via type inference.

  **WHY Each Reference Matters**:
  - `RepositoriesTab`: The exact component to enhance — understand its current data fetching and rendering
  - `sandbox.ts` queries: Follow exact patterns for new query options + mutations
  - `dev-commands-panel.tsx`: Shows a clean expandable section pattern already used in the same drawer

  **Acceptance Criteria**:

  ```bash
  bun run typecheck
  # Assert: Exit code 0

  bun run check
  # Assert: Exit code 0
  ```

  ```
  # Playwright verification:
  1. Open sandbox drawer for a running sandbox with dirty repos
  2. Navigate to Repositories tab
  3. Click on a dirty repo row
  4. Assert: File diff list appears with filepath, +added, -removed
  5. Assert: Commit form visible with message input
  6. Type commit message, click "Commit"
  7. Assert: Loading state, then success toast
  8. Assert: Dirty badge disappears after refetch
  ```

  **Evidence to Capture:**
  - [ ] Screenshot of expanded repo with file diff list
  - [ ] Screenshot of commit form

  **Commit**: YES
  - Message: `feat(dashboard): add git diff viewer and commit/push UI in sandbox drawer`
  - Files: `apps/dashboard/src/components/sandbox-drawer.tsx`, `apps/dashboard/src/api/queries/sandbox.ts`
  - Pre-commit: `bun run typecheck`

---

- [ ] 7. Wire Interventions into Task Drawer + Task Cards

  **What to do**:
  - Update `apps/dashboard/src/components/task-drawer.tsx`:
    - Pass `opencodeUrl` to `ExpandableInterventions` (line 384-390)
    - The inline action buttons from Task 4 now work in context

  - Update `apps/dashboard/src/components/kanban/task-card.tsx`:
    - Pass `opencodeUrl` to `ExpandableInterventions` in `TaskSessionsStatus` (line 354-358)
    - The inline action buttons work directly on kanban cards
    - Consider: for task cards, keep interventions compact — show only "Allow Once" / "Deny" for permissions, and "Answer in Drawer" link for questions (cards are too small for full question forms)

  - Update `apps/dashboard/src/components/task-session-hierarchy.tsx` (now using redesigned component from Task 5):
    - Pass `opencodeUrl` to intervention components within session nodes
    - Interventions appear inline under the relevant session in the hierarchy

  - Add git dirty/branch badges to task cards:
    - In `TaskCard`, if task has `sandboxId`, fetch `sandboxGitStatusQuery` (already exists)
    - Show small badges: 🔴 "dirty" if any repo is dirty, "↑{N}" if any repo has ahead > 0
    - Position: next to the existing branch name

  **Must NOT do**:
  - Do NOT add full question forms to task cards — too small, link to drawer instead
  - Do NOT add commit/push to task cards — that belongs in the sandbox drawer

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Wiring components together, prop threading, conditional rendering
  - **Skills**: `["frontend-ui-ux"]`
    - `frontend-ui-ux`: Needs taste for information density on small cards
  - **Skills Evaluated but Omitted**:
    - `playwright`: Not needed for building

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 8, 9)
  - **Blocks**: Task 10
  - **Blocked By**: Tasks 4, 5

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/components/task-drawer.tsx:384-390` — Current `ExpandableInterventions` usage. Add `opencodeUrl` prop.
  - `apps/dashboard/src/components/kanban/task-card.tsx:318-361` — `TaskSessionsStatus` with `ExpandableInterventions`. Add `opencodeUrl` prop and simplify question display for cards.
  - `apps/dashboard/src/components/kanban/task-card.tsx:143-150` — Existing branch badge on task card. Add git status badges alongside.

  **API/Type References**:
  - `apps/dashboard/src/api/queries/sandbox.ts` — `sandboxGitStatusQuery(sandboxId)` already exists. Reuse for task card git badges.
  - `apps/dashboard/src/hooks/use-task-session-progress.ts` — Already provides `aggregatedInteraction` with `pendingPermissions` and `pendingQuestions`.

  **WHY Each Reference Matters**:
  - Task drawer line 384-390: Exact call site to update with new `opencodeUrl` prop
  - Task card line 318-361: Shows the intervention component within card context — must stay compact
  - Task card line 143-150: Where to add git status badges — consistent visual placement

  **Acceptance Criteria**:

  ```bash
  bun run typecheck
  # Assert: Exit code 0

  bun run check
  # Assert: Exit code 0
  ```

  ```
  # Playwright verification:
  1. Open dashboard with active tasks
  2. Find a task card with pending permissions
  3. Assert: "Allow Once" / "Deny" buttons visible on card
  4. Click "Allow Once"
  5. Assert: Permission handled, count decreases
  6. Find a task card with dirty git
  7. Assert: Red "dirty" badge visible next to branch name
  ```

  **Evidence to Capture:**
  - [ ] Screenshot of task card with inline permission buttons
  - [ ] Screenshot of task card with git dirty badge

  **Commit**: YES
  - Message: `feat(dashboard): wire inline interventions and git badges into task drawer and cards`
  - Files: `apps/dashboard/src/components/task-drawer.tsx`, `apps/dashboard/src/components/kanban/task-card.tsx`
  - Pre-commit: `bun run typecheck`

---

- [ ] 8. Sessions Tab in Sandbox Drawer

  **What to do**:
  - Add a "Sessions" tab to the sandbox drawer's tab bar (alongside Repositories, Services, Exec):
  
  **New Tab Content**:
  - Use the reusable `SessionHierarchy` component from Task 5
  - Fetch OpenCode sessions via `opencodeSessionsQuery(sandbox.runtime.urls.opencode)`
  - Build hierarchy using `buildSessionHierarchy()` from `lib/session-hierarchy.ts`
  - Fetch permissions, questions, statuses via `useOpencodeData(opencodeUrl)`
  - Fetch todos for each session via `useQueries` with `opencodeTodosQuery`
  - Display full accordion hierarchy with:
    - Summary headers per root session
    - Inline intervention actions (from Task 4)
    - Todo lists per session
    - Status indicators

  - Add session count badge to the "Sessions" tab trigger:
    - Show total session count
    - If any need attention, show amber dot/badge

  - Add "Start New Session" button:
    - Uses `createOpenCodeSession()` (already in `api/opencode.ts`)
    - Optional: directory selector (default: `/home/dev/workspace`)

  **Must NOT do**:
  - Do NOT duplicate the hierarchy logic — reuse from Task 5's extracted component
  - Do NOT add session message sending
  - Do NOT add session deletion (just "abort" via the button from Task 1 if needed)

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: New tab with complex data fetching and component composition
  - **Skills**: `["frontend-ui-ux"]`
    - `frontend-ui-ux`: Tab layout, badge design, data composition
  - **Skills Evaluated but Omitted**:
    - `playwright`: Not needed for building

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7, 9)
  - **Blocks**: Task 10
  - **Blocked By**: Task 5

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/components/sandbox-drawer.tsx:484-547` — Existing `Tabs` component with Repositories, Services, Exec tabs. Add Sessions tab here.
  - `apps/dashboard/src/components/task-drawer.tsx:351-403` — How the task drawer uses session hierarchy with `useTaskSessionProgress`. Similar pattern but without task filtering.
  - `apps/dashboard/src/hooks/use-opencode-data.ts` — Hook that fetches permissions, questions, session statuses.

  **API/Type References**:
  - From Task 5: `SessionHierarchy` reusable component
  - `apps/dashboard/src/api/queries/opencode.ts` — `opencodeSessionsQuery`, `opencodeTodosQuery`
  - `apps/dashboard/src/lib/session-hierarchy.ts` — `buildSessionHierarchy()`, `SessionNode`

  **WHY Each Reference Matters**:
  - Sandbox drawer Tabs: Exact insertion point for the new tab
  - Task drawer session usage: Shows the data fetching + hierarchy building pattern to replicate
  - `use-opencode-data.ts`: Provides the interaction data (permissions, questions, statuses) needed for the hierarchy

  **Acceptance Criteria**:

  ```bash
  bun run typecheck
  # Assert: Exit code 0

  bun run check
  # Assert: Exit code 0
  ```

  ```
  # Playwright verification:
  1. Open sandbox drawer for a running sandbox
  2. Assert: "Sessions" tab visible in tab bar
  3. Click "Sessions" tab
  4. Assert: Session hierarchy renders with accordion headers
  5. Assert: Session count matches OpenCode data
  ```

  **Evidence to Capture:**
  - [ ] Screenshot of sandbox drawer with Sessions tab
  - [ ] Screenshot of session hierarchy in sandbox drawer

  **Commit**: YES
  - Message: `feat(dashboard): add Sessions tab with hierarchy to sandbox drawer`
  - Files: `apps/dashboard/src/components/sandbox-drawer.tsx`
  - Pre-commit: `bun run typecheck`

---

- [ ] 9. Sandbox Card Activity Row + Git Badges on Task Cards

  **What to do**:
  
  **Sandbox Card Activity Row**:
  - Modify `apps/dashboard/src/components/sandbox-card.tsx`:
  - Create a `SandboxActivitySummary` component (can be inline or extracted):
    - Finds the task for this sandbox (same pattern as sandbox drawer)
    - If sandbox is running and has an OpenCode URL:
      - Fetch sessions count, statuses, pending permissions/questions
      - Use `useOpencodeData(opencodeUrl)` for lightweight data
    - Render a single compact row of badges/text:
      - `🤖 {N} sessions` (total session count)
      - `🔵 {N} working` (busy sessions count) — only if > 0
      - `⚠️ {N} need attention` (permissions + questions count) — only if > 0, amber badge
      - `✅ {completed}/{total} tasks` (todo progress) — only if todos exist
    - Position: after the workspace/task info, before action buttons

  **Git Status Badges on Sandbox Cards**:
  - Fetch `sandboxGitStatusQuery(sandboxId)` for running sandboxes
  - Show small inline badges:
    - 🔴 "dirty" if any repo has `dirty: true`
    - "↑{N}" if any repo has `ahead > 0`
  - Position: near the sandbox ID or status area

  **Must NOT do**:
  - Do NOT add full session list to sandbox cards
  - Do NOT add commit/push to sandbox cards
  - Do NOT poll aggressively — session data refreshes via SSE events

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
    - Reason: Information-dense card design with badge layout
  - **Skills**: `["frontend-ui-ux"]`
    - `frontend-ui-ux`: Compact badge design, information density
  - **Skills Evaluated but Omitted**:
    - `playwright`: Not needed for building

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 (with Tasks 7, 8)
  - **Blocks**: Task 10
  - **Blocked By**: Task 6 (needs git query patterns)

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/components/sandbox-card.tsx` — The card to modify. Understand current layout and badge placement.
  - `apps/dashboard/src/components/running-sandboxes-card.tsx` — Shows how sandbox cards are composed in the dashboard overview.
  - `apps/dashboard/src/components/kanban/task-card.tsx:163-183` — How task cards show progress/status badges. Similar compact style for sandbox cards.

  **API/Type References**:
  - `apps/dashboard/src/hooks/use-opencode-data.ts` — `useOpencodeData(opencodeUrl)` returns permissions, questions, sessionStatuses. Use for session activity summary.
  - `apps/dashboard/src/api/queries/sandbox.ts` — `sandboxGitStatusQuery(sandboxId)` already exists for git status.
  - `apps/dashboard/src/api/queries/opencode.ts` — `opencodeSessionsQuery(url)` for session count.

  **WHY Each Reference Matters**:
  - `sandbox-card.tsx`: The exact file to modify — need to understand its current layout slots
  - `task-card.tsx` badges: Shows the visual pattern for compact progress/status badges to maintain consistency
  - `use-opencode-data.ts`: Lightweight hook that provides interaction data without heavy hierarchy building

  **Acceptance Criteria**:

  ```bash
  bun run typecheck
  # Assert: Exit code 0

  bun run check
  # Assert: Exit code 0
  ```

  ```
  # Playwright verification:
  1. Navigate to sandbox list
  2. Find a running sandbox card with active sessions
  3. Assert: Activity row shows session count and working count
  4. Assert: If sessions need attention, amber badge visible
  5. Assert: If repo is dirty, red "dirty" badge visible
  ```

  **Evidence to Capture:**
  - [ ] Screenshot of sandbox card with activity row and git badges

  **Commit**: YES
  - Message: `feat(dashboard): add session activity and git badges to sandbox cards`
  - Files: `apps/dashboard/src/components/sandbox-card.tsx`
  - Pre-commit: `bun run typecheck`

---

- [ ] 10. Cross-Cutting Polish, Edge Cases, Error Handling

  **What to do**:
  - Run `bun run check` and `bun run typecheck` across entire monorepo — fix any issues
  - Test edge cases:
    - Permission expires while viewing (race condition): Ensure `permission.reply()` handles 404 gracefully with "Request expired" toast
    - Question with empty options array: Render only freetext input
    - Question with `multiple: true`: Render checkboxes instead of radio buttons
    - Git push with no upstream: Verify error message is user-friendly
    - Git commit with empty message: Validate in UI (disable button if empty)
    - Sandbox with no workspace (bare sandbox): Git status endpoints gracefully return empty
    - Sandbox drawer opened for stopped sandbox: Sessions tab shows appropriate empty state
    - Task card for done task with stopped sandbox: Don't show git badges or session activity
  - Verify SSE event handling:
    - After permission reply → `permission.replied` event fires → cache invalidated → UI updates
    - After question reply → `question.replied` event fires → cache invalidated → UI updates
    - Check `apps/dashboard/src/lib/opencode-events.ts` handles new event types correctly
  - Clean up any unused imports, dead code from refactored components

  **Must NOT do**:
  - Do NOT add new features
  - Do NOT change architecture decisions

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
    - Reason: Cleanup, edge case testing, polishing
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: No new UI work

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential (final task)
  - **Blocks**: None
  - **Blocked By**: Tasks 7, 8, 9

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/lib/opencode-events.ts` — SSE event handling. Verify `permission.replied`, `question.replied` events invalidate the right query keys.
  - All files modified in Tasks 1-9 — review for consistency.

  **Acceptance Criteria**:

  ```bash
  # Full monorepo checks
  bun run typecheck
  # Assert: Exit code 0, zero errors

  bun run check
  # Assert: Exit code 0, zero warnings
  ```

  ```
  # Playwright verification:
  1. Navigate through all pages: dashboard, tasks (kanban), sandboxes, sandbox detail
  2. Assert: No console errors
  3. Open task drawer with active task
  4. Assert: Inline interventions functional
  5. Assert: Session hierarchy accordion renders correctly
  6. Open sandbox drawer
  7. Assert: Sessions tab renders
  8. Assert: Repositories tab with diff/commit works
  9. Navigate to sandbox list
  10. Assert: Activity badges render on sandbox cards
  ```

  **Evidence to Capture:**
  - [ ] Terminal output from final typecheck + lint
  - [ ] Screenshot of complete task drawer
  - [ ] Screenshot of complete sandbox drawer with Sessions + Repositories tabs
  - [ ] Screenshot of sandbox card with activity row

  **Commit**: YES
  - Message: `fix(dashboard): polish edge cases and error handling for git/opencode integration`
  - Files: Various
  - Pre-commit: `bun run typecheck && bun run check`

---

## Commit Strategy

| After Task | Message | Key Files | Verification |
|------------|---------|-----------|--------------|
| 1 | `feat(dashboard): add OpenCode SDK reply wrappers and TanStack mutations` | `api/opencode.ts`, `api/queries/opencode.ts` | `bun run typecheck` |
| 2 | `feat(manager): add git diffStat, commit, and push agent operations` | `agent.operations.ts`, `agent.types.ts` | `bun run typecheck` |
| 3 | `feat(manager): add git diff, commit, and push API endpoints` | `sandbox.routes.ts`, `schemas/sandbox.ts` | `bun run typecheck` |
| 4 | `feat(dashboard): add inline permission/question answering` | `expandable-interventions.tsx` | `bun run typecheck` |
| 5 | `feat(dashboard): redesign session hierarchy as accordion` | `session-hierarchy.tsx`, `task-session-hierarchy.tsx` | `bun run typecheck` |
| 6 | `feat(dashboard): add git diff viewer and commit/push UI` | `sandbox-drawer.tsx`, `queries/sandbox.ts` | `bun run typecheck` |
| 7 | `feat(dashboard): wire interventions and git badges into task UI` | `task-drawer.tsx`, `task-card.tsx` | `bun run typecheck` |
| 8 | `feat(dashboard): add Sessions tab to sandbox drawer` | `sandbox-drawer.tsx` | `bun run typecheck` |
| 9 | `feat(dashboard): add activity and git badges to sandbox cards` | `sandbox-card.tsx` | `bun run typecheck` |
| 10 | `fix(dashboard): polish edge cases for git/opencode integration` | Various | `bun run typecheck && bun run check` |

---

## Success Criteria

### Verification Commands
```bash
bun run typecheck   # Expected: 0 errors
bun run check       # Expected: 0 warnings
bun run dev         # Expected: dashboard starts at localhost:5173
```

### Final Checklist
- [ ] All "Must Have" features present and functional
- [ ] All "Must NOT Have" items verified absent
- [ ] `bun run typecheck` passes with 0 errors
- [ ] `bun run check` passes with 0 warnings
- [ ] Permission approve/deny works inline
- [ ] Question answering works inline with option selection + freetext
- [ ] Git diff file list renders in sandbox drawer
- [ ] Git commit + push works from sandbox drawer
- [ ] Session hierarchy renders as accordion with summaries
- [ ] Sandbox drawer has Sessions tab
- [ ] Sandbox cards show activity summary
- [ ] Task cards show git dirty/unpushed badges
