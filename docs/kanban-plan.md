# Kanban App Implementation Plan

> Task orchestration UI for Frak Sandbox with AI-driven state transitions

## Overview

A new `apps/kanban` React application that provides a Kanban board interface for orchestrating AI coding tasks. Each task maps 1:1 to a sandbox, with automatic state transitions based on OpenCode session activity.

### Goals

- **Team orchestration** with solo-dev friendly design
- **External tracker import** from GitHub Issues, Linear, Jira, Trello
- **Bidirectional sync** with external trackers
- **Automatic state transitions** driven by AI agent progress
- **Git integration** with branch-per-task and auto-PR creation

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         apps/kanban (New)                                │
│   React 19 + Vite + TanStack Router/Query + @dnd-kit/core + shadcn/ui   │
│                                                                          │
│   Routes:                                                                │
│   /              → Kanban board (main view)                             │
│   /tasks/:id     → Task detail view                                     │
│   /import        → Import from external trackers                        │
│   /settings      → Tracker connections                                  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ Eden Treaty (type-safe API client)
                                     │
┌────────────────────────────────────▼────────────────────────────────────┐
│                     apps/manager (Extended)                              │
│                                                                          │
│   New Modules:                                                           │
│   ├── task/                   → Task CRUD, state machine                │
│   ├── external-tracker/       → GitHub, Linear, Jira, Trello sync       │
│   └── task-orchestrator/      → Monitor, Git, auto-transitions          │
│                                                                          │
│   New Tables:                                                            │
│   ├── tasks                   → Task data, status, relationships        │
│   ├── tracker_connections     → External tracker auth/config            │
│   └── task_events             → Activity log for debugging              │
└─────────────┬──────────────────────┬────────────────────────────────────┘
              │                      │
       ┌──────▼──────┐        ┌──────▼──────┐
       │   Sandbox   │        │  External   │
       │  (1:1 link) │        │  Trackers   │
       │             │        │             │
       │  OpenCode   │        │  GitHub     │
       │  Sessions   │        │  Linear     │
       │             │        │  Jira       │
       └─────────────┘        │  Trello     │
                              └─────────────┘
```

---

## Task Lifecycle

### Status Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           TASK STATUS FLOW                                │
│                                                                          │
│  ┌─────────┐   ┌─────────┐   ┌───────────┐   ┌───────────┐   ┌────────┐ │
│  │ BACKLOG │──▶│  QUEUE  │──▶│IN_PROGRESS│──▶│ AI_REVIEW │──▶│ HUMAN  │ │
│  │         │   │         │   │           │   │           │   │ REVIEW │ │
│  └─────────┘   └────┬────┘   └─────┬─────┘   └─────┬─────┘   └───┬────┘ │
│       │             │              │               │              │      │
│       │             │              │               │              ▼      │
│       │             │              │               │         ┌────────┐  │
│       │             │              │               └────────▶│  DONE  │  │
│       │             │              │                         └────────┘  │
│       │             │              │                              ▲      │
│       │             │              ▼                              │      │
│       │             │        ┌───────────┐                       │      │
│       │             └───────▶│  BLOCKED  │───────────────────────┘      │
│       │                      └───────────┘                               │
│       │                                                                  │
│       ▼                                                                  │
│  ┌───────────┐                                                          │
│  │ CANCELLED │◀──────────── (external tracker closed issue)             │
│  └───────────┘                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

### Status Definitions

| Status | Description | Sandbox State | Auto-Transition Trigger |
|--------|-------------|---------------|-------------------------|
| `backlog` | Not started, no sandbox | None | Manual move to queue |
| `queue` | Ready to start, awaiting sandbox | Creating | Sandbox becomes `running` |
| `in_progress` | AI actively working | Running | All subtasks complete |
| `ai_review` | AI finished, automated checks | Running | Checks pass → PR created |
| `human_review` | PR open, awaiting approval | Stopped (kept) | PR merged |
| `done` | Complete | Stopped (kept) | — |
| `blocked` | Waiting on external dependency | Stopped | Dependency resolved |
| `cancelled` | Abandoned | Destroyed | External issue closed |

### Automatic Transitions

| From | To | Trigger |
|------|-----|---------|
| `queue` | `in_progress` | Sandbox status = `running` |
| `in_progress` | `ai_review` | All spec subtasks marked complete |
| `ai_review` | `human_review` | Automated checks pass + PR created |
| `human_review` | `done` | PR merged (webhook or poll) |
| `*` | `cancelled` | External tracker issue closed |

---

## Data Model

### Tasks Table

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  
  -- Status & ordering
  status TEXT NOT NULL CHECK (status IN (
    'backlog', 'queue', 'in_progress', 'ai_review', 
    'human_review', 'done', 'blocked', 'cancelled'
  )),
  priority INTEGER DEFAULT 0,
  "order" INTEGER NOT NULL,
  
  -- Source tracking (for bidirectional sync)
  source TEXT NOT NULL CHECK (source IN ('manual', 'github', 'linear', 'jira', 'trello')),
  external_id TEXT,
  external_url TEXT,
  sync_enabled INTEGER DEFAULT 1,
  last_synced_at TEXT,
  
  -- Relationships
  workspace_id TEXT REFERENCES workspaces(id),
  sandbox_id TEXT,
  
  -- Git integration
  branch_name TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  
  -- Spec (markdown with subtask checklist)
  spec_content TEXT,
  
  -- Timestamps
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_workspace_id ON tasks(workspace_id);
CREATE INDEX idx_tasks_sandbox_id ON tasks(sandbox_id);
CREATE INDEX idx_tasks_external ON tasks(source, external_id);
```

### Tracker Connections Table

```sql
CREATE TABLE tracker_connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'linear', 'jira', 'trello')),
  name TEXT NOT NULL,
  
  -- Provider-specific config (encrypted)
  config TEXT NOT NULL,  -- JSON: { apiKey, domain, projectId, etc. }
  
  -- Sync settings
  sync_enabled INTEGER DEFAULT 1,
  sync_interval_minutes INTEGER DEFAULT 5,
  last_synced_at TEXT,
  
  -- Filter criteria
  import_filter TEXT,  -- JSON: { labels, assignee, project, etc. }
  
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Task Events Table (Activity Log)

```sql
CREATE TABLE task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  
  event_type TEXT NOT NULL,  -- 'status_change', 'sync', 'pr_created', etc.
  event_data TEXT,           -- JSON with event-specific data
  
  created_at TEXT NOT NULL
);

CREATE INDEX idx_task_events_task_id ON task_events(task_id);
```

---

## Spec Format

Tasks use markdown specs with subtask checklists. Progress is tracked by parsing checkbox state.

```markdown
# Task: Implement user authentication

## Summary
Add JWT-based authentication to the API with login/logout endpoints.

## Acceptance Criteria
- [ ] POST /auth/login returns JWT token
- [ ] POST /auth/logout invalidates token
- [ ] Protected routes require valid token
- [ ] Token expires after 24 hours

## Subtasks
- [ ] Create auth module scaffold
- [ ] Implement JWT signing/verification
- [ ] Add login endpoint with password validation
- [ ] Add logout endpoint with token blacklist
- [ ] Add auth middleware for protected routes
- [ ] Write integration tests

## Notes
Use existing bcrypt setup from user module.
Reference: RFC 7519 for JWT spec.
```

### Progress Calculation

```typescript
function calculateProgress(specContent: string): { completed: number; total: number } {
  const checkboxes = specContent.match(/- \[(x| )\]/gi) || [];
  const completed = checkboxes.filter(cb => cb.includes('x')).length;
  return { completed, total: checkboxes.length };
}
```

---

## External Tracker Integration

### Supported Providers

| Provider | SDK | Auth Method | Sync Features |
|----------|-----|-------------|---------------|
| GitHub | `octokit` | OAuth (existing) | Issues, PRs, Labels |
| Linear | `@linear/sdk` | API Key | Issues, Projects, Cycles |
| Jira | `jira.js` | Basic Auth (email + token) | Issues, Sprints, JQL |
| Trello | REST API | API Key + Token | Cards, Lists, Boards |

### Bidirectional Sync

**Import (External → Kanban):**
- Fetch issues matching filter criteria
- Create/update tasks with `source` and `external_id`
- Map external status to Kanban status

**Export (Kanban → External):**
- When task status changes, update external issue
- When task completed, close external issue
- When PR created, link to external issue

**Conflict Resolution:**
- External change while task `in_progress`: Queue notification, don't auto-apply
- External issue closed: Cancel task, destroy sandbox
- External issue reopened: Prompt to recreate task

### Sync Service

```typescript
interface TrackerProvider {
  // Import
  listIssues(filter: ImportFilter): Promise<ExternalIssue[]>;
  getIssue(externalId: string): Promise<ExternalIssue>;
  
  // Export
  updateIssueStatus(externalId: string, status: string): Promise<void>;
  closeIssue(externalId: string): Promise<void>;
  addComment(externalId: string, comment: string): Promise<void>;
  linkPullRequest(externalId: string, prUrl: string): Promise<void>;
  
  // Webhooks (optional)
  registerWebhook?(callbackUrl: string): Promise<void>;
  handleWebhook?(payload: unknown): Promise<SyncEvent>;
}
```

---

## Sandbox Integration

### Task → Sandbox Flow

```
1. User moves task from backlog → queue
2. User clicks "Start Task" button
3. System creates feature branch: task/{id}/{slug}
4. System spawns sandbox with workspace config
5. Sandbox clones repo, checks out branch
6. OpenCode session auto-created with spec as initial prompt
7. Task status: queue → in_progress (when sandbox running)
```

### 1:1 Relationship

- Each task can have at most one sandbox
- Sandbox destruction doesn't delete task (for debugging)
- Task completion stops sandbox but keeps it available
- Re-starting a completed task creates new sandbox

### Sandbox Lifecycle by Task Status

| Task Status | Sandbox Action |
|-------------|----------------|
| `backlog` | None |
| `queue` | Create (status: creating) |
| `in_progress` | Running |
| `ai_review` | Running (for verification) |
| `human_review` | Stop (pause VM, preserve state) |
| `done` | Keep stopped (debugging) |
| `blocked` | Stop |
| `cancelled` | Destroy |

---

## Git Integration

### Branch Strategy

```
main
  └── task/{task-id-prefix}/{slugified-title}
        └── commits from AI agent
```

Example: `task/abc123/implement-user-authentication`

### PR Creation

When task moves to `human_review`:

1. Push all commits to feature branch
2. Create PR via GitHub API
3. PR body includes:
   - Task summary
   - Subtask checklist (from spec)
   - Link to original issue (if imported)
   - Link to sandbox (for debugging)

### PR Template

```markdown
## Summary
{task.description}

## Changes
{subtask checklist from spec}

## References
- Task: {kanban_url}/tasks/{task.id}
- Sandbox: {sandbox.urls.vscode}
{if task.external_url}
- Original Issue: {task.external_url}
{/if}

## Testing
Sandbox kept running for verification. Access via:
- VSCode: {sandbox.urls.vscode}
- OpenCode: {sandbox.urls.opencode}
```

---

## Frontend Components

### Kanban Board

```
┌──────────────────────────────────────────────────────────────────────────┐
│  KANBAN BOARD                                        [+ New Task] [Import]│
├──────────┬──────────┬──────────┬──────────┬──────────┬──────────┬───────┤
│ BACKLOG  │  QUEUE   │IN PROGRESS│AI REVIEW │HR REVIEW │   DONE   │BLOCKED│
├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┼───────┤
│          │          │          │          │          │          │       │
│ ┌──────┐ │ ┌──────┐ │ ┌──────┐ │          │ ┌──────┐ │          │       │
│ │Task 1│ │ │Task 2│ │ │Task 3│ │          │ │Task 5│ │          │       │
│ │      │ │ │      │ │ │ ████ │ │          │ │  PR  │ │          │       │
│ │GitHub│ │ │Linear│ │ │ 60%  │ │          │ │ #42  │ │          │       │
│ └──────┘ │ └──────┘ │ └──────┘ │          │ └──────┘ │          │       │
│          │          │          │          │          │          │       │
│ ┌──────┐ │          │ ┌──────┐ │          │          │          │       │
│ │Task 4│ │          │ │Task 6│ │          │          │          │       │
│ │      │ │          │ │ ██   │ │          │          │          │       │
│ │Manual│ │          │ │ 30%  │ │          │          │          │       │
│ └──────┘ │          │ └──────┘ │          │          │          │       │
│          │          │          │          │          │          │       │
└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┴───────┘
```

### Task Card

```
┌─────────────────────────────┐
│ [GitHub] #123               │  ← Source badge + external ID
│ ─────────────────────────── │
│ Implement user auth         │  ← Title
│                             │
│ ████████░░░░░░░ 60%        │  ← Progress bar (subtasks)
│                             │
│ 🏷️ auth  🏷️ backend        │  ← Labels
│                             │
│ [▶ Start] [📂 Open] [⋮]    │  ← Actions
└─────────────────────────────┘
```

### Component Structure

```
src/components/
├── kanban/
│   ├── board.tsx              # DndContext + columns layout
│   ├── column.tsx             # SortableContext + task list
│   ├── task-card.tsx          # Draggable card with useSortable
│   ├── task-card-skeleton.tsx # Loading state
│   └── drag-overlay.tsx       # Visual feedback during drag
├── task/
│   ├── task-detail-sheet.tsx  # Slide-out panel for task details
│   ├── task-spec-editor.tsx   # Markdown editor for spec
│   ├── task-activity.tsx      # Event timeline
│   └── task-sandbox-panel.tsx # Sandbox status + actions
├── import/
│   ├── import-dialog.tsx      # Provider selection
│   ├── github-import.tsx      # GitHub issue picker
│   ├── linear-import.tsx      # Linear issue picker
│   ├── jira-import.tsx        # Jira issue picker
│   └── trello-import.tsx      # Trello card picker
└── settings/
    └── tracker-connections.tsx # Manage provider auth
```

---

## API Endpoints

### Task Module

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/tasks` | List tasks (filter: status, workspace, source) |
| POST | `/api/tasks` | Create manual task |
| GET | `/api/tasks/:id` | Get task details |
| PUT | `/api/tasks/:id` | Update task |
| DELETE | `/api/tasks/:id` | Delete task |
| POST | `/api/tasks/:id/move` | Change status + reorder |
| POST | `/api/tasks/:id/start` | Spawn sandbox, start work |
| POST | `/api/tasks/:id/stop` | Stop sandbox, pause work |
| POST | `/api/tasks/:id/complete` | Create PR, move to review |
| POST | `/api/tasks/:id/cancel` | Cancel task, destroy sandbox |
| GET | `/api/tasks/:id/events` | Get activity log |

### External Tracker Module

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/trackers` | List configured connections |
| POST | `/api/trackers` | Add new connection |
| PUT | `/api/trackers/:id` | Update connection config |
| DELETE | `/api/trackers/:id` | Remove connection |
| GET | `/api/trackers/:id/issues` | List importable issues |
| POST | `/api/trackers/:id/import` | Import selected issues |
| POST | `/api/trackers/:id/sync` | Force sync now |
| POST | `/api/trackers/webhook/:provider` | Webhook receiver |

---

## Implementation Phases

### Phase 1: Backend Task Module
**Complexity:** Medium | **Estimate:** 2-3 days

- [ ] Add `tasks` table to schema
- [ ] Create migration
- [ ] Implement TaskRepository
- [ ] Implement TaskService with status machine
- [ ] Implement TaskRoutes
- [ ] Add to container.ts
- [ ] Export types for frontend

### Phase 2: External Tracker Integration
**Complexity:** High | **Estimate:** 4-5 days | **Parallelizable**

- [ ] Add `tracker_connections` table
- [ ] Implement base TrackerProvider interface
- [ ] **2A:** GitHub tracker (uses existing OAuth)
- [ ] **2B:** Linear tracker
- [ ] **2C:** Jira tracker
- [ ] **2D:** Trello tracker
- [ ] Implement ExternalTrackerService (unified layer)
- [ ] Implement ExternalTrackerRoutes
- [ ] Add bidirectional sync service

### Phase 3: Frontend Scaffold
**Complexity:** Low | **Estimate:** 1-2 days | **Parallelizable with Phase 2**

- [ ] Create apps/kanban directory structure
- [ ] Setup package.json with dependencies
- [ ] Setup vite.config.ts
- [ ] Setup TanStack Router
- [ ] Setup API client (Eden Treaty)
- [ ] Copy shadcn/ui components from dashboard
- [ ] Create basic layout with navigation

### Phase 4: Kanban Board UI
**Complexity:** Medium-High | **Estimate:** 3-4 days

- [ ] Install @dnd-kit dependencies
- [ ] Implement Board component with DndContext
- [ ] Implement Column component with SortableContext
- [ ] Implement TaskCard with useSortable
- [ ] Implement drag overlay
- [ ] Add optimistic updates for moves
- [ ] Implement task detail sheet
- [ ] Implement create task dialog

### Phase 5: Task ↔ Sandbox Integration
**Complexity:** Medium | **Estimate:** 2-3 days

- [ ] Extend TaskService with sandbox spawning
- [ ] Implement branch creation on task start
- [ ] Link sandbox to task on creation
- [ ] Add sandbox status to task card
- [ ] Implement "Start Task" action
- [ ] Implement "Stop Task" action
- [ ] Handle sandbox destroy on cancel

### Phase 6: Auto State Transitions
**Complexity:** High | **Estimate:** 3-4 days

- [ ] Implement TaskMonitorService
- [ ] Add spec parsing for subtask progress
- [ ] Poll OpenCode sessions for activity
- [ ] Detect subtask completion from commits/messages
- [ ] Auto-transition queue → in_progress
- [ ] Auto-transition in_progress → ai_review
- [ ] Add task_events logging

### Phase 7: Git & PR Integration
**Complexity:** Medium | **Estimate:** 2-3 days

- [ ] Implement TaskGitService
- [ ] Branch creation on task start
- [ ] PR creation on task complete
- [ ] PR body generation from spec
- [ ] Link PR to external issue
- [ ] Poll for PR merge status
- [ ] Auto-transition on merge

---

## Dependencies

### Backend (apps/manager)

```json
{
  "@linear/sdk": "^3.0.0",
  "jira.js": "^4.0.0"
}
```

### Frontend (apps/kanban)

```json
{
  "@dnd-kit/core": "^6.3.1",
  "@dnd-kit/sortable": "^10.0.0",
  "@dnd-kit/utilities": "^3.2.2",
  "@elysiajs/eden": "^1.4.6",
  "@frak-sandbox/manager": "workspace:*",
  "@radix-ui/react-dialog": "^1.1.4",
  "@radix-ui/react-select": "^2.1.4",
  "@radix-ui/react-tabs": "^1.1.2",
  "@tanstack/react-query": "^5.62.0",
  "@tanstack/react-router": "^1.93.0",
  "class-variance-authority": "^0.7.1",
  "clsx": "^2.1.1",
  "lucide-react": "^0.468.0",
  "react": "^19.0.0",
  "react-dom": "^19.0.0",
  "tailwind-merge": "^2.6.0"
}
```

---

## Open Questions

1. **Multi-repo workspaces:** If a workspace has multiple repos configured, which one gets the feature branch and PR? Options:
   - Always first repo
   - User selects when creating task
   - All repos get branches (complex)

2. **Workspace requirement:** Should tasks require a workspace, or allow "workspace-less" tasks for planning?

3. **Team features:** User assignment, comments, mentions - defer to v2?

4. **Notifications:** How to notify team of status changes? Slack/Discord integration?

---

## Future Enhancements (v2)

- [ ] Real-time updates via WebSocket/SSE
- [ ] Multi-user with role-based access
- [ ] Task templates
- [ ] Recurring tasks
- [ ] Time tracking
- [ ] AI-generated subtasks from description
- [ ] Automated code review in ai_review phase
- [ ] Slack/Discord notifications
- [ ] Mobile-responsive board
- [ ] Keyboard shortcuts for power users
