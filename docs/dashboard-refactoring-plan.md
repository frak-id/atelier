# Dashboard Refactoring Plan

> Complete redesign of the Frak Sandbox dashboard for dev-first workflow with product team support.

**Created:** 2026-01-23  
**Status:** Planning  
**Scope:** Full dashboard refactoring + cleanup

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Design Decisions](#2-design-decisions)
3. [Information Architecture](#3-information-architecture)
4. [Folder Structure](#4-folder-structure)
5. [Real-Time Architecture](#5-real-time-architecture)
6. [View Designs](#6-view-designs)
7. [Component Guidelines](#7-component-guidelines)
8. [Implementation Phases](#8-implementation-phases)
9. [Technical Specifications](#9-technical-specifications)

---

## 1. Executive Summary

### Goals

- **Dev-first workflow** with product team support (product drafts tasks → dev adds context → queues)
- **Real-time updates** via SSE from OpenCode instances (replacing polling)
- **Minimal chat embedding** with link-out to full OpenCode WebUI
- **Collapsible sidebar** with icon-only mode (Lucide icons)
- **Clean component architecture** following React/TanStack best practices
- **Mobile responsive** (sidebar stays as-is for now)

### Key Changes

| Area | Current State | Target State |
|------|---------------|--------------|
| Data updates | Polling (5s intervals) | SSE with query invalidation |
| Session visibility | Hidden in sandbox details | First-class Sessions view |
| Task status | Basic badges | Real-time status with attention indicators |
| Chat access | Navigate to OpenCode WebUI | Embedded preview + quick reply |
| Navigation | Flat sidebar | Grouped + collapsible sidebar |
| SSH management | In Settings | Moved to User Profile |

---

## 2. Design Decisions

### Confirmed Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **State management** | TanStack Query + SSE invalidation | Zustand only if needed; prefer single source of truth |
| **Chat embed depth** | Last user message + last agent response | Minimal footprint, link out for full conversation |
| **Attention detection** | Session idle + last msg from AI, OR retry status, OR task pending_review | Covers all "waiting for human" states |
| **Mobile support** | Important, but sidebar unchanged | Focus on responsive content first |
| **Theme** | Dark only (no switching) | Already implemented, not in scope |

### Attention Detection Logic

A task/session "needs attention" when ANY of:

```typescript
type NeedsAttention = 
  | { sessionStatus: 'idle', lastMessageFrom: 'agent' }
  | { sessionStatus: 'retry' }
  | { taskStatus: 'pending_review' };
```

---

## 3. Information Architecture

### Navigation Structure

```
SIDEBAR (Collapsible -> Icons only)
├── MAIN
│   ├── Home (Dashboard)      -> Overview + Quick actions
│   ├── Tasks                 -> Kanban board (primary workflow)
│   └── Sessions              -> All active sessions across sandboxes
│
├── DEV TOOLS
│   ├── Sandboxes             -> VM management + quick connect
│   └── Workspaces            -> Templates, prebuilds, configs
│
├── ADMIN
│   ├── System                -> Stats, queue, cleanup
│   ├── Images                -> Base image management
│   └── Config                -> OpenCode auth, global configs
│
└── FOOTER
    ├── Profile               -> SSH keys, personal preferences
    └── Sign out
```

### Route Changes

| Current Route | New Route | Change Type |
|---------------|-----------|-------------|
| `/` | `/` | Redesign |
| `/tasks` | `/tasks` | Enhance |
| - | `/tasks/$id` | **NEW** |
| - | `/sessions` | **NEW** |
| `/sandboxes` | `/sandboxes` | Simplify |
| `/sandboxes/$id` | `/sandboxes/$id` | Enhance |
| `/workspaces` | `/workspaces` | Keep |
| `/workspaces/$id` | `/workspaces/$id` | Keep |
| `/system` | `/admin/system` | Move |
| `/images` | `/admin/images` | Move |
| `/settings` | `/admin/config` | Rename + split SSH |
| - | `/profile` | **NEW** |

---

## 4. Folder Structure

```
apps/dashboard/src/
├── api/
│   ├── client.ts                    # Elysia Eden client (keep)
│   ├── queries.ts                   # TanStack Query definitions (refactor)
│   ├── mutations.ts                 # NEW: Extracted mutations
│   └── opencode/
│       ├── client.ts                # OpenCode SDK wrapper (from opencode.ts)
│       ├── events.ts                # NEW: SSE subscription logic
│       └── types.ts                 # OpenCode-related types
│
├── hooks/
│   ├── use-opencode-events.ts       # NEW: SSE hook for real-time updates
│   ├── use-session-status.ts        # NEW: Per-session status from SSE
│   ├── use-all-sessions.ts          # Refactored from use-all-opencode-sessions
│   ├── use-task-sessions.ts         # NEW: Sessions for a specific task
│   ├── use-attention-tasks.ts       # NEW: Tasks needing attention
│   └── use-sidebar-state.ts         # NEW: Sidebar collapse state (localStorage)
│
├── components/
│   ├── ui/                          # Keep shadcn/ui components as-is
│   │
│   ├── layout/                      # NEW: Layout components
│   │   ├── sidebar.tsx              # Collapsible sidebar container
│   │   ├── sidebar-nav.tsx          # Navigation items
│   │   ├── sidebar-group.tsx        # Collapsible nav groups
│   │   ├── sidebar-footer.tsx       # Profile + sign out
│   │   └── page-header.tsx          # Reusable page headers
│   │
│   ├── tasks/                       # Task-related components
│   │   ├── kanban/
│   │   │   ├── board.tsx            # Kanban board container
│   │   │   ├── column.tsx           # Status column
│   │   │   ├── card.tsx             # Task card with status
│   │   │   ├── card-actions.tsx     # Quick action buttons
│   │   │   └── filters.tsx          # Filter/sort controls
│   │   ├── detail/
│   │   │   ├── panel.tsx            # Detail view layout
│   │   │   ├── info-sidebar.tsx     # Task info sidebar
│   │   │   ├── subsessions-list.tsx # Sub-session progress list
│   │   │   └── chat-embed.tsx       # Minimal chat embed
│   │   ├── form-dialog.tsx          # Create/edit task dialog
│   │   └── delete-dialog.tsx        # Delete confirmation
│   │
│   ├── sessions/                    # Session-related components
│   │   ├── session-list.tsx         # Grouped session list
│   │   ├── session-card.tsx         # Session with status + preview
│   │   ├── session-chat-preview.tsx # Last msg + reply input
│   │   └── status-badge.tsx         # Real-time status badge
│   │
│   ├── sandboxes/                   # Sandbox-related components
│   │   ├── sandbox-card.tsx         # Sandbox list item
│   │   ├── quick-connect.tsx        # SSH/VSCode/Terminal buttons
│   │   └── create-dialog.tsx        # Create sandbox dialog
│   │
│   ├── workspaces/                  # Workspace-related components
│   │   ├── workspace-card.tsx       # Workspace list item
│   │   ├── workspace-form/          # Keep existing form components
│   │   ├── create-dialog.tsx
│   │   └── edit-dialog.tsx
│   │
│   ├── dashboard/                   # Dashboard-specific components
│   │   ├── status-overview.tsx      # Status count cards
│   │   ├── attention-list.tsx       # Tasks needing attention
│   │   ├── quick-start.tsx          # New task/chat widget
│   │   └── running-sessions.tsx     # Currently running sessions
│   │
│   ├── profile/                     # Profile components
│   │   └── ssh-keys-section.tsx     # Moved from settings
│   │
│   └── shared/                      # Shared/reusable components
│       ├── status-indicator.tsx     # Dot indicator (running/idle/attention)
│       ├── quick-actions.tsx        # VSCode/SSH/Terminal/OpenCode buttons
│       ├── empty-state.tsx          # Reusable empty states
│       ├── time-ago.tsx             # Relative time display
│       └── copy-button.tsx          # Copy to clipboard button
│
├── routes/
│   ├── __root.tsx                   # Root layout with new sidebar
│   ├── index.tsx                    # Dashboard (redesigned)
│   ├── tasks/
│   │   ├── index.tsx                # Kanban board (enhanced)
│   │   └── $id.tsx                  # Task detail (NEW)
│   ├── sessions/
│   │   └── index.tsx                # All sessions (NEW)
│   ├── sandboxes/
│   │   ├── index.tsx                # Sandbox list (simplified)
│   │   └── $id.tsx                  # Sandbox detail (keep)
│   ├── workspaces/
│   │   ├── index.tsx                # Workspace list (keep)
│   │   └── $id.tsx                  # Workspace detail (keep)
│   ├── admin/
│   │   ├── system.tsx               # System stats (moved)
│   │   ├── images.tsx               # Base images (moved)
│   │   └── config.tsx               # Global config (renamed from settings)
│   └── profile.tsx                  # User profile + SSH keys (NEW)
│
└── lib/
    ├── utils.ts                     # Keep existing utils
    ├── constants.ts                 # NEW: UI constants, status mappings
    └── session-helpers.ts           # Renamed from session-hierarchy.ts
```

---

## 5. Real-Time Architecture

### Overview

Replace polling with Server-Sent Events from OpenCode instances, using TanStack Query invalidation:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     REAL-TIME DATA FLOW                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  TanStack Query Cache                                               │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  sessions: Session[]           <- Initial fetch + SSE refresh   │
│  │  sessionStatuses: Map<id, Status>  <- SSE updates              │
│  │  lastMessages: Map<id, Message>    <- SSE updates              │
│  └─────────────────────────────────────────────────────────────┘   │
│                          ▲                                          │
│                          │ invalidateQueries()                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  useOpencodeEvents Hook                                      │   │
│  │  ├── Subscribes to each running sandbox's OpenCode SSE      │   │
│  │  ├── Handles reconnection with exponential backoff          │   │
│  │  └── Triggers query invalidation on relevant events         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                          ▲                                          │
│                          │ SSE Streams                              │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│                          │                                          │
│  OpenCode Instances (via Caddy proxy)                               │
│  ├── sandbox-abc.opencode.nivelais.com/event/subscribe             │
│  ├── sandbox-def.opencode.nivelais.com/event/subscribe             │
│  └── ...                                                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### SSE Events to Handle

| Event Type | Action | Query to Invalidate |
|------------|--------|---------------------|
| `session.status` | Update session status | `['opencode', baseUrl, 'sessions']` |
| `session.idle` | Mark session as idle | `['opencode', baseUrl, 'sessions']` |
| `message.created` | Update last message | `['opencode', baseUrl, 'sessions']` |
| `session.created` | New sub-session | `['opencode', baseUrl, 'sessions']` |

### Hook Implementation Outline

```typescript
// hooks/use-opencode-events.ts

export function useOpencodeEvents() {
  const queryClient = useQueryClient();
  const { data: sandboxes } = useQuery(sandboxListQuery());
  
  const runningSandboxes = useMemo(
    () => sandboxes?.filter(s => s.status === 'running') ?? [],
    [sandboxes]
  );

  useEffect(() => {
    const connections = new Map<string, AbortController>();

    for (const sandbox of runningSandboxes) {
      const baseUrl = sandbox.runtime.urls.opencode;
      const controller = new AbortController();
      connections.set(sandbox.id, controller);

      subscribeToOpencode(baseUrl, {
        signal: controller.signal,
        onEvent: (event) => {
          // Invalidate relevant queries based on event type
          if (event.type.startsWith('session.') || event.type === 'message.created') {
            queryClient.invalidateQueries({
              queryKey: queryKeys.opencode.sessions(baseUrl),
            });
          }
        },
        onError: (error) => {
          console.error(`SSE error for ${sandbox.id}:`, error);
          // Will auto-reconnect via OpenCode SDK
        },
      });
    }

    return () => {
      for (const controller of connections.values()) {
        controller.abort();
      }
    };
  }, [runningSandboxes, queryClient]);
}
```

### Query Configuration Changes

```typescript
// Remove refetchInterval for session queries when SSE is active
export const opencodeSessionsQuery = (baseUrl: string) =>
  queryOptions({
    queryKey: queryKeys.opencode.sessions(baseUrl),
    queryFn: () => fetchOpenCodeSessions(baseUrl),
    // Remove: refetchInterval: 10000,
    staleTime: 30000, // Trust SSE for updates
    enabled: !!baseUrl,
  });
```

---

## 6. View Designs

### 6.1 Dashboard (Home) - `/`

```
┌─────────────────────────────────────────────────────────────────────┐
│  Welcome back                                                        │
│  3 tasks need your attention                                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │ X 2     │ │ X 3     │ │ X 1     │ │ X 2     │ │ X 12    │       │
│  │Attention│ │ Queued  │ │ Running │ │ Review  │ │ Done    │       │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
│                                                                     │
│  +- Needs Your Attention ----------------------------------------+ │
│  |                                                                | │
│  | [X] Add dark mode toggle                          frak-sandbox | │
│  |     AI: "Should I use CSS variables or Tailwind?"             | │
│  |     2 min ago                         [Reply] [View] [VSCode]  | │
│  | ----------------------------------------------------------------| │
│  | [X] Fix auth redirect loop                        other-proj   | │
│  |     AI: "I found 3 potential issues. Which first?"            | │
│  |     15 min ago                        [Reply] [View] [VSCode]  | │
│  |                                                                | │
│  +----------------------------------------------------------------+ │
│                                                                     │
│  +- Running Sessions -----------------+ +- Quick Start -----------+ │
│  |                                    | |                          | │
│  | [>] Refactor API layer            | | Workspace: [frak-sb v]   | │
│  |     Progress: 3/5 ========--      | |                          | │
│  |     [View] [VSCode] [SSH]         | | +----------------------+ | │
│  |                                    | | | Describe your task...| | │
│  | [Z] Setup unit tests (idle)       | | +----------------------+ | │
│  |     Waiting for input             | |                          | │
│  |     [Continue] [VSCode]           | | [Create Task] [Chat]     | │
│  |                                    | |                          | │
│  +------------------------------------+ +--------------------------+ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Components:**
- `StatusOverview` - Clickable status count cards
- `AttentionList` - Tasks needing attention with last AI message
- `RunningSessions` - Currently active sessions with progress
- `QuickStart` - New task creation / quick chat widget

**Data Sources:**
- Tasks list (filtered by status)
- Sessions with status from SSE
- Workspaces for quick start dropdown

---

### 6.2 Kanban Board - `/tasks`

```
┌─────────────────────────────────────────────────────────────────────┐
│  Tasks                                    [Workspace: All v] [+ ]   │
│  Manage AI coding tasks                                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  +- Draft ------+ +- Queued -----+ +- In Progress -+ +- Review ---+ │
│  | 2 tasks      | | 3 tasks      | | 1 task        | | 2 tasks    | │
│  |              | |              | |               | |            | │
│  | +----------+ | | +----------+ | | +-----------+ | | +--------+ | │
│  | | Add auth | | | | Fix nav  | | | | [>] Refact| | | | [X] Dark| │
│  | |          | | | | [~] #2   | | | | API layer | | | | mode    | │
│  | | draft    | | | | 10m ago  | | | | ====-- 3/5| | | |         | │
│  | | [Edit]   | | | +----------+ | | | [VSCode]  | | | | Waiting | │
│  | +----------+ | |              | | | [SSH]     | | | | [Reply] | │
│  |              | | +----------+ | | +-----------+ | | +--------+ | │
│  | +----------+ | | | Setup CI | | |               | |            | │
│  | | New feat | | | | [~] #3   | | |               | | +--------+ | │
│  | |          | | | | 1h ago   | | |               | | | Auth   | │
│  | | [Edit]   | | | +----------+ | |               | | | fix    | │
│  | +----------+ | |              | |               | | | Done   | │
│  |              | |              | |               | | |[Approve]| │
│  | [+ Add]      | |              | |               | | +--------+ | │
│  +--------------+ +--------------+ +---------------+ +------------+ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Task Card Elements:**
- Status indicator icon (color-coded)
- Task title
- Last AI message preview (for attention/review states)
- Progress bar with count (for in_progress)
- Branch name (collapsible)
- Time since last update
- Quick actions: VSCode, SSH, Reply (contextual)

**Card Status Icons:**
- `[X]` Red dot = Needs attention (idle + AI message)
- `[>]` Green pulse = Running
- `[~]` Yellow = Queued
- `[Z]` Gray = Idle
- `[✓]` Green check = Review complete

---

### 6.3 Task Detail - `/tasks/$id`

```
┌─────────────────────────────────────────────────────────────────────┐
│  < Tasks    Add dark mode toggle                    frak-sandbox    │
│             [X] Waiting for your input   [> VSCode] [SSH] [Term]    │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  +- Session Chat ---------------------+ +- Task Info -------------+ │
│  |                                    | |                          | │
│  |  [U] You (2h ago)                  | | Description              | │
│  |  Add a dark mode toggle to the    | | Add a dark mode toggle   | │
│  |  settings page. Use Tailwind...   | | to the settings page...  | │
│  |                                    | |                          | │
│  |  [A] Claude (1h ago)               | | Branch                   | │
│  |  I'll implement this using        | | task/dark-mode-toggle    | │
│  |  Tailwind's dark mode. Should I   | |                          | │
│  |  use CSS variables or...          | | Progress                 | │
│  |                                    | | ========---- 3/5         | │
│  |  [View full conversation ->]      | |                          | │
│  |                                    | | Created 2h ago           | │
│  | +--------------------------------+ | | Last update 5m ago       | │
│  | | Your reply...                  | | |                          | │
│  | +--------------------------------+ | | Sandbox                  | │
│  | [Send]              [Open Full ->]| | sbx-abc123 (running)     | │
│  |                                    | | [View Sandbox ->]        | │
│  +------------------------------------+ +--------------------------+ │
│                                                                     │
│  +- Sub-sessions ---------------------------------------------------+│
│  | [✓] Research dark mode patterns                      10:30 AM    │
│  | [✓] Create theme context                             10:45 AM    │
│  | [✓] Add toggle component                             11:00 AM    │
│  | [~] Update existing components                       (running)   │
│  | [ ] Test across browsers                             (pending)   │
│  +------------------------------------------------------------------+│
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Chat Embed (Minimal):**
- Last user message (truncated if long)
- Last agent response (truncated if long)
- "View full conversation" link -> OpenCode WebUI with session ID
- Simple reply input
- Send button
- "Open Full" button -> OpenCode WebUI

---

### 6.4 Sessions View - `/sessions`

```
┌─────────────────────────────────────────────────────────────────────┐
│  Sessions                             [Filter: All v] [Sort: Recent]│
│  All active OpenCode sessions                                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  +- Needs Attention (2) ----------------------------------------+   │
│  |                                                              |   │
│  | [X] Add dark mode toggle                      frak-sandbox   |   │
│  |     "Should I use CSS variables or Tailwind's dark mode?"   |   │
│  |     Waiting 2m                 [Reply] [View Full] [VSCode]  |   │
│  |                                                              |   │
│  | [X] Fix auth redirect                         other-project  |   │
│  |     "I found 3 issues. Which should I fix first?"           |   │
│  |     Waiting 15m                [Reply] [View Full] [VSCode]  |   │
│  |                                                              |   │
│  +--------------------------------------------------------------+   │
│                                                                     │
│  +- Running (1) ------------------------------------------------+   │
│  |                                                              |   │
│  | [>] Refactor API layer                        frak-sandbox   |   │
│  |     Working on: "Extracting service layer..."               |   │
│  |     Progress: 3/5              [View Full] [VSCode] [SSH]    |   │
│  |                                                              |   │
│  +--------------------------------------------------------------+   │
│                                                                     │
│  +- Idle (3) ---------------------------------------------------+   │
│  |                                                              |   │
│  | [Z] Setup unit tests                          frak-sandbox   |   │
│  |     Completed initial setup                  [Continue] ...  |   │
│  |                                                              |   │
│  | [Z] Chat session                              other-project  |   │
│  |     Last: "Thanks, that's helpful!"          [Continue] ...  |   │
│  |                                                              |   │
│  +--------------------------------------------------------------+   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Grouping:** By status (Attention -> Running -> Idle)

**Filter Options:**
- All / Needs Attention / Running / Idle
- By workspace

---

### 6.5 Collapsible Sidebar

```
+-------------+     +---+
| Expanded    |     | > | Collapsed (icons only)
+-------------+     +---+
| [H] Home    |     |[H]|
| [T] Tasks   |     |[T]|
| [S] Sessions|     |[S]|
|             |     |   |
| v Dev Tools |     |---|
|   [B] Sand..|     |[B]|
|   [W] Work..|     |[W]|
|             |     |   |
| v Admin     |     |---|
|   [G] System|     |[G]|
|   [D] Images|     |[D]|
|   [C] Config|     |[C]|
|             |     |   |
| ----------- |     |---|
| [U] Profile |     |[U]|
| [O] Sign out|     |[O]|
|      <      |     | > | Toggle button
+-------------+     +---+
```

**Icons (Lucide):**
- Home: `Home`
- Tasks: `Kanban`
- Sessions: `MessageSquare`
- Sandboxes: `Boxes`
- Workspaces: `FolderGit2`
- System: `Server`
- Images: `HardDrive`
- Config: `Settings`
- Profile: `User`
- Sign out: `LogOut`

**Behavior:**
- Collapse state persisted in localStorage
- Tooltips on hover when collapsed
- Smooth width transition animation
- Active item highlighted
- Badge counts on icons (attention count on Tasks/Sessions)

---

## 7. Component Guidelines

### React Best Practices

| Pattern | Apply To | Example |
|---------|----------|---------|
| Extract custom hooks | Data fetching, complex state | `useTaskSessions(taskId)` |
| Compound components | Complex UI with shared state | Kanban board |
| Children/render props | Flexible containers | `<EmptyState>` |
| forwardRef | Interactive elements | Form inputs, buttons |
| React.memo | Expensive list items | `TaskCard`, `SessionCard` |
| useCallback | Event handlers passed as props | Click handlers |
| useMemo | Computed values | Filtered/sorted lists |

### TanStack Query Best Practices

| Pattern | Description |
|---------|-------------|
| `queryOptions` helper | Type-safe query definitions |
| Query key factory | Centralized `queryKeys` object |
| Suspense boundaries | Route-level loading with `pendingComponent` |
| Optimistic updates | Immediate UI feedback for mutations |
| Select transform | Shape data in query, not component |
| Enabled flag | Conditional fetching |
| Prefetching | Preload data on hover/focus |

### Query Keys Factory

```typescript
// api/queries.ts
export const queryKeys = {
  // Sandbox queries
  sandboxes: {
    all: ['sandboxes'] as const,
    list: (filters?: SandboxFilters) => ['sandboxes', 'list', filters] as const,
    detail: (id: string) => ['sandboxes', 'detail', id] as const,
  },
  
  // Task queries
  tasks: {
    all: ['tasks'] as const,
    list: (workspaceId?: string) => ['tasks', 'list', workspaceId] as const,
    detail: (id: string) => ['tasks', 'detail', id] as const,
    attention: () => ['tasks', 'attention'] as const,
  },
  
  // OpenCode queries
  opencode: {
    sessions: (baseUrl: string) => ['opencode', baseUrl, 'sessions'] as const,
    status: (baseUrl: string) => ['opencode', baseUrl, 'status'] as const,
  },
  
  // ... etc
} as const;
```

### Code Cleanup Checklist

- [ ] Extract all mutations from `queries.ts` to `mutations.ts`
- [ ] Create `queryKeys` factory for all queries
- [ ] Add error boundaries per route segment
- [ ] Standardize loading skeletons (create reusable components)
- [ ] Remove inline styles -> Tailwind classes
- [ ] Add proper TypeScript for all event handlers
- [ ] Use `useCallback`/`useMemo` appropriately (check React DevTools)
- [ ] Extract magic numbers to `lib/constants.ts`
- [ ] Remove unused imports and dead code
- [ ] Consistent naming: `use*Query` hooks, `*Dialog` for modals

---

## 8. Implementation Phases

### Phase 1: Foundation (3-4 days)

**Goal:** Set up new architecture without breaking existing functionality

| Task | File(s) | Priority |
|------|---------|----------|
| Create new folder structure | All | High |
| Implement collapsible sidebar | `components/layout/*` | High |
| Create `SidebarNav` with groups | `components/layout/sidebar-nav.tsx` | High |
| Add localStorage persistence for sidebar | `hooks/use-sidebar-state.ts` | Medium |
| Create shared components | `components/shared/*` | Medium |
| Update route structure (admin group) | `routes/admin/*` | Medium |
| Create `queryKeys` factory | `api/queries.ts` | High |
| Extract mutations | `api/mutations.ts` | Medium |

**Deliverable:** New sidebar working, routes reorganized, foundation components ready.

---

### Phase 2: Real-Time + Sessions View (4-5 days)

**Goal:** SSE integration and new sessions view

| Task | File(s) | Priority |
|------|---------|----------|
| Create SSE subscription logic | `api/opencode/events.ts` | High |
| Implement `useOpencodeEvents` hook | `hooks/use-opencode-events.ts` | High |
| Create `SessionStatusBadge` | `components/sessions/status-badge.tsx` | High |
| Create `SessionCard` component | `components/sessions/session-card.tsx` | High |
| Create `SessionChatPreview` | `components/sessions/session-chat-preview.tsx` | High |
| Build `/sessions` route | `routes/sessions/index.tsx` | High |
| Create `useAllSessions` hook | `hooks/use-all-sessions.ts` | Medium |
| Remove polling for session status | `api/queries.ts` | Medium |

**Deliverable:** Real-time session status, new Sessions view working.

---

### Phase 3: Dashboard Redesign (3-4 days)

**Goal:** New dashboard with attention indicators

| Task | File(s) | Priority |
|------|---------|----------|
| Create `StatusOverview` cards | `components/dashboard/status-overview.tsx` | High |
| Create `AttentionList` component | `components/dashboard/attention-list.tsx` | High |
| Create `useAttentionTasks` hook | `hooks/use-attention-tasks.ts` | High |
| Create `QuickStart` widget | `components/dashboard/quick-start.tsx` | Medium |
| Create `RunningSessions` widget | `components/dashboard/running-sessions.tsx` | Medium |
| Redesign `/` route | `routes/index.tsx` | High |
| Wire up real-time updates | Integration | Medium |

**Deliverable:** New dashboard with real-time attention indicators.

---

### Phase 4: Enhanced Kanban (3-4 days)

**Goal:** Improved task cards and board

| Task | File(s) | Priority |
|------|---------|----------|
| Redesign `TaskCard` with status | `components/tasks/kanban/card.tsx` | High |
| Add last message preview | `components/tasks/kanban/card.tsx` | High |
| Create `CardActions` component | `components/tasks/kanban/card-actions.tsx` | Medium |
| Add workspace filter | `components/tasks/kanban/filters.tsx` | Medium |
| Improve drag feedback | `components/tasks/kanban/board.tsx` | Low |
| Update `/tasks` route | `routes/tasks/index.tsx` | High |

**Deliverable:** Enhanced kanban with real-time status and quick actions.

---

### Phase 5: Task Detail View (4-5 days)

**Goal:** New `/tasks/$id` route with embedded chat

| Task | File(s) | Priority |
|------|---------|----------|
| Create `/tasks/$id` route | `routes/tasks/$id.tsx` | High |
| Build task detail panel layout | `components/tasks/detail/panel.tsx` | High |
| Create `InfoSidebar` component | `components/tasks/detail/info-sidebar.tsx` | Medium |
| Implement `ChatEmbed` component | `components/tasks/detail/chat-embed.tsx` | High |
| Create reply functionality | API integration | High |
| Create `SubsessionsList` | `components/tasks/detail/subsessions-list.tsx` | Medium |
| Add link to OpenCode WebUI | Integration | High |

**Deliverable:** Task detail view with minimal chat embed.

---

### Phase 6: Profile + Cleanup (2-3 days)

**Goal:** User profile and code cleanup

| Task | File(s) | Priority |
|------|---------|----------|
| Create `/profile` route | `routes/profile.tsx` | High |
| Move SSH keys section | `components/profile/ssh-keys-section.tsx` | High |
| Update `/admin/config` | `routes/admin/config.tsx` | Medium |
| Add error boundaries | All routes | Medium |
| Final code review and cleanup | All files | Medium |
| Remove dead code | All files | Low |
| Update `AGENTS.md` docs | `apps/dashboard/AGENTS.md` | Low |

**Deliverable:** Complete refactored dashboard.

---

## 9. Technical Specifications

### Session Status Types

```typescript
// From OpenCode SDK
type SessionStatus =
  | { type: 'idle' }
  | { type: 'retry'; attempt: number; message: string; next: number }
  | { type: 'busy' };

// Dashboard-specific attention state
type AttentionState = 
  | 'none'           // No attention needed
  | 'waiting'        // Idle + last message from AI
  | 'retry'          // Retry status
  | 'review';        // Task in pending_review

function getAttentionState(
  sessionStatus: SessionStatus,
  lastMessageFrom: 'user' | 'agent' | null,
  taskStatus: TaskStatus
): AttentionState {
  if (taskStatus === 'pending_review') return 'review';
  if (sessionStatus.type === 'retry') return 'retry';
  if (sessionStatus.type === 'idle' && lastMessageFrom === 'agent') return 'waiting';
  return 'none';
}
```

### Chat Embed Message Structure

```typescript
interface ChatEmbedProps {
  sessionId: string;
  opencodeUrl: string;
  lastUserMessage: {
    text: string;
    timestamp: number;
  } | null;
  lastAgentMessage: {
    text: string;
    timestamp: number;
  } | null;
  onSendMessage: (text: string) => Promise<void>;
  onOpenFull: () => void; // Navigate to OpenCode WebUI
}
```

### Sidebar State

```typescript
// hooks/use-sidebar-state.ts
const STORAGE_KEY = 'sidebar-collapsed';

export function useSidebarState() {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(STORAGE_KEY) === 'true';
  });

  const toggle = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  return { collapsed, toggle };
}
```

### OpenCode WebUI URL Builder

```typescript
// lib/utils.ts
export function buildOpenCodeSessionUrl(
  baseUrl: string,
  directory: string,
  sessionId: string
): string {
  const url = new URL(baseUrl);
  url.searchParams.set('directory', directory);
  url.searchParams.set('session', sessionId);
  return url.toString();
}
```

---

## Appendix: File Migration Map

| Current File | New Location | Action |
|--------------|--------------|--------|
| `components/kanban/*` | `components/tasks/kanban/*` | Move + enhance |
| `components/ssh-keys-section.tsx` | `components/profile/ssh-keys-section.tsx` | Move |
| `components/system-status-footer.tsx` | Keep in place | Keep |
| `components/github-status.tsx` | Keep in place | Keep |
| `hooks/use-all-opencode-sessions.ts` | `hooks/use-all-sessions.ts` | Rename + refactor |
| `lib/session-hierarchy.ts` | `lib/session-helpers.ts` | Rename |
| `routes/settings/index.tsx` | `routes/admin/config.tsx` | Move + modify |
| `routes/system/index.tsx` | `routes/admin/system.tsx` | Move |
| `routes/images/index.tsx` | `routes/admin/images.tsx` | Move |

---

## Appendix: Lucide Icons Reference

```typescript
import {
  // Navigation
  Home,
  Kanban,
  MessageSquare,
  Boxes,
  FolderGit2,
  Server,
  HardDrive,
  Settings,
  User,
  LogOut,
  
  // Status indicators
  Circle,          // Idle (gray)
  CircleDot,       // Running (green pulse)
  AlertCircle,     // Attention (red)
  CheckCircle,     // Complete (green)
  Clock,           // Queued (yellow)
  RefreshCw,       // Retry (orange)
  
  // Actions
  Play,
  Pause,
  ExternalLink,
  Code,            // VSCode
  Terminal,
  Copy,
  Trash2,
  Plus,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  
  // Other
  GitBranch,
  Loader2,         // Loading spinner
} from 'lucide-react';
```
