# Idle auto-pause: pause sandboxes nobody is using

> Status: **implemented**, defaults are first guesses (no calibration spike);
> revisit them after the first deployment (§9).
> Code: agent `apps/agent/src/activity/` (`GET /activity`) · runtime
> `apps/server/src/runtime/activity.ts` (recorder) · policy
> `apps/server/src/control/modules/idle-policy/` · reaper
> `apps/server/src/api/idle-reaper.ts` · contract
> `packages/spec/src/sandbox-activity.ts`.

## 1. Problem

A running sandbox holds a Kata VM (2 vCPU / 4 GiB by default) until someone
pauses it, and nothing pauses it for them. A forgotten sandbox, or a
Launchpad workspace whose owner closed the tab, runs all night.

Pause and resume already work (`runtime.pause()` syncs, snapshots, deletes
the pod and keeps the PVC). What was missing: knowing a sandbox is unused,
and operator rules for acting on it.

## 2. Decisions

| Question | Decision |
|---|---|
| Network | Inbound **and** outbound traffic count. Inbound: people using the sandbox's hostnames, SSH. Outbound: work the sandbox does on its own (an agent streaming from an LLM API, a `git push`). |
| Open but unused connections | Don't count. Only traffic above a byte threshold per minute counts, so a forgotten code-server tab exchanging heartbeats doesn't keep a sandbox awake. |
| CPU | An optional signal, **off** by default (a runaway process would otherwise pin a sandbox forever). |
| Per-process network | Measured and shown in the console as stats. **Not** used by the pause decision. |
| Who sets the rules | The **operator** only, through the server config plane (`sandbox.idle.*`). No org layer: an org can't change the idle time. A user can only ask to keep one sandbox awake, within operator bounds. |
| Agent waiting on a person | A pending ACP permission request **blocks** the pause, as does a turn in flight. |
| Calibration | No P0 spike. Thresholds are guesses (§4), `observe` mode first, tuned after deployment. |

About "DNS queries": sandbox hostnames resolve through wildcard DNS, so no
Atelier component sees a DNS query. We measure the traffic that follows it.

## 3. Signals

Traffic to a sandbox's hostnames goes Traefik → Service → Pod and never
touches the server, so the in-pod agent measures it. The rest is seen by the
server.

| Signal | What counts | Observed by |
|---|---|---|
| `ssh` | Client→sandbox bytes on a shell, exec or sftp channel (in-server SSH gateway). Port forwards (VS Code Remote-SSH) are measured as `network`, because their keepalives must stay under the threshold. | server, `ssh/proxy.ts` |
| `console` | Client→sandbox frames on the attach (rw) and terminal relays: keystrokes, pastes and resizes, not output, and not the replies a terminal emulator sends on its own (cursor position, device attributes, OSC colors), which a TUI may poll. | server, `api/ws-relay.ts` |
| `api` | A mutating runtime call: exec, files, env, process start/stop/add, ports, rw attach (HTTP `/v1` and MCP alike). Reads never count, the console polls them. | runtime |
| `lifecycle` | Create and resume. The idle clock starts there. | runtime |
| `agent` | An ACP turn driven through Atelier: a prompt starting or ending, every `session/update`, a permission request. Any harness speaking ACP, nothing per provider. An agent used through its own terminal or web UI isn't seen here; its LLM traffic, its edits and the user's typing count through `network`, `files` and `console`. | `sessions/acp/agent-dispatch.ts` |
| `networkInbound` / `networkOutbound` | TCP bytes per minute on non-loopback connections, minus the agent's own ports (9998/9997/7681, the server's control traffic). Inbound = the local port is a listener. Counts when a minute's bytes reach the threshold. | agent |
| `files` | Writes under the roots (the home, where repos are cloned), minus excludes. | agent |
| `cpu` | CPU time per minute above a threshold. Off by default. | agent |

A sandbox's last activity is the latest timestamp across the signals the
rules enable; `ssh`, `console`, `api`, `lifecycle` and `agent` always count
(they are a person or a server-driven agent acting).

Agents running outside ACP (Claude Code in a terminal, pi in tmux) show up as
outbound network (LLM streaming) and as file writes.

### 3.1 Agent: `GET /activity`

The agent samples every 5 s into one-minute buckets and keeps the last 60.
It applies no thresholds (the server does) except path filtering, which has
to happen at the source.

- **Network**: `NETLINK_SOCK_DIAG` dump of TCP sockets with `INET_DIAG_INFO`;
  per-socket deltas of `tcpi_bytes_received + tcpi_bytes_acked`, keyed by
  socket cookie. The agent also subscribes to the TCP destroy broadcasts
  (`SKNLGRP_INET{,6}_TCP_DESTROY`, no extra capability needed), which carry
  a closing socket's final `tcp_info`: a connection shorter than a sample (a
  `git fetch`, a one-off request) still counts. Status `sock_diag+destroy`,
  or `sock_diag` when the subscription fails.
- **Network without `inet_diag`**: Kata's stock guest kernel (6.18,
  `clh-runtime-rs`) is built without it. The TCP dump answers ENOENT and the
  destroy broadcasts never fire. The agent then switches for good to the
  interface counters (`/proc/net/dev`, loopback excluded; status `netdev`).
  Those counters include the server's own traffic to the agent (the activity
  poll, a console tab's terminal or logs: about 165 KB a minute was measured
  with the sandbox page open). So the agent counts the payload bytes it
  moves on its control ports (a wrapper on the streams accepted on 9998,
  9997 and 7681) and subtracts them, carrying them one 5 s sample because a
  write is counted before it reaches the wire. What remains is the TCP/IP
  headers of that traffic, a few KB a minute. Interface counters have no
  connection direction, so received + sent count for both directions (an
  `inbound`-only rule keeps such a sandbox awake longer, never pauses it
  early). They have no per-process breakdown either. A custom guest kernel
  with `CONFIG_INET_DIAG` and `CONFIG_INET_TCP_DIAG` brings back the
  sock_diag path without any change here.
- **Per-process stats** (sock_diag only): socket inode → pid through
  `/proc/*/fd`, scanned only when a socket with traffic has no known owner. A
  pid in a supervised process group is reported under the process name from the
  spec (`code-server`, `acp`, …), anything else under its `comm`. Inbound
  traffic relayed by the agent's port forwarder is attributed to the process
  listening on that port's loopback address. A connection that opened and closed
  between two samples has no fd left to resolve: its bytes are listed as
  `short-lived`.
- **Files**: one fanotify mount mark on the `/home/dev` overlay
  (`FAN_MODIFY | FAN_CLOSE_WRITE`), placed once `/run/home-ready` exists and
  re-placed if the overlay is re-mounted. Each event's path is resolved
  through `/proc/self/fd`, filtered by roots and excludes; the agent's own
  writes are dropped. Fallback: inotify on the roots minus excluded
  directories, capped at 8192 watches. Status `fanotify` / `inotify` /
  `pending` / `unavailable` is reported.
- **CPU**: cgroup v2 `cpu.stat` (`usage_usec`), else cgroup v1
  `cpuacct.usage`, else `/proc/stat` (VM-wide in a Kata guest).
- `PUT /activity/settings` replaces the file roots and excludes. The server
  re-sends them whenever the agent reports different ones, so an operator
  edit reaches running sandboxes within a minute. It is a separate endpoint
  because `PUT /config` is `deny_unknown_fields` and an older agent would
  reject an extra block.
- Linux-only code is `cfg`-gated; other OSes compile a stub that reports
  everything `unavailable`.

An agent built before this change answers 404. Its sandbox is still
observed, but never paused when a rule needs an agent-side signal (§5).

## 4. Rules (operator)

Keys in the server config plane (`control/modules/server-config/registry.ts`),
editable live from the console, lockable by environment variable:

| Key | Default | Meaning |
|---|---|---|
| `sandbox.idle.mode` | `observe` | `off`, `observe` (compute and show "would pause at", never pause) or `enforce`. |
| `sandbox.idle.minutes` | `120` | Idle time before a pause. |
| `sandbox.idle.network` | `both` | Which traffic counts: `both`, `inbound`, `outbound`, `off`. |
| `sandbox.idle.networkMinBytesPerMinute` | `65536` | Bytes per minute and direction for a minute to count. Guess: heartbeats of an idle tab or Remote-SSH are a few hundred bytes a minute, a page load or an LLM request is far above. |
| `sandbox.idle.files` | `true` | Whether file writes count. |
| `sandbox.idle.fileRoots` | `/home/dev` | Comma-separated roots. Repos are cloned into the home (`/home/dev/<repo>`). |
| `sandbox.idle.fileExcludes` | `node_modules,.git,.next,.nuxt,.turbo,.cache,dist,build,target,*.log,/home/dev/.*` | Comma-separated path components, or `*.ext` suffixes. `.git` because editor autofetch rewrites `FETCH_HEAD`. An entry starting with `/` is an absolute path pattern (`*` matches within one segment): `/home/dev/.*` drops the tool state hidden at the top of the home (package caches, editor servers, shell history, agent config). |
| `sandbox.idle.cpu` | `false` | Whether CPU counts. |
| `sandbox.idle.cpuMinMillicores` | `250` | Average CPU over a minute for it to count. |
| `sandbox.idle.maxKeepAwakeHours` | `24` | Longest keep-awake a user may set. |
| `sandbox.idle.allowKeepAwakeForever` | `false` | Whether a user may keep a sandbox awake with no end. |

**Keep awake (per sandbox).** `PATCH /v1/sandboxes/:id` takes
`keepAwakeUntil` (ISO timestamp, `"forever"` when allowed, `null` to clear),
stored as the `atelier.dev/keep-awake-until` annotation. Anyone with access
to the sandbox may set it, within the two bounds above.

## 5. The reaper

`api/idle-reaper.ts`, run every minute by `Bun.cron` in `index.ts`
(try/catch-guarded like the other crons), in every server mode; the
`sandbox.idle.mode` key decides what it does. For each running sandbox,
8 at a time:

1. Polls the agent's `/activity` and folds it into the runtime's activity
   recorder with the configured thresholds; re-sends the file settings if
   the agent reports different ones.
2. Evaluates (`IdlePolicyService.evaluate`, pure):
   `lastActiveAt = max(counted signals, lifecycle, recorder start)`,
   `pausesAt = lastActiveAt + minutes`.
3. Blockers, whatever the clock says: an ACP turn in flight, a pending
   permission request, an active job targeting the sandbox (snapshot,
   capture, fork), a lifecycle op in progress, keep-awake in the future, and
   in `enforce` an agent that doesn't report while network/files/CPU are
   enabled.
4. In `enforce`, when due and unblocked: re-polls the agent and re-evaluates
   (closes the race with a user coming back during the tick), then
   `jobs.track({ kind: "sandbox-pause" }, () => runtime.pause(id))` and sets
   `atelier.dev/idle-paused-at`. The reaper clears that annotation once the
   sandbox runs again.

The last evaluation is cached for the activity view and list decorations.

**State is in memory.** The recorder isn't persisted: after a server
restart every sandbox's clock starts from the restart (the agent's 60-minute
buckets refill the network/file history on the first poll). A restart can
delay a pause, never cause an early one.

### Module placement

`check:boundary` holds:

- `runtime/activity.ts`: the recorder (`touch`, `ingest`) and
  `AgentClient.activity` / `putActivitySettings`. Mechanism: thresholds come
  in as arguments.
- `control/modules/idle-policy/`: reads the `sandbox.idle.*` keys, validates
  keep-awake, and the pure `evaluate`.
- `api/idle-reaper.ts`: composes runtime, policy, jobs and the ACP dispatch.
  The SSH proxy, WS relays and `AgentDispatch` get an `onActivity` callback
  wired in `api/container.ts`; `sessions/` never sees policy.

## 6. Surfaces

- `GET /v1/sandboxes/:id/activity`: mode, rule, last activity per signal,
  `lastActiveAt`, `pausesAt`, blockers, keep-awake and its operator bounds,
  the agent's sensor status, per-minute buckets and per-process network
  totals for the last hour.
- `GET /v1/sandboxes` rows carry `idle: { state, lastActiveAt, pausesAt? }`.
- Console: an Activity card on the sandbox page (state, countdown,
  keep-awake menu, signals, traffic by process); the idle state in the
  sandbox list; the rules on the Server configuration page.
- Launchpad workspace (enforce mode only): "Going to sleep in N min because
  nobody is using it · Keep awake 1 more hour" in the last 15 minutes, and
  "It went to sleep after a while without use" once idle-paused.
- CLI: `atelier keep-awake <id> [--for 8h | --forever | --off]`; an IDLE
  column in `atelier ps`; activity in `atelier get`.
- MCP: `get_sandbox` returns `idle`; `sandbox_lifecycle` gains
  `keep_awake` (the surface stays at 14 tools).

## 7. Prior art

- **GitHub Codespaces**: an idle timeout with an org-level maximum. Here only
  the operator sets it.
- **Coder**: autostop with an activity bump from agent-reported sessions. It
  counts sessions; we count bytes, because of the open-tab decision.

## 8. Not in scope

- A notice before pausing through `IntegrationHub` (Slack and friends).
- Wake on request: a paused sandbox's URLs still just fail.
- Dormancy: destroying, or GC'ing snapshots of, long-paused sandboxes.
- Persisting the recorder across restarts.

## 9. To check after the first deployment

1. Per-minute bytes of an idle sandbox with code-server, opencode web, pi-web
   open, and with VS Code Remote-SSH connected (the console's per-process
   table shows them). Adjust `networkMinBytesPerMinute`.
2. ~~fanotify on the overlay inside the Kata guest.~~ Works on the first
   deployment (`clh-runtime-rs`, guest kernel 6.18), as do cgroup v2 CPU and
   the `netdev` network fallback (the guest has no `inet_diag`).
3. How often `observe` would have paused a sandbox someone was using, before
   switching to `enforce`.
