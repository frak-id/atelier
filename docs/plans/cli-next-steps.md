# atelier CLI — Next Steps

Status: **plan — post-v1**. The v1 CLI (`apps/cli`) is a thin, dependency-free
client over the `/v1` runtime API and the `/api` control plane. It is fully
functional but deliberately minimal: hand-rolled arg parsing, `fetch`-based
transport, and env-only configuration. This document captures the two
follow-ups we agreed to defer.

Context of today's state:

- **No CLI framework.** `apps/cli/src/index.ts` parses argv by hand
  (`parseArgs` → positionals + a `Map<string, string[]>` flag map, plus a small
  JSONC reader). The only runtime dependency is `@atelier/spec` for types.
- **No stored credentials.** `apps/cli/src/config.ts` reads `ATELIER_API_URL`
  (default `http://localhost:4000`) and `ATELIER_API_KEY` (`atl_…`, required)
  from the environment on every invocation. There is no config file, keychain,
  or `~/.atelier/` — nothing is persisted to disk.

Both are fine for v1. The items below make the CLI pleasant to adopt outside a
pre-wired shell.

---

## 1. Pick a CLI framework/library

**Goal:** replace the hand-rolled `parseArgs`/`USAGE` with a real command
framework so we get subcommand routing, typed flags, generated help, shell
completion, and consistent error/exit-code handling — without bloating the
"thin client" ethos.

**Why now:** the command surface has grown (sandboxes, processes, prebuilds,
toolsets, toolboxes + versions) and the flat `switch` in `index.ts` plus the
manually-maintained `USAGE` string are becoming the bottleneck for adding the
tier-C control-plane commands (api-keys, ssh-keys, secrets, orgs, org-policy,
saved-specs, capabilities).

**Options to evaluate (Bun-compatible, ESM, TS-first):**

- **Bun's built-in `util.parseArgs`** — zero-dep, but no subcommands/help
  generation; only a marginal upgrade over what we have. Reject unless we want
  to stay dependency-free at all costs.
- **[`citty`](https://github.com/unjs/citty)** (UnJS) — tiny, ESM, typed
  subcommands + auto help, minimal deps. Strong fit for a thin client.
- **[`clipanion`](https://github.com/arcanis/clipanion)** — class-based,
  excellent typing and completion (used by Yarn). Heavier, more ceremony.
- **[`commander`](https://github.com/tj/commander.js)** — ubiquitous, stable,
  good help; larger API surface, slightly less TS-native.
- **[`@stricli/core`](https://github.com/bloomberg/stricli)** or **oclif** —
  richer (plugins, completion) but heavier than this CLI warrants.

**Recommendation:** start with **citty** (closest to current philosophy: tiny,
typed, ESM) and only escalate to clipanion/oclif if we need plugins or richer
completion. Keep `@atelier/spec` as the source of truth for request/response
types; the framework only owns parsing/routing/help.

**Acceptance criteria:**

- Each command is its own module (no monolithic `switch`); `client.ts` stays as
  the transport layer, unchanged.
- `--help` and per-command help are generated, not hand-maintained.
- Shell completion (bash/zsh/fish) available or trivially addable.
- Backwards-compatible command names/flags (don't break existing muscle memory:
  `up`, `ps`, `get`, `exec`, `attach`, `toolbox version pin`, …).
- Still runs under Bun with `bin.atelier → dist or src`; no heavy transitive dep
  tree.

---

## 2. Interactive auth + base-URL setup

**Goal:** let a new user go from "installed the CLI" to "authenticated against a
server" without manually exporting env vars — while keeping env vars as the
override for CI/automation (they must always win).

**Config precedence (highest → lowest):**

1. Explicit flags (`--api-url`, `--api-key`) — for one-off overrides.
2. Environment (`ATELIER_API_URL`, `ATELIER_API_KEY`) — CI/automation, current
   behavior, must remain authoritative.
3. Persisted config file — the new interactive layer.
4. Built-in default base URL (`http://localhost:4000`).

**Persisted config file:**

- Location: XDG-style — `${XDG_CONFIG_HOME:-~/.config}/atelier/config.json`
  (respect `XDG_CONFIG_HOME`; fall back to `~/.config`). Consider a
  `profiles` map so one file can hold multiple `{ baseUrl, apiKey }` named
  profiles, selectable via `--profile` / `ATELIER_PROFILE`.
- Permissions: write `0600` (contains a bearer secret). Never log the key;
  redact on any `config`/`whoami` output (show `atl_…abcd` suffix only).
- Shape (v1):
  ```jsonc
  {
    "currentProfile": "default",
    "profiles": {
      "default": { "baseUrl": "http://localhost:4000", "apiKey": "atl_…" }
    }
  }
  ```

**New commands:**

- `atelier login` — interactive:
  1. Prompt for base URL (default `http://localhost:4000`, or reuse existing).
  2. Obtain a key. Two paths:
     - **Paste an existing `atl_…` key** (works today; no server changes).
     - **Mint one for me** — requires a bootstrap: the CLI can't currently
       create its own key without already holding one. Needs a device/OAuth or
       browser-based login flow on the server (see "Server dependency" below).
  3. Validate by calling an authenticated endpoint (e.g. `GET /v1/sandboxes` or
     a lightweight `GET /api/capabilities` + a whoami) and only persist on
     success.
  4. Write the profile to the config file (`0600`).
- `atelier logout [--profile <name>]` — delete the stored key (and optionally
  the profile).
- `atelier config` — show effective config (redacted) and its source
  (flag/env/file/default), for debugging precedence.
- `atelier whoami` — resolve and print the authenticated identity/org.

**Interactive prompts:** use the framework's prompt support or a tiny lib
(e.g. `@clack/prompts` for a nice UX, or Bun's built-in `prompt()` to stay
dep-light). Must degrade gracefully in non-TTY (CI): if stdin isn't a TTY,
skip prompts and rely on flags/env, failing with a clear message.

**Server dependency (for "mint one for me"):** minting a key from an
unauthenticated CLI needs a bootstrap flow the server does not yet expose to the
CLI — e.g. a browser-based device-code / OAuth handshake that returns a scoped
`atl_…` key. Until that exists, `login` should support the **paste-existing-key**
path only, and document that key creation happens via the console or an
authenticated `POST /api-keys`. Track the device/OAuth flow as its own task.

**Acceptance criteria:**

- `ATELIER_API_KEY` / `ATELIER_API_URL` in the environment still override the
  file (CI unaffected).
- Fresh machine: `atelier login` → paste key → validated → persisted → all
  commands work with no env vars set.
- Config file is `0600`; keys never printed in full anywhere.
- Non-TTY invocation never hangs on a prompt.
- `resolveConfig()` in `config.ts` becomes the single merge point for
  flags → env → file → default (keep it the one source of truth).

---

## Out of scope here (tracked elsewhere)

- **Tier-C control-plane commands** (api-keys, ssh-keys, secrets, organizations,
  org-policy, saved-specs/templates, capabilities) — deferred from the
  console-parity pass; land these after the framework migration so each becomes
  a clean per-command module.
- **Agent/terminal session commands** (permissions, questions, todos, terminal)
  — interactive surface; the CLI covers interactivity via `attach` for now.
