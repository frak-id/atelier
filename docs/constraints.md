# Critical Constraints

Things that will break the system if ignored.

## Bun vs Node.js Runtimes

| Component | Runtime | Why |
|-----------|---------|-----|
| Server API | **Bun** | Performance, native Elysia |
| Console | **Vite/Browser** | React SPA, static deploy |
| Sandbox Agent | **Rust (Tokio)** | Static musl binary — Bun crashes (SIGILL) inside Kata VMs due to AVX instruction issues |

```bash
# Agent build - Rust compile for Linux (apps/agent-v2)
cargo build --release --target x86_64-unknown-linux-musl
```

## KVM Is Mandatory

Kata Containers needs `/dev/kvm` on the host. Standard cloud VMs without nested virtualization will not run sandboxes — use bare metal. If sandbox pods stay in `ContainerCreating`, check that the `kata-clh` RuntimeClass exists and `/dev/kvm` is present.

## Prebuilds Require CSI Snapshots

Prebuilds need a CSI driver with VolumeSnapshot support (e.g. TopoLVM) **and** the CSI snapshot controller. Without them, the server disables prebuilds automatically at startup — sandboxes still work, they just boot the slow path (clone + init every time).

## OpenCode Config Is Read Once

OpenCode reads `~/.config/opencode/opencode.json` (plugins + the baked CLIProxy API key) at bootstrap and never re-reads it. The spawn ordering `create CLIProxy key → sync configs → start opencode` cannot be reordered — opencode must not start before the config write lands.

## CLIProxy Config Overwrites

With `cliproxy.configSeedStrategy: hash-sync`, a `helm upgrade` that changes `apiKeys`, `extraConfig`, or `port` **overwrites** any changes made via the management UI. The default `seed-once` preserves UI changes but ignores later Helm value changes until the PVC is wiped.

## Cloudflare

If using Cloudflare, disable Rocket Loader — it breaks WebSocket connections used by code-server and the terminal.

## Cleanup Is Label-Based

Sandbox destruction deletes everything labeled `atelier.dev/sandbox={id}` (pods, services, configmaps, PVCs, ingresses, volumesnapshots). Any manually created resource for a sandbox **must** carry this label or it leaks.

## Toolsets Are Content-Addressed, Not Shared-PVC

code-server, opencode, and any org toolbox are built as content-addressed toolset artifacts (`toolsets/{name}@{digest}`), pushed to Zot, and materialized into the overlay home by the in-pod agent before the primary process starts. There is no shared `ReadOnlyMany` PVC or populate Job (the old v1 `shared-binaries` mount) — a missing toolset means materialize fails for that sandbox, not a global outage.

## Mock Mode

The server runs without KVM/K8s locally:

```bash
ATELIER_SERVER_MODE=mock bun run --filter @atelier/server dev
```

All infrastructure services check `isMock()` and return mock responses.

## TUI Warp Phantom-Instance (Upstream Bug)

Warping a local OpenCode TUI session into an Atelier sandbox lands on an empty/phantom instance. Use the console (or SSH/VSCode-Remote) instead.

Cause: the TUI configures `@opencode-ai/sdk` with `directory = process.cwd()` (the user's local Mac path). The SDK injects `?directory=<local cwd>` into every GET. After proxy, the remote opencode's `WorkspaceRoutingMiddleware.defaultDirectory()` reads `?directory` first — a path that doesn't exist on the VM — and bootstraps a phantom instance disconnected from the real workspace at `/home/dev/workspace/<repo>`.

The console is unaffected: it constructs the SDK without a `directory` config, so the remote falls back to its own `process.cwd()` (the workspace dir).
