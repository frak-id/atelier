# GitHub Gateway Integration

> Tag `@atelier` in any GitHub issue, PR, or discussion — get an AI-powered sandbox that writes code and reports back.

## Overview

The GitHub gateway extends Atelier's external integration system to GitHub. Like the existing Slack integration, it lets developers trigger AI tasks by mentioning `@atelier` directly in GitHub conversations. The AI spins up a sandboxed dev environment, works on the request, and posts progress and results back as GitHub comments.

The key difference from the Slack gateway: **GitHub webhooks carry repository context** (owner, repo, branch, PR metadata), so the gateway can deterministically match a webhook to a workspace without needing the system sandbox dispatcher. This makes the GitHub flow faster, cheaper, and more predictable.

---

## User Experience

### Tagging Atelier in an Issue

```
Developer creates issue: "Add rate limiting to the API"
Developer comments: "@atelier implement this"

  → 👀 reaction appears on the comment (instant acknowledgment)
  → Atelier posts a progress comment (updated in-place):

      🔧 Atelier is working

      Workspace: api-server
      Branch: task/xyz123 (based on main)

      - [x] Cloned repository
      - [x] Analyzing codebase
      - [ ] Implementing rate limiter middleware
      - [ ] Adding configuration

      View in Dashboard · OpenCode

  → When done, the comment updates to:

      ✅ Done — 4m 23s

      Opened PR #47: task/xyz123 → main

      <details>
      <summary>Changes summary</summary>
      - Added RateLimiter middleware
      - Applied to all /api/* routes
      </details>

  → 👀 replaced with 🚀 on the original comment
```

### Tagging Atelier in a PR

```
Someone opens PR #42, then comments: "@atelier /review"

  → 👀 reaction
  → Atelier spins up a sandbox with the PR branch checked out
  → Runs a review session
  → Posts a PR review with inline code comments and suggestions:

      ⚠️ Token stored in localStorage — consider httpOnly cookies.

      ```suggestion
      setCookie("auth_token", token, { httpOnly: true, secure: true });
      ```

  → Developer replies to inline comment:
     "@atelier good point, but we need localStorage for mobile.
      Can you make it configurable?"
  → Atelier continues in the same sandbox session
```

### Replying in the Same Thread

Follow-up comments in the same issue/PR thread route to the **same sandbox**. No need to reference task IDs — thread continuity is automatic.

```
Issue #123:
  @johndoe: "@atelier add pagination to the users endpoint"
  @atelier: [works, creates PR]

Later in the same issue:
  @johndoe: "@atelier also add sorting by email"
  → Routes to the SAME sandbox, adds to the existing branch
```

### GitHub Discussions

Discussions work the same way. Tag `@atelier` in a Q&A or general discussion to get exploratory analysis or architecture proposals — without necessarily creating a PR.

---

## Commands

The same command set used in Slack works in GitHub. All commands are parsed from the comment body after the `@atelier` mention.

| Command | Description | Example |
|---------|-------------|---------|
| *(plain text)* | Continue existing task, or create new one | `@atelier fix the auth bug` |
| `/new` | Explicitly create a new task | `@atelier /new implement caching` |
| `/add` | Add an implementation session to existing task | `@atelier /add also handle edge cases` |
| `/review` | Run a best-practices review session | `@atelier /review` |
| `/security` | Run a security-focused review | `@atelier /security` |
| `/simplify` | Run a simplification/refactor session | `@atelier /simplify` |
| `/dev start` | Start a dev server, post preview URL | `@atelier /dev start` |
| `/dev stop` | Stop a running dev server | `@atelier /dev stop` |
| `/status` | Show current task and sandbox status | `@atelier /status` |
| `/cancel` | Cancel the current running session | `@atelier /cancel` |
| `/restart` | Restart with a fresh session | `@atelier /restart with a different approach` |
| `/help` | Show available commands | `@atelier /help` |

---

## GitHub Entry Points

### Webhook Events

The gateway listens for three GitHub webhook event types:

| Event | Trigger | Use Case |
|-------|---------|----------|
| `issue_comment.created` | Comment on an issue **or** PR | Primary trigger — covers both issues and PR conversation threads |
| `pull_request_review_comment.created` | Inline comment on a PR diff | Responding to code-specific review threads with diff context |
| `discussion_comment.created` | Comment in a GitHub Discussion | Exploration, architecture questions, Q&A |

**Important**: In GitHub's API, PRs are a superset of issues. An `issue_comment` event fires for comments on both issues and PRs. The gateway distinguishes them by checking for the `pull_request` field in the payload.

### Trigger Mechanism

The bot activates when **all conditions are met**:

1. **`@atelier` is mentioned** in the comment body
2. **The commenter is not the bot itself** (prevents infinite loops)
3. **The commenter has write access** (owner, member, or collaborator — prevents abuse from public users)

### Thread Key Format

Each conversation thread maps to a unique task. The thread key format:

| Context | Thread Key | Example |
|---------|-----------|---------|
| Issue | `owner/repo#N` | `acme/api#123` |
| PR | `owner/repo#N` | `acme/api#456` (same namespace as issues) |
| Discussion | `owner/repo!N` | `acme/api!789` (separate namespace) |

Inline PR review comments share the same thread key as their parent PR — they route to the same task and sandbox.

---

## Context Extraction

What the AI receives depends on the event type. The goal is to give it the **map** (metadata, structure) rather than the **territory** (full file contents, full diffs) — the agent runs in a sandbox with the full repo and can explore itself.

### Issue Context

```
Title, body, author, labels
All comments in the thread (paginated)
```

### PR Context

```
Title, body, author, labels
Head branch → base branch (e.g., feature/rate-limit → main)
Changed files list with line counts (not the full diff)
All conversation comments (paginated)
Linked issues (if any)
```

The agent can `git diff` in its sandbox if it needs the actual diff content. Inlining large diffs would waste context window for no benefit.

### Inline Review Comment Context

```
File path and line number
The specific diff hunk (the code being discussed)
The full review thread (all replies in this inline conversation)
Parent PR metadata (title, branches)
```

Here the diff hunk **is** essential — it's the specific code under discussion and gives the agent precise context about what to address.

### Discussion Context

```
Title, body, author, category
All replies in the thread (paginated)
```

---

## Feedback Signals

Real-time feedback so developers know what's happening without watching a dashboard.

| Signal | When | What the developer sees |
|--------|------|------------------------|
| 👀 reaction on comment | Immediately (< 1s) | "Atelier saw my request" |
| Progress comment posted | ~2-3s after trigger | Live task list, workspace info, dashboard links |
| Progress comment updated in-place | Every few seconds | Todos checked off, status changes |
| ⚠️ in progress comment | When attention needed | Agent has a question or needs permission |
| 🚀 reaction replaces 👀 | On completion | "It's done" |
| Final comment update | On completion | Summary, PR link, elapsed time |

The progress comment is **edited in-place** rather than posting multiple comments. This avoids notification spam and keeps the thread clean.

---

## Architecture Decisions

### GitHub App (Not GitHub Actions)

Atelier already runs server infrastructure (K8s, Bun API). A GitHub App provides:

- **Sub-second reaction time** — webhook hits the server directly, no CI cold start
- **Clean bot identity** — comments appear from `atelier[bot]`, not `github-actions[bot]`
- **One installation covers the whole org** — no per-repo workflow files needed
- **Better rate limits** — GitHub Apps get higher API quotas than Actions tokens

oh-my-openagent uses GitHub Actions (zero infrastructure, good for open-source), but that comes with a 30-60s cold start on every trigger. Since Atelier is self-hosted with existing infrastructure, the App approach is the right tradeoff.

### Direct Task Creation (No System Sandbox Dispatcher)

The Slack gateway uses a "system sandbox" — a lightweight shared sandbox running an AI dispatcher agent that reads the message, picks the best workspace, and creates a task. This is necessary for Slack because a Slack channel has **no inherent link** to a repository.

GitHub webhooks are different: **every event carries `owner/repo`** in the payload. The gateway can call `workspaceService.matchByRemoteUrl()` to deterministically find the matching workspace. No AI reasoning needed.

| | Slack | GitHub |
|---|---|---|
| Workspace selection | AI dispatcher reads workspace descriptions | `matchByRemoteUrl(owner/repo)` — deterministic |
| Task title | AI-generated | PR/issue title from payload + background AI refinement |
| Branch info | Unknown | Known from PR metadata |
| System sandbox needed | Yes | No |

This makes the GitHub flow faster (no dispatcher boot), cheaper (no extra sandbox), and more predictable (no AI in the routing path).

### Webhook Processing

GitHub drops webhook connections after 10 seconds. The gateway must:

1. Verify the `X-Hub-Signature-256` signature
2. Deduplicate by `X-GitHub-Delivery` header (GitHub retries on timeout)
3. Return `202 Accepted` immediately
4. Process the event asynchronously

This is the same pattern used by the Slack integration — verify, acknowledge, process in background.

---

## Inspiration

This integration is inspired by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (formerly oh-my-opencode), which implements a GitHub pipeline where an AI agent is triggered by `@mention` in issue/PR comments. Their approach uses GitHub Actions as the runner, with reaction-based UX (👀 → 👍) for feedback.

Atelier's approach differs in using a GitHub App with a persistent webhook endpoint (lower latency), direct workspace matching (no dispatcher), and the existing integration adapter architecture for a consistent experience across Slack and GitHub.

Other references:
- **CodeRabbit** — Buffer pattern (webhook → queue → worker), progressive comment updates
- **KiloCode** — Slash command triggers (`/kilo`), permission guards, mention detection
- **Sweep AI** — Issue-to-PR automation, label-based triggers

---

## Open Questions

1. **GitHub App identity** — Use a dedicated GitHub App (`atelier[bot]`) or reuse the existing GitHub OAuth token from GitSource? The App gives a cleaner identity and dedicated webhook URL. The OAuth token is already configured but acts as a user, not a bot.

2. **Auto-review on PR open** — Should `pull_request.opened` be a trigger from day one (auto-review every new PR in configured repos), or start with on-demand `@atelier` mentions only?

3. **Multiple workspaces, same repo** — If two workspaces reference the same repo (different configs or branches), should the gateway take the first match, or post a comment asking which workspace to use?
