# Kata runtime evaluation

Checks whether a Kata RuntimeClass can run atelier sandboxes, before pointing
`30-config.yaml` `kubernetes.runtimeClass` at it. Re-run after every
kata-deploy upgrade, runtime drop-in change, or node storage change.

The pods mirror `buildSandboxPod` (`apps/server/src/runtime/kube/kube.resources.ts`):
`sandbox-boot.sh` entrypoint, uid 0 + `SYS_ADMIN`, raw block PVC on
`topolvm-thin` at `/dev/atelier-data`, the ssh-key Secret mount, and
`requests.memory == limits.memory`. Everything runs in a throwaway namespace
(`kata-eval`), deleted at the end unless `KEEP=1`.

## Requirements

- `kubectl` context for the cluster (`KUBE_CONTEXT`, default `hetzner-atelier`).
- `ssh` to the node (`NODE_SSH`, default `hetzner`): agent calls and host
  cgroup/OOM facts are read from there. The scripts reuse one multiplexed
  connection because the node rate-limits ssh (`ufw limit 22`, fail2ban).
- Image: `dev-base:latest` from Zot, resolved to its digest at start
  (override with `IMAGE=...`).
- Optional `TOOLSET_REF=zot.zot.svc:5000/toolsets/...@sha256:...`: a real
  toolset to materialize. Without it the home is skel-only and the
  lower-dir rename check may be skipped.

## `validate.sh <runtimeClass> [rollbackClass]` (the cutover gate)

Exits 0 only if every check passes:

| Check | What it proves |
|-------|----------------|
| Node prerequisites | Thin-pool loop device has direct I/O; `kvm_amd sev` is off (runtime-rs CLH fails every VM start otherwise) |
| Fresh boot | Block PVC passthrough, the mkfs guard formats a new disk, `/data` is ext4 on `/dev/atelier-data` |
| Materialize + overlay | Agent `POST /toolsets`, erofs loop mount, `/home/dev` overlay, `/run/home-ready`, sshd, writes as `dev` |
| Lower-dir rename | `redirect_dir` + `trusted.overlay.*` on the ext4 upper (the reason for the block-PVC design) |
| Memory bound | 3 x 1.5 GiB page-cache churn then an anon hog: the host must **not** OOM-kill the VM; the guest OOM killer takes the hog |
| Disk portability | With a rollback class: the disk resumes on it and back without reformat or data loss |
| Teardown | The pod's VMM process exits with the pod |

`MEM=4Gi` tests a bigger pod (default 2Gi, the tightest common size).

## `extended.sh <runtimeClass>`

The other runtime-dependent paths, still at pod level:

| Check | What it proves |
|-------|----------------|
| Toolset build + capture | `mkfs.erofs` + `oras push` from inside the guest (`POST /toolsets/build`, `/toolsets/capture`) |
| Built artifact in a new VM | The pushed toolset materializes and runs in a fresh sandbox |
| Pause/resume shape | Guest `sync`, VolumeSnapshot of the live PVC, clone, boot the clone: no reformat, data intact, home assembled |
| SSH | `ssh dev@<pod IP>` with the Secret-mounted key (the sshpiper / in-server proxy path) |

It pushes two tiny probes to `toolsets/kata-eval/probe` in Zot and deletes
them at the end.

Not covered at pod level (runtime-independent or server-side, so check them
through Atelier after a cutover): tool ingresses, the terminal WebSocket,
the server's own prebuild orchestration.

## `bench.sh <runtimeClass>...`

Cold boot to agent-healthy (`BOOT_RUNS`, default 3), raw disk I/O (fio,
O_DIRECT, bypasses the guest cache) and a small-file workload on the home
overlay, one class at a time. `MEM` defaults to 4Gi.

## Results (hetzner-atelier, Kata 4.2.0, 2026-09-29)

`validate.sh`, with `kata-atelier-clh` as rollback:

| Class / settings | Result |
|------------------|--------|
| `kata-atelier-clh` (Go runtime) | Memory bound FAILS at any overhead: guest RAM = limit + 2 GiB |
| stock `kata-clh-runtime-rs` (130Mi, no cache_direct) | 11/15: memory bound FAILS (host OOM kill) |
| `kata-atelier-clh-rs` (infra-core release: 384Mi + `block_device_cache_direct`) | **15/15** at 2Gi (peak 2092/2432 Mi), **13/13** at 4Gi (peak 4137/4480 Mi); `extended.sh` **8/8** |

The memory bound needs all three: runtime-rs static sizing +
`block_device_cache_direct = true`, the 384Mi overhead, and loop direct I/O
on the node (see `../kata-atelier-values.yaml`).

`bench.sh`, 4Gi pods, loop direct I/O on (Go `kata-atelier-clh` vs runtime-rs):

| | Go | runtime-rs |
|---|---|---|
| Boot to agent healthy | ~6.2s | ~5.9s |
| fio randread 4k QD32 | ~125k IOPS | ~72k IOPS |
| fio randrw 4k QD1 | ~12k IOPS | ~4k IOPS |
| fio seqread 1M | ~1.1 GB/s | ~4.4 GB/s |
| fio seqwrite 1M | ~0.3-0.6 GB/s | ~0.7-0.8 GB/s |
| Copy 731 MB / 13k files into home | 4.2-6.4s | 3.8-4.1s |

The Go runtime's random-read numbers come from the host page cache, which is
the memory charged to the pod that gets VMs killed; runtime-rs with
`block_device_cache_direct` reads the disk. Hot files still come from the
guest's own cache (inside the pod limit), so everyday workloads are not
slower.

## Known limitations

- **No discard/fstrim on the PVC** with either runtime: runtime-rs only
  enables discard for block-plain emptyDir, not raw block volumes. Deleted
  workspace data is not returned to the thin pool.
- The Kata 4.2 runtime-rs CLH backend probes guest protection even for
  non-confidential guests and checks the SNP CPUID bit for SEV, hence the
  `kvm_amd sev=0` node requirement on AMD hosts without usable SEV.
