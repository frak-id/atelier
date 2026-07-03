# Atelier v2 — staging deploy (`hetzner-atelier`)

Standalone manifests to run the v2 server + console in parallel with the live
v1 stack, under `atelier.hetzner-staging.frak.id`. See
`.notes/deploy-v2-staging.md` for the full feasibility write-up.

## What it deploys

- `atelier-v2-system` ns: server+console Deployment, Service, Ingress, config
  ConfigMap, data PVC, RBAC (SA `atelier-v2`).
- `atelier-v2-sandboxes` ns: shared-binaries PVC + populate Job
  (opencode 1.17.4 + code-server 4.123.0); v2 sandbox pods land here.
- Images: `zot.zot.svc:5000/atelier-server:v2` + `atelier-console:v2`
  (built in-cluster via BuildKit, pushed to the internal Zot registry).

## Secret (not in git)

The Deployment reads `atelier-v2-secrets`. Create it before deploying:

```sh
kubectl --context hetzner-atelier -n atelier-v2-system create secret generic atelier-v2-secrets \
  --from-literal=ATELIER_GITHUB_CLIENT_ID=<id> \
  --from-literal=ATELIER_GITHUB_CLIENT_SECRET=<secret> \
  --from-literal=ATELIER_JWT_SECRET=<jwt> \
  --from-literal=SANDBOX_SECRETS_KEY=<32-char-hex> \
  --from-literal=ATELIER_MCP_TOKEN=<token> \
  --from-literal=ATELIER_CLIPROXY_API_KEY=<cliproxy-key>
```

`ATELIER_CLIPROXY_API_KEY` is the bearer token for the CLIProxy model provider
(`ATELIER_CLIPROXY_URL` is set in the Deployment). The server bakes this
provider into each opencode sandbox's `opencode.json` at spec enrichment, so
sessions have models. Omit it and sandboxes still boot, just without models.

The GitHub OAuth app's callback URL must be
`https://atelier.hetzner-staging.frak.id/auth/callback`, org restricted to
`frak-id`.

## Apply

```sh
kubectl --context hetzner-atelier apply -f infra/k8s/v2/00-namespaces.yaml
kubectl --context hetzner-atelier apply -f infra/k8s/v2/10-rbac.yaml
kubectl --context hetzner-atelier apply -f infra/k8s/v2/20-shared-binaries.yaml
kubectl --context hetzner-atelier apply -f infra/k8s/v2/30-config.yaml
kubectl --context hetzner-atelier apply -f infra/k8s/v2/40-server-pvc.yaml
# create the secret (above), then:
kubectl --context hetzner-atelier apply -f infra/k8s/v2/50-deployment.yaml
kubectl --context hetzner-atelier apply -f infra/k8s/v2/60-service.yaml
kubectl --context hetzner-atelier apply -f infra/k8s/v2/70-ingress.yaml
```

## Rebuild images (in-cluster, no local docker)

Build with the cluster BuildKit and push to Zot — see
`.notes/deploy-v2-staging.md` (Phase A). `.dockerignore` must not exclude
workspace `apps/*` package.json files (bun frozen install needs the full
graph); the build pod uses a trimmed `.dockerignore`.
