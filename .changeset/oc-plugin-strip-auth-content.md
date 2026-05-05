---
"@konfeature/opencode-atelier": minor
---

Stop forwarding `OPENCODE_AUTH_CONTENT` from the local CLI into the
Atelier sandbox.

The whole point of warping into an Atelier sandbox is to reuse the
sandbox's own opencode credentials (provisioned via the manager's
auth-sync + cliproxy). Forwarding `OPENCODE_AUTH_CONTENT` would also
leak the user's local provider tokens into the pod env (visible via
`kubectl describe pod`, in-sandbox `ps`, and any structured manager log
that captures the env block). Removing it from `FORWARDED_ENV_KEYS`
makes auth strictly server-side.

The remaining whitelist is now:

- `OPENCODE_EXPERIMENTAL_WORKSPACES`
- `OPENCODE_WORKSPACE_ID`
- `OTEL_EXPORTER_OTLP_HEADERS`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_RESOURCE_ATTRIBUTES`

If you previously relied on local auth being forwarded automatically,
configure provider credentials directly on the sandbox (via Atelier's
shared-auth sync or a per-workspace `opencode auth` invocation) before
warping.
