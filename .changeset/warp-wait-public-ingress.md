---
"@konfeature/opencode-atelier": patch
---

Fix transient warp failure right after spawning a fresh Atelier sandbox.

`POST /sandboxes` only health-checks the remote `opencode serve` on the pod's **internal** IP, but opencode warps against the **public** Traefik host (`https://opencode-<id>.<domain>`) the instant `adaptor.create()` resolves — it immediately fires `/sync/replay` + `/sync/steal` (warp) and `GET /global/event` (background sync). With a freshly-created sandbox the public ingress route + forward-auth middleware can still be reconciling, so that first warp raced Traefik and surfaced as a `SessionWarpHttpError` on the local opencode side. Re-entering the workspace after a TUI restart worked because the route was warm by then and reconnecting needs no replay.

`adaptor.create()` now blocks until the public host actually serves traffic before resolving: it probes `GET <opencodeUrl>/global/health` with the sandbox's `Basic` credentials (the exact host/route/auth opencode warps against) using capped exponential backoff (250ms → 2s, 60s budget). Non-2xx and network errors are retried; a `401`/`403` fails fast with a clear message since waiting won't fix auth.
