# Atelier Helm Chart

Deploys SHARED CLUSTER INFRA ONLY into a k3s cluster (`atelier-system`
namespace) — it does not deploy the server or console app. The app is
deployed separately via plain manifests under `infra/k8s/v2/` (see
`infra/k8s/v2/README.md`).

## Sub-Components (toggle via values)

| Component | Required | Purpose |
|-----------|----------|---------|
| `zot` | optional | OCI registry for base images + toolset artifacts |
| `cliproxy` | optional | Multi-provider AI model proxy |
| `sshpiper` | optional | SSH proxy with username-based routing |
| `certManager` | optional | Issuer + wildcard cert (assumes cert-manager installed) |
| `kata` | yes | RuntimeClass `kata-clh` for sandbox pods |

## Conventions

- **Single chart, multiple components**: every component is gated by `<component>.enabled` — leave defaults intact
- **Wildcard cert**: `sandbox-wildcard-certificate.yaml` is required for dynamic `*.{baseDomain}` routing
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
