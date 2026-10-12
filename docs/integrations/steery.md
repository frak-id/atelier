# Steery

[Steery](https://steery.dev) puts the questions your agents ask on your
phone. Two things link it to Atelier:

- The `atelier` adapter (`apps/steery-adapter`) runs each conversation in
  its own Atelier sandbox, through the public API with an Atelier API key.
- An agent's permission prompt in an Atelier-driven session is also raised as
  a Steery request, so you can answer it away from the console.

See [README.md](README.md) for what an integration is.

## Enable it (operator)

Integrations are compiled in and off by default. Turn Steery on in the
server's environment (read once at boot):

```bash
ATELIER_INTEGRATION_STEERY=true
# Optional: a self-hosted Steery (https in production). Default https://steery.dev
ATELIER_INTEGRATION_STEERY_URL=https://steery.example.com
```

## Connect it (each person)

In **Settings → Integrations → Steery**:

1. Paste a **Steery API key**: make one with `steery keys create --name
   atelier` (its `secret` shows once). Requests are raised as the person who
   owns that key. It is stored encrypted and never shown again.
2. Optionally set the permission routing: the lowest risk that is sent to
   Steery (`low`, `medium` or `high`, the badge the console shows) and a
   delay in seconds, so Steery is asked only if the console has not
   answered by then.

The same routes work over the API (`GET /api/integrations`, `PUT
/api/integrations/steery/connection`).

## Steery runs on Atelier: the `atelier` adapter

`apps/steery-adapter` is a Steery adapter (Steery's program protocol, built
on [`steery-sdk`](https://github.com/steery-dev/sdk)) that makes an Atelier
server a machine Steery runs conversations on: each conversation gets its own
sandbox, made from the image or snapshot you name, with your org's toolboxes,
secrets and policy applied as for any spawn. Build it, add it to `steery`,
and set the machine up with the server's URL and an Atelier API key:

```bash
cd apps/steery-adapter && cargo build --release --locked
steery programs add target/release/steery-adapter-atelier
ATELIER_API_KEY=atl_… steery setup --adapter atelier \
  --setting ATELIER_URL=https://atelier.example.com --setting ATELIER_API_KEY
```

| Setting | | |
|---|---|---|
| `ATELIER_URL` | required | your Atelier server |
| `ATELIER_API_KEY` | secret, required | an Atelier API key (`atl_…`) |

Create the key in **Settings → API keys**. It has its owner's access, meaning
every sandbox they can reach, so use a dedicated key and revoke it to cut
Steery off. The computer that runs the adapter needs an OpenSSH client
(`ssh`, `ssh-keygen`). Check a build against a server with `steery programs
test target/release/steery-adapter-atelier --setting ATELIER_URL=… --setting
ATELIER_API_KEY`; `cargo test` runs its own tests.

The adapter uses only the public API ([host-provider.md](host-provider.md)):

- `GET /v1/sandboxes?owner=me&metadata={"steery":"host"}` lists its
  sandboxes, re-checking the labels; each carries `metadata.steery-key`, the
  conversation it belongs to. Ensure finds the one for a key, else creates it.
- `POST /v1/sandboxes` creates one (a `202` job), `POST
  /v1/sandboxes/:id/pause` / `resume` / `DELETE` manage it, and `POST
  /v1/sandboxes/:id/fork` copies one into a sandbox the caller owns.
- `PATCH /v1/sandboxes/:id/files` writes files; commands run over the SSH
  gateway (`ssh -p <port> <sandboxId>@<host>`) with an ed25519 key it
  registers under `POST /api/ssh-keys`.

## Outbound: approvals on your phone

When the agent of an Atelier-driven session (console chat, MCP tasks,
Launchpad) asks for permission (ACP `session/request_permission`), the
console lists the prompt as before. If the sandbox owner connected Steery
and the prompt's risk passes their filter, Atelier also raises a Steery
request (`POST /v1/requests`) whose buttons are the options the agent
offered, waits for the answer (`GET /v1/requests/{id}?wait_secs=`) and
passes the pressed option to the agent. The first answer wins: answering in
the console first withdraws the Steery request (`POST
/v1/requests/{id}/report` with `state: withdrawn`). Prompts pending when the
server restarts are lost, as they are in the console.

- Prompts are routed to the sandbox **owner's** connection: a member driving
  the owner's sandbox pings the owner.
- Approvals cover only Atelier-driven sessions. Agents Steery drives in its
  own sandboxes are approved through Steery's own hooks.

## The `steery` toolbox

An org toolbox, auto-injected, that installs the `steery` CLI into
`~/.local/bin` of every sandbox in the org, so agents inside can ask you
through Steery. Create it as an org owner or admin, with the CLI:

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
