# Steery

[Steery](https://steery.dev) puts the questions your agents ask on your
phone. Atelier works with it in three ways, each optional:

- **Steery's `atelier` adapter**: Steery runs each conversation in its own
  Atelier sandbox.
- **The `steery` toolbox**: every sandbox of an org carries the `steery`
  CLI, so agents inside it can ask you through Steery.
- **Permission notifier**: an agent's permission prompt in a sandbox is also
  raised as a Steery request, so you can answer it away from the console.

## Steery's `atelier` adapter

Steery's `atelier` adapter makes an Atelier server a machine Steery runs
conversations on: each conversation gets its own sandbox, made from the
image or snapshot you name, with your org's toolboxes, secrets and policy
applied as for any spawn. Give it the server's URL and an Atelier API key
(**Settings → API Keys**, `atl_…`):

```bash
ATELIER_API_KEY=atl_… curl -fsSL https://steery.dev/install.sh | sh -s -- \
  --adapter atelier --setting ATELIER_URL=https://atelier.example.com \
  --setting ATELIER_API_KEY
```

The adapter uses only the public API:

- `GET /v1/sandboxes?metadata={"steery":"host"}` lists its sandboxes; each
  carries `metadata.steery-key`, the conversation it belongs to.
- `POST /v1/sandboxes` creates one (a `202` job), `POST
  /v1/sandboxes/:id/pause` / `resume` / `DELETE` manage it, and
  `POST /v1/sandboxes/:id/fork` copies one (snapshot + new sandbox with the
  same spec, a `202` job like create).
- `PATCH /v1/sandboxes/:id/files` writes files; commands run over the SSH
  gateway (`ssh -p <port> <sandboxId>@<host>`) with an ed25519 key it
  registers under `POST /api/ssh-keys`. The gateway admits a key only into
  sandboxes its owner created or whose org they belong to.

## The `steery` toolbox

An org toolbox, auto-injected, that installs the `steery` CLI into
`~/.local/bin` of every sandbox in the org. Create it as an org owner or
admin, with the CLI:

```bash
atelier toolbox create steery --org "$ORG" \
  --desc "The Steery CLI, so agents can ask you on your phone" \
  --build 'curl -fsSL https://steery.dev/install.sh | sh -s -- --install-only --to "$HOME/.local/bin"' \
  --path .local/bin/steery --path .local/bin/.steery
```

or the API (the console's **Settings → Toolboxes → New** takes the same
fields):

```bash
curl -X POST "$ATELIER/api/toolboxes?owner=org:$ORG" \
  -H "Authorization: Bearer $ATELIER_API_KEY" -H 'content-type: application/json' \
  -d '{
    "slug": "steery",
    "description": "The Steery CLI, so agents can ask you on your phone",
    "build": ["curl -fsSL https://steery.dev/install.sh | sh -s -- --install-only --to \"$HOME/.local/bin\""],
    "paths": [".local/bin/steery", ".local/bin/.steery"],
    "autoInject": true
  }'
```

`--install-only` puts the binary and its programs in place without signing
in; a person signs a sandbox in with `steery setup` in its terminal.
Rebuilding the toolbox (a new version) picks up a newer `steery`.

## Permission notifier

When a sandbox's agent asks for permission (ACP
`session/request_permission`), the console lists the prompt as before. If
the sandbox's organization turned the notifier on, Atelier also raises it as
a Steery request (`POST /v1/requests`) whose buttons are the options the
agent offered, waits for the answer (`GET /v1/requests/{id}?wait_secs=`) and
passes the pressed option to the agent. The first answer wins: answering in
the console first withdraws the Steery request
(`POST /v1/requests/{id}/report` with `state: withdrawn`). Prompts pending
when the server restarts are lost, as they are in the console.

### Policy

One policy per organization, under **Settings → Org Policy → Steery
notifications** in the console, or `GET`/`PUT /api/steery-notify/:orgId`
(owners and admins write, members read):

| Field | Default | Meaning |
|-------|---------|---------|
| `mode` | `off` | `off`, `all` (every prompt), or `risky` (only prompts at or above `minRisk`) |
| `minRisk` | `high` | `low`, `medium` or `high`, the same risk badge the console shows |
| `delaySeconds` | `0` | Ask Steery only if the console has not answered within this many seconds |
| `tools` | `[]` | Only prompts whose ACP tool kind or title is listed; empty = all |
| `steeryUrl` | `https://steery.dev` | The Steery server |

The Steery API key is the org secret `STEERY_API_KEY`: make one with
`steery keys create --name atelier` (its `secret` shows once). Set it in the
same card, as `apiKey` in the `PUT` body, or under **Settings → Secrets**.
The requests are raised as the person who owns that key.

```bash
curl -X PUT "$ATELIER/api/steery-notify/$ORG" \
  -H "Authorization: Bearer $ATELIER_API_KEY" -H 'content-type: application/json' \
  -d '{"mode":"risky","minRisk":"high","delaySeconds":30,"tools":[],
       "steeryUrl":"https://steery.dev","apiKey":"'"$STEERY_KEY"'"}'
```

### Per-sandbox override

A sandbox's `atelier.dev/steery-notify` annotation (`off`, `all` or `risky`)
replaces its org's `mode`; the other fields still come from the org.
