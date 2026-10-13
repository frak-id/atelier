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
| Network | Traffic in **and** out counts: people using the sandbox's hostnames, SSH, and work the sandbox does on its own (an agent streaming from an LLM API, a `git push`). |
| Open but unused connections | Don't count. Only traffic above a byte threshold per minute counts, so a forgotten code-server tab exchanging heartbeats doesn't keep a sandbox awake. |
| CPU | An optional signal, **off** by default (a runaway process would otherwise pin a sandbox forever). |
| Per-process network | Not measured. Kata's stock guest kernel has no `inet_diag`, so traffic can't be attributed to a connection, let alone a process; the agent measures per interface. |
| Agents | Nothing per provider. An ACP turn driven through Atelier counts as `agent`; an agent used through its own terminal or web UI counts through what it does (traffic, file edits, the user's typing). |
| Who sets the rules | The **operator** only, through the server config plane (`sandbox.idle.*`). No org layer: an org can't change the idle time. A user can only ask to keep one sandbox awake, for a bounded time. |
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
| `agent` | An ACP turn driven through Atelier: a prompt starting or ending, a permission request (a turn in flight blocks the pause, §5). Any harness speaking ACP. Not `session/update`: the agent's attach bridge replays its output to every new connection, so a reconnect (the console listing sessions) would re-deliver an old turn's updates. | `sessions/acp/agent-dispatch.ts` |
| `network` | Bytes received + sent per minute on the sandbox's interfaces, minus the agent's own control traffic. Counts when a minute reaches the threshold. | agent |
| `files` | Writes under the home (where repos are cloned), minus build output, dependencies and the hidden tool state at the top of the home. | agent |
| `cpu` | CPU time per minute above a threshold. Off by default. | agent |

A sandbox's last activity is the latest timestamp across the signals the
rules enable; `ssh`, `console`, `api`, `lifecycle` and `agent` always count
(they are a person or a server-driven agent acting).

### 3.1 Agent: `GET /activity`

The agent samples every 5 s into one-minute buckets
(`{startMs, receivedBytes, sentBytes, fileWrites, cpuMs}`) and keeps the last
60. It applies no thresholds; the server does.

- **Network** (status `netdev`): the interface counters in `/proc/net/dev`,
  loopback excluded. They include the server's own traffic to the agent
  (the activity poll, a console tab's terminal or logs: about 165 KB a
  minute was measured with the sandbox page open), so the agent counts the
  payload bytes it moves on its control ports (a wrapper on the streams
  accepted on 9998, 9997 and 7681) and subtracts them, carrying them one
  sample because a write is counted before it reaches the wire. What remains
  is the TCP/IP headers of that traffic, a few KB a minute. The first sample
  is a baseline: boot traffic isn't activity.
- **Files** (status `fanotify`): one fanotify mount mark on the `/home/dev`
  overlay (`FAN_MODIFY | FAN_CLOSE_WRITE`), placed once `/run/home-ready`
  exists and re-placed if the overlay is re-mounted. Each event's path is
  resolved through `/proc/self/fd`; the agent's own writes are dropped. A
  write counts under `/home/dev` except in a hidden top-level entry
  (`~/.npm`, `~/.local`, `~/.pi`, shell history…) or under `node_modules`,
  `.git` (editor autofetch rewrites `FETCH_HEAD`), `.next`, `.nuxt`,
  `.turbo`, `.cache`, `dist`, `build`, `target`, `*.log`. The filter is
  compiled in. Both backends grant the agent `CAP_SYS_ADMIN`; without
  fanotify the status is `unavailable`.
- **CPU**: cgroup v2 `cpu.stat` (`usage_usec`), else `/proc/stat` (VM-wide
  in a Kata guest).
- Linux-only code is `cfg`-gated; other OSes compile a stub that reports
  `unavailable`.

An agent built before this change answers 404. Its sandbox is still
observed, but never paused when a rule needs an agent-side signal (§5).

## 4. Rules (operator)

Keys in the server config plane (`control/modules/server-config/registry.ts`),
editable live from the console, lockable by environment variable:

| Key | Default | Meaning |
|---|---|---|
| `sandbox.idle.mode` | `observe` | `off`, `observe` (compute and show "would pause at", never pause) or `enforce`. |
| `sandbox.idle.minutes` | `120` | Idle time before a pause. |
| `sandbox.idle.network` | `true` | Whether network traffic counts. |
| `sandbox.idle.networkMinBytesPerMinute` | `65536` | Bytes (received + sent) per minute for a minute to count. Guess: heartbeats of an idle tab or Remote-SSH are a few hundred bytes a minute, a page load or an LLM request is far above. |
| `sandbox.idle.files` | `true` | Whether file writes count. |
| `sandbox.idle.cpu` | `false` | Whether CPU counts. |
| `sandbox.idle.cpuMinMillicores` | `250` | Average CPU over a minute for it to count. |
| `sandbox.idle.maxKeepAwakeHours` | `24` | Longest keep-awake a user may set. |

**Keep awake (per sandbox).** `PATCH /v1/sandboxes/:id` takes
`keepAwakeUntil` (an ISO timestamp at most `maxKeepAwakeHours` ahead, or
`null` to clear), stored as the `atelier.dev/keep-awake-until` annotation.
Anyone with access to the sandbox may set it.

## 5. The reaper

`api/idle-reaper.ts`, run every minute by `Bun.cron` in `index.ts`
(try/catch-guarded like the other crons), in every server mode; the
`sandbox.idle.mode` key decides what it does. For each running sandbox,
8 at a time:

1. Polls the agent's `/activity` and folds it into the runtime's activity
   recorder with the configured thresholds.
2. Evaluates (`evaluateIdle`, pure):
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

Views (the activity endpoint, list decorations) are computed from the last
poll and never call the agent.

**State is in memory.** The recorder isn't persisted: after a server
restart every sandbox's clock starts from the restart (the agent's 60-minute
buckets refill the network/file history on the first poll). A restart can
delay a pause, never cause an early one.

### Module placement

`check:boundary` holds:

- `runtime/activity.ts`: the recorder (`touch`, `ingest`) and
  `AgentClient.activity`. Mechanism: thresholds come in as arguments.
- `control/modules/idle-policy/`: reads the `sandbox.idle.*` keys, validates
  keep-awake, and the pure `evaluateIdle`.
- `api/idle-reaper.ts`: composes runtime, policy, jobs and the ACP dispatch.
  The SSH proxy, WS relays and `AgentDispatch` get an `onActivity` callback
  wired in `api/container.ts`; `sessions/` never sees policy.

## 6. Surfaces

- `GET /v1/sandboxes/:id/activity`: mode, rule, last activity per signal,
  `lastActiveAt`, `pausesAt`, blockers, keep-awake and its bound, the
  agent's sensor status and the per-minute buckets for the last hour.
- `GET /v1/sandboxes` rows carry `idle: { mode, state, lastActiveAt,
  pausesAt? }`.
- Console: an Activity card on the sandbox page (state, countdown,
  keep-awake menu, signals, traffic per minute); the idle state in the
  sandbox list; the rules on the Server configuration page.
- Launchpad workspace: "It went to sleep after a while without use" once
  idle-paused.
- CLI: `atelier keep-awake <id> (--for 8h | --off)`; an IDLE column in
  `atelier ps`; activity in `atelier get`.
- MCP: `get_sandbox` returns `idle`; `sandbox_lifecycle` gains
  `keep_awake` with `hours` (0 clears; the surface stays at 14 tools).

## 7. Prior art

- **GitHub Codespaces**: an idle timeout with an org-level maximum. Here only
  the operator sets it.
- **Coder**: autostop with an activity bump from agent-reported sessions. It
  counts sessions; we count bytes, because of the open-tab decision.

## 8. Not in scope

- A notice before pausing (Launchpad banner, `IntegrationHub`).
- Keeping a sandbox awake with no end: raise `maxKeepAwakeHours` instead.
- Per-process or per-direction traffic (needs a guest kernel with
  `inet_diag`).
- Editing the file filter at runtime: it is compiled into the agent.
- Wake on request: a paused sandbox's URLs still just fail.
- Dormancy: destroying, or GC'ing snapshots of, long-paused sandboxes.
- Persisting the recorder across restarts.

## 9. To check after the first deployment

1. Per-minute bytes of an idle sandbox with code-server, opencode web,
   pi-web open, and with VS Code Remote-SSH connected (the Activity card's
   bars). Adjust `networkMinBytesPerMinute`.
2. ~~fanotify on the overlay inside the Kata guest.~~ Works on the first
   deployment (`clh-runtime-rs`, guest kernel 6.18), as do cgroup v2 CPU and
   the interface counters (the guest has no `inet_diag`).
3. How often `observe` would have paused a sandbox someone was using, before
   switching to `enforce`.
