# Atelier Helm Chart

Single chart deploying the full Atelier stack into a k3s cluster (`atelier-system` namespace + `atelier-sandboxes` workload namespace).

## Sub-Components (toggle via values)

| Component | Required | Purpose |
|-----------|----------|---------|
| `manager` | yes | Bun/Elysia API + SQLite PVC |
| `dashboard` | yes | Static React SPA (nginx sidecar in manager pod) |
| `zot` | optional | OCI registry for base images |
| `verdaccio` | optional | npm package cache shared across sandboxes |
| `cliproxy` | optional | Multi-provider AI model proxy |
| `sshpiper` | optional | SSH proxy with username-based routing |
| `certManager` | optional | Issuer + wildcard cert (assumes cert-manager installed) |
| `kata-runtimeclass` | yes | RuntimeClass `kata-clh` for sandbox pods |

## Conventions

- **Single chart, multiple components**: every component is gated by `<component>.enabled` — leave defaults intact
- **Wildcard cert**: `sandbox-wildcard-certificate.yaml` is required for dynamic `*.{baseDomain}` routing
- **Shared binaries job**: `shared-binaries-job.yaml` populates a `ReadOnlyMany` PVC with code-server + opencode — sandboxes mount this read-only
- **Traefik middlewares**: `traefik-middlewares.yaml` defines auth + rewrite middlewares referenced by sandbox Ingresses
- **Helpers**: domain/host construction lives in `_helpers.tpl` — never inline domain logic in templates

## Lint

```bash
helm lint charts/atelier        # CI runs this
helm template charts/atelier    # render locally to debug
```

## Anti-Patterns

- **DO NOT** add CRDs to `templates/` — install via separate `--set crds.enabled=true` upstream chart (cert-manager pattern)
- **DO NOT** hardcode the base domain — always use `{{ include "atelier.baseDomain" . }}`
- **WARNING**: helm upgrade with changed `apiKeys`, `extraConfig`, or `ports` overwrites existing config — see `values.yaml` warnings
