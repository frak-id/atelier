# Open-Inspect on Atelier

[Open-Inspect](https://github.com/ColeMurray/background-agents) (MIT) is an
open-source background coding agent, an open take on Ramp's Inspect: prompts
from its web app, Slack, GitHub PRs/issues, Linear or automations become
sessions that run a coding agent (OpenCode or Claude) in a sandbox and end in
pull requests. This directory runs those sandboxes on Atelier: Open-Inspect
keeps its control plane, integrations and UI; Atelier is its data plane.

```
Slack · GitHub · Linear · web
            │
            ▼
 Open-Inspect control plane ──── /v1 (API key) ────▶ Atelier server
 (Cloudflare, or a container)                           │
            ▲                                           ▼
            └──── bridge WebSocket ──── sandbox from the `open-inspect` image
                                        (Open-Inspect runtime + agent, as `dev`)
```

| File | What |
|---|---|
| `upstream.env` | The Open-Inspect revision everything here targets |
| `atelier-provider.patch` | Adds `atelier` as a first-class Open-Inspect sandbox provider (control plane, image target, Terraform, docs, tests) |
| `checkout.sh` | Clones the pinned revision and applies the patch |
| `Dockerfile` | The `open-inspect` Atelier seed: `dev-base` + the Open-Inspect runtime, installed by Open-Inspect's own image tooling |

## How a session maps onto Atelier

| Open-Inspect | Atelier |
|---|---|
| spawn | `POST /v1/sandboxes` from the `open-inspect` image with `personalize: false` (no user toolboxes, harness or git credentials: Open-Inspect brokers its own), then wait for the create job |
| inactivity shutdown | `POST /v1/sandboxes/:id/pause` — disk snapshotted, compute released |
| follow-up prompt | `POST /v1/sandboxes/:id/resume` — same disk, runtime restarted |
| archive / cleanup | `DELETE /v1/sandboxes/:id` |
| per-session CPU / memory settings | `resources.vcpus` / `resources.memoryMb` |

Only `/home/dev` survives a pause, so the image points the runtime's
`/workspace` into it.

## Setup

1. **Build the image** (once, and again after changing this directory):
   ```sh
   atelier image build dev-base        # if not built yet
   atelier image build open-inspect
   ```
2. **Create an API key** for the Atelier user Open-Inspect acts as (console →
   Settings → API keys). Every Open-Inspect sandbox is owned by that user.
3. **Deploy Open-Inspect** from a patched checkout:
   ```sh
   integrations/open-inspect/checkout.sh ~/open-inspect
   ```
   Then follow its `docs/GETTING_STARTED.md` with the Atelier provider — see
   its `docs/ATELIER_SANDBOX_PROVIDER.md`. With Terraform (Cloudflare, the full
   feature set including the Slack and Linear bots):
   ```hcl
   sandbox_provider = "atelier"
   atelier_api_url  = "https://atelier.example.com"
   atelier_api_key  = "atl_…"
   # atelier_image  = "open-inspect"
   ```
   With the container host (`docker compose`; no Slack/Linear bots yet
   upstream), set `SANDBOX_PROVIDER=atelier`, `ATELIER_API_URL`,
   `ATELIER_API_KEY` and optionally `ATELIER_IMAGE` in `.env`.
4. **Networking**: the control plane must reach the Atelier API, and Atelier
   sandboxes must reach the control plane's public URL (`WORKER_URL`).

## Limits (v1)

- **No prebuilt repository images.** Every session clones and runs its setup
  on boot; Open-Inspect's image builds are not wired to Atelier prebuilds yet.
- **No code-server, web terminal, VNC or tunnel URLs.** Atelier's in-pod agent
  owns `0.0.0.0:7681` and forwards every declared port from `0.0.0.0`, which
  collides with services that bind the pod interface themselves. Sessions that
  enable them run without them (the provider logs a warning). Exposing them
  needs a "served directly" port mode in the agent.
- **Create waits at most 200 s** for Atelier's boot job, just under Open-Inspect's
  240 s connect watchdog. The first session on a node that has not pulled the
  image yet may exceed it and be retried; pre-pull the image on large fleets.
- **Single tenant**, like Open-Inspect itself: all sessions run as one Atelier
  user and share its org policy and secrets. Atelier's operator access applies
  as for any sandbox: registered SSH keys can reach them.
- The runtime runs as `dev` without `sudo`; system packages belong in the
  image (or in the repository's Open-Inspect setup script, user-space).

## Updating Open-Inspect

1. Bump `OPEN_INSPECT_REF` in `upstream.env` and run `./checkout.sh /tmp/oi`.
   If the patch no longer applies, check out the new revision by hand and run
   `git apply --3way atelier-provider.patch`, then resolve the conflicts.
2. Run Open-Inspect's checks in `/tmp/oi` (`npm ci`, `npm test -w
   @open-inspect/control-plane`, the `sandbox-images` pytest suite,
   `terraform test` in `terraform/environments/production`). Check that its
   `packages/sandbox-images/install/` still leaves `/workspace` empty: the
   `Dockerfile` replaces it with the link into `/home/dev`.
3. Regenerate the patch from the working tree:
   `git -C /tmp/oi add -A && git -C /tmp/oi diff --cached --binary <new ref> > atelier-provider.patch`.
4. Rebuild the image: `atelier image build open-inspect --force`.
