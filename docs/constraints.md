# Critical Constraints

Things that will break the system if ignored.

## Bun vs Node.js Runtimes

| Component | Runtime | Why |
|-----------|---------|-----|
| Manager API | **Bun** | Performance, native Elysia |
| Dashboard | **Vite/Browser** | React SPA, static deploy |
| Sandbox Agent | **Rust (Tokio/Hyper)** | Lightweight static musl binary — Bun crashes (SIGILL) inside Kata VMs due to AVX instruction issues |

```bash
# Agent build - Rust compile for Linux
cargo build --release --target x86_64-unknown-linux-musl
```

## KVM Is Mandatory

Kata Containers needs `/dev/kvm` on the host. Standard cloud VMs without nested virtualization will not run sandboxes — use bare metal. If sandbox pods stay in `ContainerCreating`, check that the `kata-clh` RuntimeClass exists and `/dev/kvm` is present.

## Prebuilds Require CSI Snapshots

Prebuilds need a CSI driver with VolumeSnapshot support (e.g. TopoLVM) **and** the CSI snapshot controller. Without them, the manager disables prebuilds automatically at startup — sandboxes still work, they just boot the slow path (clone + init every time).

## OpenCode Config Is Read Once

OpenCode reads `~/.config/opencode/opencode.json` (plugins + the baked CLIProxy API key) at bootstrap and never re-reads it. The spawn ordering `create CLIProxy key → sync configs → start opencode` cannot be reordered — opencode must not start before the config write lands.

## CLIProxy Config Overwrites

With `cliproxy.configSeedStrategy: hash-sync`, a `helm upgrade` that changes `apiKeys`, `extraConfig`, or `port` **overwrites** any changes made via the management UI. The default `seed-once` preserves UI changes but ignores later Helm value changes until the PVC is wiped.

## Cloudflare

If using Cloudflare, disable Rocket Loader — it breaks WebSocket connections used by code-server and the terminal.

## Cleanup Is Label-Based

Sandbox destruction deletes everything labeled `atelier.dev/sandbox={id}` (pods, services, configmaps, PVCs, ingresses, volumesnapshots). Any manually created resource for a sandbox **must** carry this label or it leaks.

## Shared Binaries Mount

code-server and opencode live on a `ReadOnlyMany` PVC mounted at `/opt/shared` in every sandbox. If the shared-binaries Job hasn't completed (or the PVC fails to mount), sandboxes boot but `/opt/shared/bin/*` is missing and services fail to start.

## Mock Mode

Manager runs without KVM/K8s locally:

```bash
ATELIER_SERVER_MODE=mock bun run dev
```

All infrastructure services check `isMock()` and return mock responses.

## TUI Warp Phantom-Instance (Upstream Bug)

Warping a local OpenCode TUI session into an Atelier sandbox lands on an empty/phantom instance. Use the dashboard (or SSH/VSCode-Remote) instead.

Cause: the TUI configures `@opencode-ai/sdk` with `directory = process.cwd()` (the user's local Mac path). The SDK injects `?directory=<local cwd>` into every GET. After proxy, the remote opencode's `WorkspaceRoutingMiddleware.defaultDirectory()` reads `?directory` first — a path that doesn't exist on the VM — and bootstraps a phantom instance disconnected from the real workspace at `/home/dev/workspace/<repo>`.

Dashboard is unaffected: it constructs the SDK without a `directory` config, so the remote falls back to its own `process.cwd()` (the workspace dir).

Full breakdown: see [`packages/opencode-atelier/README.md`](../packages/opencode-atelier/README.md#known-limitations).
