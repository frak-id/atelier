# atelier — Roadmap

A rough, evolving list of where we want to take atelier. Order is roughly by
priority, not a strict sequence.

## 1. Cleanup v1 ✅

- [x] Decommission the old server, helm chart, and remaining v1 deployables — see
  [`proposals/v1-decommission.md`](proposals/v1-decommission.md) and
  [`proposals/v1-decommission-findings.md`](proposals/v1-decommission-findings.md).

## 2. Cleanup packages & config

- Once v1 is cleaned up, tidy the packages, shared config, tsconfig, build
  setup, etc.

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

## 7. Plugin system

- Add a plugin system that can wire in almost anything:
  - Slack / Linear connectors.
  - Grafana / Alertmanager to react to events.
  - Other git providers, and potentially usage without git at all.
  - A "mission control" plugin like v1, a kanban board, etc.
  - Could be externally hosted since we have a proper API.
