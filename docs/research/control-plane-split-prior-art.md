# Control-Plane vs Policy-Plane Split: Prior Art in Sandbox/VM Orchestration

> **Research question:** Is there real prior art for a minimal *headless core* that only boots/pauses/stops/snapshots a sandbox from a given spec, with orgs/users/config-merging/GUI layered *above* it as a separate service?
>
> **Short answer:** Yes — emphatically. The pattern is universal in mature infrastructure software. The interesting question is *where exactly* to draw the line, *why*, and *when it's worth it for a small team.*

---

## 1. Case-by-Case Analysis

### 1.1 Fly.io — Machines API vs. Fly Launch

#### Low-level contract (Machines API)

REST API at `https://api.machines.dev/v1/apps/{app}/machines`. The minimal create body:

```json
{
  "region": "sjc",
  "config": {
    "image": "nginx:latest",
    "guest": { "cpu_kind": "shared", "cpus": 1, "memory_mb": 256 },
    "env": { "KEY": "value" },
    "services": [{ "ports": [{ "port": 443, "handlers": ["tls", "http"] }],
                   "internal_port": 8080, "protocol": "tcp" }],
    "checks": [{ "type": "http", "port": 8080, "path": "/healthz" }],
    "cmd": ["/app/server"],
    "restart": { "policy": "no" }
  }
}
```

Core operations: `POST /machines` (create+start), `POST /machines/{id}/start`, `POST /machines/{id}/stop`, `POST /machines/{id}/suspend` (snapshot to disk), `DELETE /machines/{id}`.  
The API is *imperative*: you tell it exactly what to do to one machine.  
Authentication is a Bearer token; *the API itself does no team-level quota or org-level policy enforcement*.

#### Above the line (Fly Launch / fly.toml)

`fly launch` / `fly deploy` adds: `fly.toml` config merging and scanning (Buildpacks, Dockerfiles), deployment *groups* (primary/canary), rolling-update orchestration across N machines, autoscaling, shared-IP allocation, TLS certificate provisioning, secrets management, volume lifecycle, DNS registration. `fly secrets` and team-level billing/quotas sit entirely outside the Machines API. [Source: [Fly Machines overview](https://fly.io/docs/machines/overview/), [Fly Apps overview](https://fly.io/docs/apps/overview/)]

#### Why the line is there

Fly explicitly documented: "We use the Machines API to build the orchestration for Fly Launch." The split lets Fly dogfood the same primitive that customers use. It allows third-party platforms (e.g., Supabase edge functions, Tigris, other Fly-hosted SaaS) to build their own orchestration logic on top. The cost: two conceptual models to maintain (imperative Machines vs declarative Apps), version skew between them, and users who accidentally mix the two.

#### Premature vs. worth it

Worth it at Fly's scale: dozens of internal teams + external builders share the primitive. For a small team launching a single product, starting with *only* the Machines-equivalent API (without the higher launch layer) is entirely reasonable; you just accept you'll hand-roll rolling updates.

---

### 1.2 E2B — Orchestrator vs. API Service vs. SDK

#### Low-level contract (Orchestrator — gRPC)

The `orchestrator` package (`packages/orchestrator/`) exposes a gRPC interface. The proto-level sandbox creation fields include:

```proto
SandboxConfig {
  string template_id      // pre-built rootfs/snapshot ID
  string sandbox_id       // caller-assigned or generated
  string team_id          // tenant scoping — passed *in*, not enforced here
  string build_id         // specific template build
  Duration max_length     // TTL
  map<string,string> env  // additional env vars
  string kernel_version
}
```

The orchestrator: provisions Firecracker microVMs, sets up networking via iptables/netlink, caches warm snapshots, exposes gRPC `CreateSandbox` / `PauseSandbox` / `ResumeSandbox` / `DeleteSandbox`. It does **not** verify auth tokens, enforce quota, or know what "team" means beyond threading the ID through for observability. [Sources: [DeepWiki E2B infra](https://deepwiki.com/e2b-dev/infra/2-system-architecture), [GitHub orchestrator sandboxes.go](https://github.com/e2b-dev/infra/blob/8e108dbe/packages/orchestrator/pkg/server/sandboxes.go)]

#### Middle layer (API Service — REST)

The `api` package is the actual user-facing REST endpoint SDKs talk to. It handles: JWT/API-key authentication, team membership checks, quota enforcement (CPU/memory/concurrent sandbox limits), template ID resolution (template alias → build ID), audit logging, and routing to the right orchestrator instance. The REST `POST /sandboxes` body is:

```json
{
  "templateID": "base",
  "timeout": 300,
  "metadata": { ... },
  "envVars": { "KEY": "value" },
  "autoPause": true,
  "autoResume": { ... }
}
```

#### Above the line (SDK / Templates)

The Python/TypeScript SDKs add: template Dockerfile building + E2B CLI (`e2b build`), reconnect semantics (resuming a sandbox you already opened), high-level helpers (`sandbox.filesystem`, `sandbox.process`). `e2b.Dockerfile` template compilation is entirely outside both the orchestrator and API service. [Source: [E2B template docs](https://www.e2b.dev/docs/template/quickstart)]

#### Why the line is there

The orchestrator is a single-binary, fast-path microservice on each compute cluster node. The API service is the trust boundary — it holds secrets, talks to Postgres for billing state. Separating them means the orchestrator can be redeployed / scaled independently, can run in BYOC customer VPCs (where E2B's API service credentials must *not* live), and can be swapped for a different runtime without touching auth/billing code. [Source: [E2B BYOC docs](https://e2b.dev/docs/byoc)]

#### Cost

Two network hops (SDK → API → Orchestrator → Firecracker). Versioned gRPC proto contracts between API and Orchestrator must be kept in sync. The `team_id` being threaded through (rather than derived) means the orchestrator implicitly trusts the API service — a misconfigured API service could create sandboxes for the wrong team without the orchestrator knowing.

---

### 1.3 Firecracker + firecracker-containerd / Kata Containers

#### Lowest level: Firecracker VMM

Firecracker exposes a REST API on a Unix socket. The machine config spec:

```json
PUT /machine-config  → { "vcpu_count": 2, "mem_size_mib": 512, "smt": false }
PUT /boot-source     → { "kernel_image_path": "/vmlinux", "boot_args": "console=ttyS0 reboot=k" }
PUT /drives/rootfs   → { "drive_id": "rootfs", "path_on_host": "/tmp/rootfs.ext4", "is_root_device": true }
PUT /network-interfaces/eth0 → { "iface_id": "eth0", "host_dev_name": "tap0" }
PUT /actions         → { "action_type": "InstanceStart" }
```

Snapshot: `PUT /actions { "action_type": "CreateSnapshot", "snapshot_path": "...", "mem_file_path": "..." }`. This is the *purest* possible primitive — it knows nothing about containers, teams, or images. [Source: [Firecracker API](https://github.com/firecracker-microvm/firecracker/blob/main/src/api_server/swagger/firecracker.yaml)]

#### firecracker-containerd shim (Runtime v2)

Implements containerd's `runtime.v2` ttRPC interface. Accepts an OCI container spec + Firecracker-specific annotations and translates them into Firecracker API calls. The boundary: containerd `Create(containerID, OCI bundle, options)` → shim → Firecracker REST calls. The shim adds: VM lifecycle management, agent communication inside the VM, per-container vs per-VM scoping decision. [Source: [firecracker-containerd architecture](https://github.com/firecracker-microvm/firecracker-containerd/blob/master/docs/architecture.md)]

#### Kata Containers

A containerd/CRI-O shim that speaks the same `runtime.v2` interface but can use Firecracker, QEMU, or cloud-hypervisor as hypervisors behind a configuration switch. Kata adds: VM templating (pre-booted VMs for fast cold start), shared-memory optimizations, agent protocol versioning. Higher orchestration (Kubernetes, Nomad) sits above Kata via CRI. [Source: [Kata + Firecracker how-to](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-kata-containers-with-firecracker.md)]

#### Why the lines are where they are

Each layer has a different owner: Firecracker (AWS, hypervisor team), containerd (CNCF, container runtime team), Kubernetes (CNCF, orchestration community). The OCI and CRI specs are *standards* that decouple them. This meant Firecracker could become the backend for multiple container runtimes (Kata, firecracker-containerd) without coordination. Cost: three independently versioned specs (OCI runtime spec, CRI, Runtime v2), a translation shim at each hop, latency from process boundaries.

---

### 1.4 Kubernetes — Runtime / Kubelet / API-server / Controllers / Knative

#### CRI Runtime (containerd, CRI-O)

Implements `RuntimeService` gRPC: `RunPodSandbox(PodSandboxConfig)` → `CreateContainer(PodSandboxID, ContainerConfig)` → `StartContainer(containerID)` → `StopContainer` → `RemoveContainer`. `ContainerConfig` includes: image, command, args, envs, mounts, labels, annotations, linux config (namespaces, capabilities, cgroups path). No auth, no scheduling, no policy. [Source: [Kubernetes CRI spec](https://kubernetes.io/docs/concepts/architecture/cri/)]

#### Kubelet (node agent)

Watches the API server for Pods assigned to its node. Translates Pod specs into CRI calls. Manages: volume mounting, secret/configmap injection, liveness/readiness probes, log collection, node resource reporting. The kubelet is the *only* k8s component that talks directly to the CRI runtime.

#### API Server + etcd (cluster control plane)

Accepts declarative resource specs (Pod, Deployment, Service…) via REST. Enforces: authentication (tokens, certs, OIDC), authorization (RBAC), admission control (webhooks, built-in policies, quotas), validates schemas, persists to etcd, drives watch streams. The API server never talks to a container runtime directly. [Source: [Kubernetes components](https://kubernetes.io/docs/concepts/overview/components/)]

#### Controllers (kube-controller-manager)

Reconciliation loops: DeploymentController watches Deployments and manages ReplicaSets, ReplicaSetController manages Pods, etc. HPA scales Deployments based on metrics. These are pure control-loop logic — no compute, no runtime calls.

#### Knative Serving (PaaS layer on k8s)

Adds its own CRDs (`Service`, `Route`, `Revision`, `Configuration`) and controllers on top of Kubernetes. Abstractions: git-to-deploy (via Tekton), traffic splitting, scale-to-zero (via Activator), revision history. Builds on k8s Deployments + Services but hides them behind a simpler API. [Source: [Knative architecture](https://knative.dev/docs/serving/architecture/)]

#### Why the lines are where they are

The CRI split was motivated by replacing Docker as the default runtime (Dockershim removal). Separating the runtime from the node agent (kubelet) allowed CRI-O, containerd, and Kata to compete as backends without forking the node agent. The API server / controller separation enables the "operator pattern" — third parties extend k8s with new CRDs + controllers without touching core. Cost: enormous complexity surface, ~6 distinct API contracts, operational difficulty (cert rotation between every component, separate etcd cluster, etc.).

---

### 1.5 Nomad

#### Task Driver (lowest level plugin)

Implements the task driver plugin interface: `StartTask(TaskConfig)` → returns `TaskHandle`, `StopTask`, `DestroyTask`, `InspectTask`. `TaskConfig` is driver-specific: for Docker it's image + auth + port_map + volumes; for QEMU it's image path + accelerator; for `exec` it's command + args + cgroup isolation options. Drivers are out-of-process plugins (gRPC between Nomad client and driver). [Source: [Nomad task driver plugin docs](https://docs.hashicorp.com/nomad/plugins/author/task-driver)]

#### Nomad Client (node agent)

Polls server for allocations. Invokes drivers. Tracks resource usage. Registers fingerprint (available CPU, memory, drivers, attributes) with server.

#### Nomad Server (scheduler + job API)

Accepts job specs (HCL/JSON): `job` → `group` → `task`, with resources (`cpu`, `memory`), constraints, affinities, spread. The server does scheduling (bin-packing, spread), consensus (Raft), and job state management. Auth is via ACL tokens (optional), namespaces for multi-tenancy (also optional). Quotas are a Nomad Enterprise feature. [Source: [Nomad architecture](https://developer.hashicorp.com/nomad/docs/architecture)]

#### Why the line is there

Nomad's explicit philosophy is "simple, single binary" — server + client + driver are all in the same binary, split only logically. The driver plugin interface was added later to allow community-contributed drivers without forking. Compared to Kubernetes, Nomad chose *less* layering, accepting that multi-tenancy and policy are the operator's responsibility. Cost: weaker isolation guarantees, manual RBAC setup, no built-in operator pattern for extensions.

---

### 1.6 containerd

#### OCI Runtime Spec (runc / runsc / crun)

The lowest contract: a JSON bundle at a path. Core fields:

```json
{
  "ociVersion": "1.0.2",
  "root": { "path": "rootfs", "readonly": false },
  "process": { "args": ["/bin/sh"], "env": ["PATH=/usr/bin"], "cwd": "/" },
  "linux": { "namespaces": [...], "cgroups": "...", "seccomp": {...} },
  "mounts": [...]
}
```

The runtime only sees a directory; it doesn't know about registries, layers, teams, or scheduling. [Source: [OCI runtime spec](https://github.com/opencontainers/runtime-spec)]

#### containerd daemon (content store + snapshotter + runtime v2)

Adds: image pulling (OCI image manifest/layer management), snapshotting (overlayfs, btrfs), namespace isolation (containerd namespaces, not Linux namespaces), and the runtime v2 shim interface. The containerd gRPC API is richer but still has no auth beyond Unix socket permissions. [Source: [containerd architecture](https://thecontainerdbook.com/chapters/part-4/10-containerd-architecture)]

#### CRI plugin (inside containerd daemon)

Translates Kubernetes CRI gRPC calls to containerd internals. This is the "adapter" that lets kubelet treat containerd as a black box. The CRI plugin is the *only* place Kubernetes-specific semantics (Pod sandboxes, annotations for runtimes) enter containerd.

#### Why the line is there

Each layer in containerd was designed to be independently replaceable: swap runc for runsc (gVisor), swap overlayfs for btrfs, swap containerd for CRI-O. The OCI spec was explicitly created to commoditize the runtime, preventing Docker from being a single-vendor lock-in. Cost: each spec version requires compatibility matrices, shim binaries per runtime, and late-binding configuration complexity.

---

### 1.7 Northflank / Railway / Render

These platforms are more opaque (closed source), but the architectural pattern is visible through their APIs and documentation.

**Northflank:** Explicitly builds on Kubernetes + cloud-native primitives. Their "forward-deployed control plane" product ships a Northflank control plane into the customer's Kubernetes cluster. This strongly implies: internal low-level runtime is standard Kubernetes CRI + their controllers, while the Northflank API/UI layer handles orgs, teams, RBAC, templates, GitOps sync, billing. [Source: [Northflank Enterprise](https://northflank.com/enterprise)]

**Railway:** Public API accepts service specs (image/repo, env vars, region, resource limits). The internal runtime is Kubernetes-based. Multi-tenancy, billing, and deploy pipelines live in Railway's backend services — not in the runtime.

**Render:** Similar pattern. Blueprint specs (YAML) are transformed into container deployments. The transformation layer (config merging, secret injection, service discovery wiring) is their proprietary policy engine; the actual running containers are OCI containers on managed k8s.

**Pattern across all three:** A public-facing API that accepts *user-friendly* specs (with templates, environment references, secret names) sits in front of a k8s control plane that accepts *resolved, concrete* specs. The resolved spec is what gets submitted to the Kubernetes API server.

---

## 2. Boundary Comparison Table

| System | Low-level API contract | What the spec contains | What lives above | Why the split | Cost |
|---|---|---|---|---|---|
| **Fly Machines API** | REST JSON per-machine | image, guest(cpu/mem), env, services, region | Auth, fleet orchestration, fly.toml merging, rolling deploys, secrets, TLS, DNS | Dogfood own infra; let builders compose | Two mental models; imperative vs declarative confusion |
| **E2B Orchestrator** | gRPC `CreateSandbox` | templateID, sandboxID, teamID, TTL, env | JWT auth, quota, template alias resolution, billing | Fast-path compute, BYOC isolation, independent scaling | API ↔ Orch proto versioning; Orch implicitly trusts API |
| **Firecracker VMM** | REST on Unix socket | vcpu, mem_mib, rootfs path, kernel path, tap device | *Everything*: container layers, orchestration, auth, scheduling | Single-purpose VMM; no OS coupling | ~3 translation layers to reach from container spec |
| **containerd** | OCI bundle JSON / runtime v2 ttRPC | rootfs path, process args, namespaces, cgroups | Image pull, snapshotting, CRI, Kubernetes, PaaS | Commoditize runtime; vendor-neutral OCI | Complex version matrix; shim binary per runtime |
| **Kubernetes CRI** | gRPC `RunPodSandbox` / `CreateContainer` | image, command, env, mounts, linux config | Kubelet, API server, controllers, Knative | Allow runtime swap (Docker → containerd → others) | 6 API contracts between runtime and kubectl |
| **Kubernetes API server** | REST declarative resource YAML/JSON | Pod spec with containers, volumes, labels | RBAC, admission, controllers, HPA, Knative, PaaS | Operator pattern; CRD extensibility | Enormous operational complexity; 6 distinct binaries |
| **Nomad server** | HCL/JSON job spec | task group, task driver config, resources, constraints | ACL (optional), quotas (Enterprise), UI | Simplicity; single binary; batteries optional | Weaker multi-tenancy; policy is DIY |
| **Northflank / Railway / Render** | Platform API with templates | image/repo, env refs, resource class, region | Team/org, billing, GitOps, secrets, CI/CD | Managed PaaS; UX over primitives | Opaque; vendor lock-in at policy layer |

---

## 3. Synthesis: What the Minimal "Run a Sandbox from a Resolved Spec" Contract Should Contain

Based on the patterns above, the minimal contract for a headless sandbox core — one that can stand alone — should look like this:

### Required fields in a "resolved spec"

```
SandboxSpec {
  // Identity
  sandbox_id: string          // caller-assigned or server-generated
  
  // Compute image
  rootfs_snapshot_id: string  // pre-built, immutable snapshot reference
                              // OR image_uri: string (OCI ref, pre-pulled)
  
  // Resources
  vcpus: int
  memory_mb: int
  disk_mb: int                // optional, if rootfs is copy-on-write
  
  // Runtime config
  env: map<string, string>    // already-resolved (no secret refs)
  cmd: []string               // optional override of snapshot default
  
  // Network
  enable_internet: bool       // or egress_policy: enum
  exposed_ports: []int        // optional, for proxy registration
  
  // Lifecycle
  timeout_seconds: int        // hard kill deadline
  
  // Operational
  metadata: map<string, string>  // opaque, for tracing/billing pass-through
}
```

### What explicitly does NOT belong in the headless core contract

- Org/team/user IDs (pass as opaque metadata at most)
- Secret references — secrets must be resolved to values before calling the core
- Template aliases — resolve to `rootfs_snapshot_id` before calling
- Quota checks — enforce above, reject before calling core
- Auth tokens — validate above, never send to core
- Config file merging (e.g., `fly.toml` layering) — resolve above
- RBAC policies — enforce above

### Core operations (exactly five)

```
Create(SandboxSpec) → (SandboxID, status)
Start(SandboxID)    → status            // if created but not started
Stop(SandboxID)     → status            // soft stop, preserves state if paused
Pause(SandboxID)    → SnapshotID        // freeze + snapshot memory state
Resume(SnapshotID, SandboxSpec) → (SandboxID, status)
Delete(SandboxID)   → void
```

Everything else (exec, file I/O, port proxying) is a separate concern — either in a sidecar inside the sandbox or in the "general server" layer.

---

## 4. Honest Guidance: Is the Split Worth It for a Small Team?

### When the split is WORTH IT

1. **You have (or plan to have) multiple callers of the runtime** — e.g., a web UI, a CLI, an API, and an async worker all need to create sandboxes. A clean headless core avoids everyone re-implementing sandbox creation.

2. **You are building a platform product** (i.e., *your* customers will orchestrate their own sandboxes, not just use yours). In this case the boundary is the product.

3. **BYOC or on-premise deployment is a near-term requirement.** The orchestrator must run in customer infrastructure without customer credentials flowing to your auth service — *exactly* the E2B BYOC motivation.

4. **The runtime and policy evolve at different rates.** If your VM layer changes weekly (Firecracker upgrades, kernel patches) but org/team management changes slowly, decoupling lets each deploy independently.

5. **You expect to swap runtimes.** If you might move from Docker containers to Firecracker microVMs or gVisor, a clean spec boundary is the only way to do it without rewriting everything.

### When the split is PREMATURE

1. **Single product, single caller, no BYOC.** If there is exactly one service calling the sandbox core and it will always be that way, the "split" is just unnecessary process-boundary latency and an extra RPC hop to maintain.

2. **The spec is not yet stable.** If you're still discovering what fields the spec needs (do you need GPU passthrough? Custom kernels? Per-sandbox firewall rules?), drawing a hard API boundary too early locks you into a contract you'll break repeatedly. *Monolith-first* lets you discover the right spec shape from real usage.

3. **Team size < 5.** The split pays off when different teams own the different layers. With 2–3 engineers, the coordination overhead of separate services (versioned protos/OpenAPI, independent deployments, distributed tracing across hops) is a tax that slows you down.

4. **No immediate multi-tenancy requirement.** If all sandboxes are for the same single org/user right now, threading team_id through a separate service boundary is pure overhead.

### Practical recommendation

For a small team building a sandbox product:

**Phase 1 (≤6 months):** Single service. The "resolved spec" pattern is still the right internal discipline — write a `createSandbox(ResolvedSpec)` function that accepts only already-resolved, already-validated data. Keep auth/quota/template-merging in a separate module (not a separate service). This buys you the clean design without the operational cost.

**Phase 2 (multi-region, BYOC, or platform API):** Lift that function boundary into a proper service. The investment is now justified because you're running the core in environments where you can't deploy your whole monolith.

The Fly.io / E2B / Nomad examples all confirm this: the low-level API was not designed first — it was *extracted* after the product proved its shape. The exception is Firecracker/containerd/Kubernetes, where the split was *standards-motivated* from the start — but those are infrastructure commons projects, not single-product startups.

---

## 5. Sources

1. Fly.io Machines API overview: https://fly.io/docs/machines/overview/
2. Fly.io Apps overview: https://fly.io/docs/apps/overview/
3. Fly.io Machines API reference: https://fly.io/docs/machines/api/
4. Fly.io Machines API full reference: https://docs.machines.dev/
5. E2B system architecture (DeepWiki): https://deepwiki.com/e2b-dev/infra/2-system-architecture
6. E2B orchestrator source (sandboxes.go): https://github.com/e2b-dev/infra/blob/8e108dbe/packages/orchestrator/pkg/server/sandboxes.go
7. E2B sandbox API reference: https://e2b.dev/docs/api-reference/sandboxes/create-sandbox
8. E2B BYOC architecture: https://e2b.dev/docs/byoc
9. E2B template system: https://www.e2b.dev/docs/template/quickstart
10. Firecracker-containerd architecture: https://github.com/firecracker-microvm/firecracker-containerd/blob/master/docs/architecture.md
11. Firecracker-containerd design approaches: https://github.com/firecracker-microvm/firecracker-containerd/blob/main/docs/design-approaches.md
12. Kata containers + Firecracker: https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-kata-containers-with-firecracker.md
13. Kubernetes components: https://kubernetes.io/docs/concepts/overview/components/
14. Kubernetes CRI: https://kubernetes.io/docs/concepts/architecture/cri/
15. Knative serving architecture: https://knative.dev/docs/serving/architecture/
16. Nomad architecture: https://developer.hashicorp.com/nomad/docs/architecture
17. Nomad task driver plugin: https://docs.hashicorp.com/nomad/plugins/author/task-driver
18. containerd architecture (The containerd book): https://thecontainerdbook.com/chapters/part-4/10-containerd-architecture
19. containerd runtime v2: https://github.com/containerd/containerd/blob/main/docs/runtime-v2.md
20. Northflank Enterprise (BYOC / forward-deployed control plane): https://northflank.com/enterprise
21. OpenSandbox architecture (open-source sandbox orchestration project): https://open-sandbox.ai/architecture/
22. Microsoft MXC state-aware sandbox lifecycle proposal: https://github.com/microsoft/mxc/blob/main/docs/state-aware-lifecycle/mxc-state-aware-sandbox-api.md
