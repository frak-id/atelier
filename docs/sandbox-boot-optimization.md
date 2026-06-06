# Sandbox Boot Optimization Plan

Target: workspace sandbox **booted with OpenCode responding in < 5s** (VS Code may
trail — it is lazy since the tool-registry refactor). Current ≈ 6–7s.

This plan covers four independent work items. Three are in-repo code changes; the
fourth (Kata) is a host-side review tracked here for completeness.

## Current boot path (reference)

`SandboxSpawner.spawn` → `createWorkspaceSandbox` → `bootNewSandbox`:

```
bootNewSandbox                                 (kernel/sandbox-boot.ts)
  PVC(snapshot) → Promise.all[ConfigMap, Pod, Service, opencode-Ingress, SshPipe]
  waitForAgent (≤120s)                         ◀ BLOCK #1: Kata VM boot + agent bind (~3–4s)
createWorkspaceSandbox                         (workflows/create-workspace.ts)
  await cliproxy.createSandboxKey              ◀ serial network round-trip (:76)
  Promise.all[syncAllToSandbox, writeFiles]    ◀ writes opencode.json (plugins + cliproxy key)
  (non-prebuild) clone repos
  startServices(["opencode"])                  ◀ (:144)
  waitForOpencodeHealthy                        ◀ BLOCK #2: opencode HTTP bind (~1–2s)
  finalizeNewSandbox
```

Hard invariant (confirmed in code): opencode reads `~/.config/opencode/opencode.json`
(plugin list) and the baked CLIProxy `apiKey` at instance bootstrap and never re-reads
them. `injectCliProxyProvider` bakes the key (`internal.service.ts:165-171`) from what
`createSandboxKey` persisted (`cliproxy.service.ts:215-217`). Therefore the order
`createKey → syncConfigs → startServices(opencode)` cannot be reordered, and opencode
cannot start before the config write. The optimizations below remove *latency*, not the
ordering.

---

## 1. CLIProxy key: deterministic value + fire-and-forget registration + race fix

### Problem
- `createSandboxKey` (`cliproxy.service.ts:199`) generates a **random** suffix
  (`crypto.randomUUID()`, :209-210), so the workflow must `await` the CLIProxy
  management round-trip before the config sync can bake the key — it sits serially on
  the hot path (`create-workspace.ts:76-80`).
- `managementAddKey` (`cliproxy.service.ts:552-600`) is a read-modify-write:
  `GET /api-keys → push → PUT /api-keys` (:566-587). Concurrent spawns race on the
  shared list and can clobber each other's keys → a sandbox silently ends up with no
  CLIProxy auth.

### Design
Make the key a **deterministic, unguessable** function of the sandbox id, so the value
is known locally with zero network wait. Registration with CLIProxy becomes
fire-and-forget (it only has to land before the first model call, which is much later);
we `await` it once near the end purely for peace of mind.

1. **Derive the key locally (no I/O).** Domain-separated HMAC over the stable server
   secret `config.auth.jwtSecret` (already required to be non-default in prod —
   `config.schema.ts:81`, `config.loader.ts:207`). Optionally allow a dedicated
   `ATELIER_CLIPROXY_KEY_SECRET` that falls back to `jwtSecret`.

   ```ts
   // cliproxy.service.ts
   import { createHmac } from "node:crypto";

   private deriveSandboxKey(sandboxId: string): string {
     const secret = config.auth.jwtSecret;
     const mac = createHmac("sha256", secret)
       .update(`cliproxy-sandbox-key:${sandboxId}`)
       .digest("hex")
       .slice(0, 32); // 128 bits — unguessable, stable
     return `${KEY_PREFIX}-${sandboxId}-${mac}`;
   }
   ```

2. **`getSandboxApiKey` returns the derived key** (stateless — no settings read).
   `injectCliProxyProvider` is unchanged and bakes the correct key into `opencode.json`
   without waiting for registration.

3. **`createSandboxKey` → `ensureSandboxKey`** (idempotent registration only):
   derive → `managementAddKey`. No `SANDBOX_KEYS_KEY` persistence needed anymore (drop
   it).

4. **`revokeSandboxKey`** derives the key and calls `managementDeleteKey`
   (`sandbox-destroyer.ts:28` unchanged at the call site).

5. **Race + idempotency fix in `managementAddKey`:**
   - Wrap the `GET → PUT` in a process-level mutex (`async-mutex`, already a dependency)
     so concurrent spawns serialize. Single manager pod ⇒ in-process mutex is sufficient.
   - After the `GET`, short-circuit if the key is already present
     (`if (keys.includes(apiKey)) return true;`) — makes registration retry-safe and a
     no-op on restart.

6. **Workflow change** (`create-workspace.ts`): drop the serial `await` at :76-80, fire
   registration before `bootNewSandbox`, and `await` it at the end.

   ```ts
   // sandboxId is known immediately; ensureSandboxKey needs no pod.
   const cliproxyKeyReg = ports.cliproxy
     .ensureSandboxKey(sandboxId)
     .catch((err) => { log.warn({ err, sandboxId }, "CLIProxy key registration failed"); return null; });

   boot = await bootNewSandbox(...);            // registration overlaps VM boot
   // ...config prep...
   const [syncResult] = await Promise.all([     // bakes the DERIVED key — no wait on registration
     ports.internal.syncAllToSandbox(sandboxId),
     ports.agent.writeFiles(sandboxId, [...]),
   ]);
   // ...clone, startServices(["opencode"]), waitForOpencodeHealthy...
   await cliproxyKeyReg;                         // peace of mind before marking running
   return finalizeNewSandbox(...);
   ```

### Files
- `apps/manager/src/modules/cliproxy/cliproxy.service.ts` — add `deriveSandboxKey`;
  rework `getSandboxApiKey`, `createSandboxKey`→`ensureSandboxKey`, `revokeSandboxKey`;
  add mutex + idempotent check to `managementAddKey`; remove `SANDBOX_KEYS_KEY` use.
- `apps/manager/src/orchestrators/workflows/create-workspace.ts` — move/await as above.
- (Optional) `restart-workspace.ts` / `restart-workspaceless.ts` — fire
  `ensureSandboxKey` (idempotent) so a wiped CLIProxy re-registers on restart.

### Migration / rollout
- Existing running sandboxes keep their old random key baked in their `opencode.json`;
  those keys remain registered in CLIProxy until the sandbox is destroyed. New/restarted
  sandboxes use the derived key. No coordinated migration required.
- One caveat: the new `revokeSandboxKey` derives, so it won't delete *old random* keys.
  Acceptable (they are bounded by sandbox lifetime); optionally add a one-time cleanup
  that prunes `atelier-sbx-*` keys with no live sandbox.

### Risks
- Predictable key shape → mitigated by the HMAC suffix (unguessable without the secret).
- Reusing `jwtSecret` for derivation → domain-separated; optional dedicated secret.

### Acceptance
- `createSandboxKey` no longer on the serial hot path (reclaims ~200–600ms, more when
  CLIProxy is slow).
- opencode boots with the correct CLIProxy key from the first config write.
- Concurrent spawns never lose keys (race test: spawn N sandboxes in parallel, assert all
  N keys present in CLIProxy).

---

## 2. Sandbox pod `imagePullPolicy`

### Problem
`buildSandboxPod` (`kube.resources.ts:140-178`) sets no `imagePullPolicy`, and the image
is `…/<baseImage>:latest` (`sandbox-boot.ts:384`). Kubernetes defaults `:latest` to
`imagePullPolicy: Always`, so every spawn does a registry manifest round-trip to Zot
before the Kata VM can start.

### Design
- Set `imagePullPolicy: "IfNotPresent"` on the sandbox container.

  ```ts
  // kube.resources.ts — inside the container object, after `image`
  image: options.image,
  imagePullPolicy: "IfNotPresent",
  ```

### Caveat & robust variant
With `IfNotPresent`, a base image rebuilt and re-pushed to `:latest` will **not** be
re-pulled on nodes that cached the old layer. Options:
- **Simple (recommended first):** `IfNotPresent`, and make the base-image build flow
  (`BaseImageBuilder`) trigger a pull/refresh (or rely on node image GC) after publish.
- **Robust:** resolve `:latest` → digest once in the manager and put the digest in the
  pod spec (`…@sha256:…`). New build ⇒ new digest ⇒ automatic re-pull, still no per-spawn
  manifest fetch on the hot path.

### Files
- `apps/manager/src/infrastructure/kubernetes/kube.resources.ts` (`buildSandboxPod`).
- (Robust variant) `sandbox-boot.ts:resolveSandboxImage` + a digest-resolve cache.

### Acceptance
- Pod start no longer blocks on a Zot manifest round-trip on a warm node
  (reclaims ~0.3–1s). Rebuild-then-spawn still picks up the new image (verify chosen
  variant).

---

## 3. SSH host keys baked into the image

### Problem
`sandbox-boot.sh:30` runs `ssh-keygen -A` when `/etc/ssh/ssh_host_*` is missing. `/etc/ssh`
lives in the image rootfs (regenerated every boot — only `/home/dev` is the PVC), so host
keys are generated on **every** spawn, and the whole SSH block runs synchronously before
`exec /usr/local/bin/sandbox-agent` (:37) — delaying agent-ready.

### Design
1. **Bake host keys at image build** so boot-time generation is a no-op:

   ```dockerfile
   # infra/images/dev-base/Dockerfile (before the /home/dev → /home/skel move)
   RUN ssh-keygen -A
   ```

   Security: all sandboxes share host keys. Acceptable because SSH only enters via
   sshpiper, which sets `ignore_hostkey: true` (`kube.resources.ts:605`); clients never
   pin a sandbox's host key directly.

2. **(Optional) Background the SSH setup** so `authorized_keys` copy + `sshd` start don't
   gate the agent:

   ```sh
   # sandbox-boot.sh — wrap the SSH block, then exec
   ( ssh_setup ) &
   exec /usr/local/bin/sandbox-agent "$@"
   ```
   The agent reaps the backgrounded child (zombie reaper in `agent-rust/src/main.rs`);
   `sshd` daemonizes itself.

### Files
- `infra/images/dev-base/Dockerfile` (bake keys).
- `infra/images/dev-base/rootfs/etc/sandbox/sandbox-boot.sh` (optional backgrounding).

### Acceptance
- `ssh-keygen` no longer runs at boot (removes ~100–300ms before agent-ready on every
  spawn). SSH access via `ssh sandbox-<id>@host` still works through sshpiper.

---

## 4. Kata VM boot review (out of this repo)

Block #1 (~3–4s) is dominated by Cloud Hypervisor microVM boot. There is **no Kata config
in this repo** — only `runtimeClassName: kata-clh`. The kernel/initrd/memory/virtio
settings live in the host `kata-deploy` install. Track as an ops spike, not a code change.

### Review checklist (host `configuration-clh.toml`)
- **VM templating / cache** — `enable_template = true` and a warm VM cache
  (`vm_cache_number > 0` or the newer factory/cache). Biggest lever: pre-warmed VMs can
  cut per-sandbox boot toward sub-second.
- **Memory prealloc OFF** (`enable_mem_prealloc = false`) for faster start; tune
  `default_memory` / `default_vcpus` so we don't over-allocate.
- **rootfs format** — initrd vs image; nvdimm/DAX for the guest rootfs.
- **virtio-fs / DAX** for shared mounts; confirm the `/opt/shared` (virtio-blk) path is
  not a cold-read bottleneck for the opencode/code-server binaries.
- **Debug off** — `enable_debug = false`, agent tracing disabled.
- **Kernel cmdline** — minimal drivers/probes.

### Measurement
- `kata-runtime kata-env` to dump effective config.
- Time pod `Pending → Running` (kubelet/containerd events) vs `waitForAgent` success.
- Compare cold vs templated boot.

### Deliverable
A separate spike doc (see existing `docs/kata-migration-plan.md`). Coordinate with whoever
manages `kata-deploy` on the host.

---

## Sequencing & priority

1. **#2 imagePullPolicy** — one line, immediate cold-registry win, lowest risk.
2. **#1 CLIProxy deterministic key + race fix** — removes the serial round-trip and fixes
   a latent key-loss bug.
3. **#3 SSH host keys baked** — small image change, every-boot win.
4. **#4 Kata review** — parallel ops track; largest ceiling but host-side.

## Validation (apply before/after each item)

Add phase timing logs in the spawn workflow to attribute latency:
`waitForAgent`, config sync, `startServices`, `waitForOpencodeHealthy`. Capture median
over ~10 prebuild spawns before and after. Success = OpenCode `/health` healthy < 5s from
spawn on the prebuild path.
