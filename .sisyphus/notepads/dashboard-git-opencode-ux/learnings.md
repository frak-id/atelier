# Dashboard Git OpenCode UX - Learnings

## Task 1: Git Operations Implementation (COMPLETED)

### Pattern: AgentOperations Methods
- Follow exact pattern from `gitStatus()`: construct shell scripts, call `batchExec()` or `exec()`, parse stdout
- Always wrap commands with `su - dev -c '...'` for proper user context
- Escape single quotes in shell strings with `'\''` pattern
- Use `batchExec()` for parallel operations across multiple repos
- Use `exec()` for single-repo operations with timeout handling

### Git Diff Implementation
- Use `git diff --numstat HEAD` for unstaged changes (format: `added\tremoved\tpath`)
- Use `git diff --numstat --cached HEAD` for staged changes
- Use `git ls-files --others --exclude-standard` for untracked files
- Limit output with `head -200` and `head -100` to prevent large responses
- Parse numstat by splitting on tabs: `parts[0]` = added, `parts[1]` = removed, `parts[2+]` = path
- Untracked files counted as added with value 1

### Git Commit Implementation
- Escape message quotes with `message.replace(/'/g, "'\\''")` before embedding in shell
- Use `git add -A && git commit -m "..."` for atomic add+commit
- Extract commit hash with `git rev-parse --short HEAD` after success
- Handle errors: check exitCode and parse stdout for "NOT_GIT" marker
- Use 30s timeout for commit operations

### Git Push Implementation
- Try `git push` first, fallback to `git push --set-upstream origin $(git branch --show-current)`
- Use `2>&1` to capture both stdout and stderr
- Handle "no upstream" case gracefully with fallback command
- Use 30s timeout for push operations
- Return success/error in structured result

### Type Definitions
Added 5 new types to `agent.types.ts`:
- `GitDiffFile`: { path, added, removed }
- `GitDiffRepo`: { path, files[], totalAdded, totalRemoved, error? }
- `GitDiffResult`: { repos: GitDiffRepo[] }
- `GitCommitResult`: { path, success, hash?, error? }
- `GitPushResult`: { path, success, error? }

### Error Handling Pattern
- Try/catch wraps exec() calls
- Check exitCode !== 0 for command failures
- Return structured error objects with path and error message
- "NOT_GIT" marker used to distinguish repo validation failures

### Verification
- `bun run typecheck` passes with 0 errors
- All 3 methods follow existing patterns in codebase
- No new agent-side routes needed (uses existing /exec and /exec/batch)

## Task 10: Final Polish & Edge Case Handling (COMPLETED)

### Key Findings
- **RepositoriesTab already existed**: Task description was based on stale info from parallel task execution
- **No filepath vs path mismatch**: API correctly returns `path` field, code was already correct
- **All edge cases already handled**: Previous tasks implemented comprehensive error handling

### Biome Optional Chain Fixes
Fixed 3 warnings by replacing `result && result.success` with `result?.success`:
- Line 906: `handleCommit` - commit result check
- Line 925: `handlePush` - push result check  
- Line 954: `handleCommitAndPush` - push result check after commit

### Edge Cases Verified (All Already Implemented)
1. **Permission expiry (404)**: Lines 180-182 in `expandable-interventions.tsx` detect 404 and show "Permission request expired"
2. **Question expiry (404)**: Lines 281-283, 299-301 handle expired questions
3. **Empty options array**: Line 366 checks `qi.options.length > 0` before rendering options
4. **Multiple choice questions**: Line 358 checks `qi.multiple ?? false`, renders checkboxes vs radio (lines 382-395)
5. **Custom input**: Line 359 checks `qi.custom !== false`, shows freetext input (lines 411-424)
6. **Empty commit message**: Lines 1103, 1126 disable buttons when `!commitMessage.trim()`
7. **Git push without upstream**: Line 928 shows API error message (includes "no upstream" from backend)
8. **Stopped sandbox**: Sessions tab shows empty state (lines 805-809)
9. **No workspace**: Git endpoints return empty gracefully (backend handles this)

### SSE Event Handling Verified
In `opencode-events.ts`:
- Line 53: `permission.replied` → invalidates permissions query ✓
- Line 59: `question.replied` → invalidates questions query ✓
- Line 65: `todo.updated` → invalidates todos query ✓

### Verification Results
- TypeScript: 0 errors ✓
- Biome: 0 warnings in sandbox-drawer.tsx (4 pre-existing warnings in other files)
- All edge cases handled ✓
- SSE events properly invalidate queries ✓

### Pattern: Parallel Task Integration
When tasks run in parallel, always verify assumptions:
- Task 6 created `RepoRow` AND `RepositoriesTab` (not just RepoRow)
- Task descriptions may reference stale state from before parallel execution
- Run fresh typecheck/lint before making changes
- LSP errors can be stale - trust fresh compiler output

### Commit Message Pattern
For polish/cleanup tasks: `fix(dashboard): polish edge cases and error handling for git/opencode integration`

## [2026-01-31] FINAL COMPLETION

### All Tasks Complete (32/32 checkboxes)
- 10 main tasks (Wave 1-4) ✅
- 10 Definition of Done items ✅
- 12 Final Checklist items ✅

### Verification Results
- **Typecheck**: PASS (0 errors)
- **Lint**: PASS (4 pre-existing warnings in unmodified files, none in our changes)
- **Modified files**: 9 files across manager + dashboard
- **New files**: 1 reusable component (session-hierarchy.tsx)

### Pre-existing Lint Warnings (NOT our responsibility)
1. `apps/agent/src/index.ts:16` - `any` type
2. `apps/dashboard/src/components/kanban/task-form-dialog.tsx:290` - Array index key
3. `apps/dashboard/src/components/session-template-edit-dialog.tsx:249` - Array index key
4. `apps/dashboard/src/components/start-working-card.tsx:251` - Array index key

### Key Deliverables
1. **Backend**: Git operations (diffStat, commit, push) in agent + manager
2. **Frontend**: Inline interventions, accordion sessions, git UI, activity badges
3. **Integration**: Full end-to-end flow from dashboard → manager → agent → git

### Ready for Commit
All changes are uncommitted and ready for final commit when user is ready.

Branch: `task/task_Dn6ypT5Fc_VF`
Status: COMPLETE ✅
