# atelier — Roadmap

A rough, evolving list of where we want to take atelier. Order is roughly by
priority, not a strict sequence.

## 1. Retire the original POC ("v1") ✅

- [x] Decommission the old manager, dashboard, agent, helm chart and the rest
  of the POC deployables. The `imageBuilder` config block was kept on purpose:
  it drives the server's in-cluster base-image builder.
- [x] Drop the leftover "v2" naming (`apps/agent`, `infra/k8s`, the
  `sandbox-agent` seed, [`design.md`](design.md)). The live cluster object
  names (`atelier-v2-*` namespaces, PVC, secrets, `:v2` image tags) keep
  their names: renaming them needs a migration.

## 2. Cleanup packages & config

- Tidy the packages, shared config, tsconfig, build setup, etc.

## Known gaps

- **Forward-auth for tool ingresses.** Ports with `auth: "forward"` get the
  operator's forward-auth annotations, but the server has no verify endpoint
  of its own for them.
- **Prebuilds aren't caller-scoped.** Sandboxes are guarded by owner/org, but
  any authenticated user can list or delete any prebuild, or edit its dev
  servers (`/v1/prebuilds`).

## 3. Make it easier to run

- [x] Support more filesystems so it can run almost everywhere — a Docker env on a
  Mac, CI, wherever.
- [x] Consider bringing back the `tar.gz` approach for toolsets as a fallback.
- Check the latest commits for context before reworking this.

## 4. Review the CLI

- [x] Adopt a proper CLI library instead of the hand-rolled parser.
- Better onboarding and overall developer experience.

## 5. Much better console / CLI onboarding

- Smooth the first-run experience for the console and CLI.
- Two-path installation:
  - **Have a cluster?** One Helm chart installs everything (infra + server +
    console) with minimal required values; everything else configurable via
    the CLI or the console on first connection.
  - **No cluster?** `atelier local up` — the CLI starts a local server against
    the local Docker daemon and spawns sandboxes as containers (the Docker
    runtime backend), no Kubernetes or domain needed.

## 6. In-console examples

- Ship examples directly in the console — a dev companion for the product team,
  that kind of thing.
- [x] **Launchpad** (first release) — dev teams publish starters (prebuild + toolboxes +
  context + the tools to open); non-technical teams launch them in one click
  and get their tools embedded, with named workspaces to come back to. See
  [`proposals/launchpad.md`](proposals/launchpad.md) (follow-ups listed there).

## 7. Plugin system

- Add a plugin system that can wire in almost anything:
  - Slack / Linear connectors.
  - Grafana / Alertmanager to react to events.
  - Other git providers, and potentially usage without git at all.
  - A "mission control" plugin, a kanban board, etc.
  - Could be externally hosted since we have a proper API.
