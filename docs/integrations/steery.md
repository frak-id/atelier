# Steery

[Steery](https://steery.dev) puts the questions your agents ask on your
phone. Atelier works with it in two ways:

- **Permission notifier**: an agent's permission prompt in a sandbox is also
  raised as a Steery request, so you can answer it away from the console.

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

The Steery API key is the org secret `STEERY_API_KEY`. Set it in the same
card, as `apiKey` in the `PUT` body, or under **Settings → Secrets**. The
requests are raised as the person who owns that key.

```bash
curl -X PUT "$ATELIER/api/steery-notify/$ORG" \
  -H "Authorization: Bearer $ATELIER_API_KEY" -H 'content-type: application/json' \
  -d '{"mode":"risky","minRisk":"high","delaySeconds":30,"tools":[],
       "steeryUrl":"https://steery.dev","apiKey":"'"$STEERY_KEY"'"}'
```

### Per-sandbox override

A sandbox's `atelier.dev/steery-notify` annotation (`off`, `all` or `risky`)
replaces its org's `mode`; the other fields still come from the org.
