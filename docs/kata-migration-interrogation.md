# Kata Migration — Phase 2 Decisions & Uncertainties

_Created: 2026-03-01 during Phase 2 implementation planning_

## Decisions Taken (On the Fly)

### D1: K8s Client Library — Custom fetch()-based wrapper instead of @kubernetes/client-node

**Context:** The migration plan says "Add @kubernetes/client-node to manager". However, the librarian agent found that `@kubernetes/client-node` has **known Bun runtime compatibility issues** ([oven-sh/bun#19754](https://github.com/oven-sh/bun/issues/19754)). The library uses Node.js-specific HTTP APIs that Bun's compat layer doesn't fully support (TLS cert handling, response.statusCode undefined).

**Options considered:**
1. `@kubernetes/client-node` — Official K8s client. Known Bun issues. Heavy dependency (~50+ transitive deps).
2. `kubernetes-fluent-client` — Bun-compatible alternative. Less mature, different API surface.
3. **Custom thin K8s REST client using fetch()** — Bun-native, zero dependencies, only implements what we need.

**Decision: Option 3 — Custom fetch()-based K8s client wrapper (~200-300 LOC)**

**Rationale:**
- The manager already has a pattern for raw HTTP clients (AgentClient does raw HTTP over vsock — 704 LOC)
- We only need a small subset of the K8s API: create/delete/watch for Pods, Services, Ingresses, Jobs, ConfigMaps
- K8s REST API is stable and well-documented — creating a typed wrapper is straightforward
- Zero dependency risk — Bun's fetch() is native and battle-tested
- Smaller footprint than any client library
- The K8s API uses standard JSON over HTTP — no special transport needed
- In-cluster auth is just reading a ServiceAccount token file and passing it as a Bearer token

**Implementation plan:**
```
infrastructure/kubernetes/
├── kube.client.ts      (~150 LOC) — fetch()-based HTTP client with in-cluster auth, retry, error handling
├── kube.resources.ts   (~100 LOC) — typed resource builders (Pod, Service, Ingress, Job, ConfigMap manifests)
├── kube.watcher.ts     (~80 LOC)  — SSE-based watch for pod status changes (K8s Watch API returns chunked JSON)
└── index.ts            (~10 LOC)  — exports
```

---

### D2: Agent Transport — Standard fetch() over TCP replaces raw HTTP over vsock

**Context:** The current AgentClient (704 LOC) uses raw HTTP/1.1 over Firecracker vsock because "Bun's polyfill ignores the `createConnection` option and connects to localhost instead of the provided socket". With K8s, pods have normal TCP IPs — this limitation no longer applies.

**Decision: Replace the entire vsock transport with standard fetch() to pod IP:9998**

**Rationale:**
- Vsock was a workaround for Bun's lack of Unix socket support in HTTP clients
- TCP over pod IPs is standard networking — fetch() works perfectly
- This eliminates ~300 LOC of vsock-specific code (handshake, retry, socket polling, chunked decoding)
- The raw HTTP protocol (manual request building, chunked encoding) becomes unnecessary
- Agent's HTTP API endpoints stay identical — only the transport changes

**Impact:**
- AgentClient shrinks from 704 LOC to ~200 LOC
- `getVsockPath()` becomes `getPodIp()` (looked up from K8s API or sandbox record)
- `connectVsock()` → `fetch(http://${podIp}:9998${path})`
- `waitForAgent()` simplifies to polling `fetch(http://${podIp}:9998/health)`
- All public API methods (exec, writeFiles, batchExec, serviceStart, etc.) stay identical

---

### D3: Ingress Controller — Re-enable Traefik (k3s default)

**Context:** Phase 1 k3s install used `--disable=traefik`. The migration plan says "Traefik bundled with k3s, or nginx". We need an ingress controller for sandbox routing (sandbox-{id}.domain → pod:8080, opencode-{id}.domain → pod:3000, dev-{name}-{id}.domain → pod:{port}).

**Decision: Re-enable Traefik (k3s built-in)**

**Rationale:**
- k3s ships with Traefik by default — zero additional deployment
- Traefik supports dynamic Ingress resources out of the box
- Wildcard TLS via cert-manager or Traefik's ACME integration
- The current Caddy setup does dynamic route CRUD — Traefik Ingress resources are the direct K8s equivalent
- For Phase 2, we just need to NOT disable Traefik in the k3s install (or re-enable it)

**Note:** The existing k3s on production has `--disable=traefik`. During deployment, we'll need to re-enable it. This is a Phase 3 (Helm chart) concern, not a Phase 2 code concern. Our Phase 2 code creates Ingress resources that work with any ingress controller.

---

### D4: SSH Access — Dropped (future unlock per plan)

**Context:** Current system has sshpiper for SSH proxy access. The migration plan lists "SSH proxy pod" as a future unlock.

**Decision: SSH functionality is not implemented in Phase 2.**

SSH URLs will be empty strings in sandbox.runtime.urls. The SshPiperService import and all SSH route registration calls will be deleted. Dashboard WebSocket terminals (via agent) remain the primary terminal access method.

---

### D5: Mock Mode — Same pattern, skip K8s operations

**Context:** Current `isMock()` check skips all FC operations (sandbox-spawner.ts, sandbox-lifecycle.ts, sandbox-destroyer.ts). Mock mode returns fake data for local development without KVM/LVM.

**Decision: Mock mode stays with the same pattern — skip K8s API calls, return fake sandbox data.**

No K8s cluster needed for local dev. Mock mode generates fake pod IPs, fake URLs. Same `ATELIER_SERVER_MODE=mock bun run dev` workflow.

---

### D6: Dev Command Routes — Dynamic Ingress resources via K8s API

**Context:** Currently, proxyService.registerDevCommandRoute() creates a Caddy route for each dev command (dev-{name}-{id}.domain → guestIp:port). Dev commands are started/stopped dynamically. Routes must be created/deleted at runtime.

**Decision: Create/delete Ingress resources dynamically via K8s API**

Each dev command gets its own Ingress resource:
- Name: `dev-{name}-{sandboxId}` (unique per dev command)
- Host: `dev-{name}-{sandboxId}.{baseDomain}`
- Backend: Service `sandbox-{sandboxId}` port `{devCommandPort}`

The sandbox's ClusterIP Service exposes all ports. Ingress resources are created/deleted when dev commands start/stop — same lifecycle as current Caddy routes.

---

### D7: Guest Ops Cleanup — What exactly gets deleted vs kept

**Context:** The migration plan lists 6 FC-specific guest-ops to delete. After reading the actual code, here's the precise classification:

**DELETE entirely (K8s handles natively):**
- `buildDnsCommand()` — CoreDNS auto-populates pod DNS
- `buildClockSyncCommand()` — Cloud Hypervisor provides kvmclock (validated in Phase 1)
- `buildHostnameCommand()` — K8s pod spec `hostname` field handles this
- `buildSwapCommand()` — K8s memory requests/limits; swap discouraged
- `buildMountSharedBinariesCommand()` — Binaries baked into OCI base image
- `resizeStorage()` — OCI images define rootfs; no LVM resize needed

**DELETE (replaced by K8s mechanism):**
- `agent.setConfig()` calls in workflows — Config is baked into pod via ConfigMap mount or env vars

**KEEP unchanged:**
- `buildRuntimeEnvFiles()` — Dynamic per-sandbox env (sandbox ID)
- `buildOhMyOpenCodeCacheFiles()` — Dynamic per-sandbox
- `buildSandboxMdFile()` — Dynamic per-sandbox
- `startServices()` — Agent manages process lifecycle inside pod
- `guest-repo.ts` — Git cloning and credential injection (all of it)
- `guest-secrets.ts` — Secret file collection and injection (all of it)

---

### D8: Sandbox Config Delivery — ConfigMap + agent.setConfig() on first boot

**Context:** The migration plan says "agent.setConfig() replaced by ConfigMap mounted via virtio-fs". But looking at the actual code, `setConfig()` is called once during create workflows (not on restart). It pushes service definitions (vscode command, opencode command, ports, etc.) that the agent uses to manage processes.

**Decision: Keep agent.setConfig() for now, deliver config via agent API after pod boot**

**Rationale:**
- The config is dynamic (contains sandboxId, opencodePassword, workspace repos)
- A ConfigMap would need to be created per-sandbox before pod creation, then the pod needs a volume mount — adds complexity
- The current pattern (boot pod → wait for agent → push config) works identically with TCP transport
- ConfigMap approach can be optimized later if needed (Phase 4)

**Note:** This is a simplification vs the migration plan. The plan says "Remove agent.setConfig() calls — replaced by ConfigMap mounted at pod creation". I'm keeping setConfig() because:
1. It works the same way over TCP
2. Moving to ConfigMap adds per-sandbox volume mount complexity
3. The agent already handles setConfig() — no agent changes needed
4. We can always migrate to ConfigMap later without any user-visible change

---

## Resolved Questions (User Answered 2026-03-01)

### Q1: Prebuild Strategy

**Answer: Pure Kaniko with OpenCode warmup trick.**

OpenCode needs a brief startup to install its own dependencies (via bun, based on workspace/global config) and prepare internal files. The approach: run `opencode serve` briefly in the Dockerfile (~5s), then kill it. The filesystem state persists in the Docker layer.

```dockerfile
# In generated Dockerfile:
RUN cd /home/dev/workspace && \
    opencode serve --hostname 0.0.0.0 --port 3000 & \
    sleep 5 && \
    kill %1 2>/dev/null || true
```

If this proves too complex or flaky, drop it and let OpenCode init at first boot.

### Q2: Manager Deployment During Phase 2 Dev

**Answer: Host-side.** Manager runs on bare metal alongside k3s. Uses kubeconfig (`/etc/rancher/k3s/k3s.yaml`) for auth. K8s client should support both kubeconfig file and in-cluster auto-detection for Phase 3.

### Q3: shell.ts Disposition

**Answer: Keep with generics only.** Remove FC-specific functions (`killProcess`, `cleanupSandboxFiles`, `injectFile`, `writeFileAsRoot`, `ensureDirAsRoot`). Keep `fileExists`, `dirExists`, `ensureDir`.
