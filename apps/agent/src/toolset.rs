//! Toolset artifact build/push (docs/proposals/toolset-overlay-squashfs.md).
//! The agent packages declared home path-sets as a single read-only erofs
//! blob and pushes it as an OCI artifact to the in-cluster registry by
//! shelling out to the baked `oras` + `mkfs.erofs` CLIs. Materialize is the
//! mirror image: pull ONE blob per toolset (skipped if already present on the
//! PVC), loop-mount each read-only, then stack them as overlayfs lowerdirs
//! over the writable PVC upper — a mount, not a per-file copy. The agent
//! links NO OCI/HTTP/erofs library — it stays lean and orchestrates the
//! tools already present in the image (the runtime never proxies the bytes).
//!
//! Blob format is auto-detected, not hard-coded: the agent packages with
//! whichever read-only FS the guest kernel can mount (see `BlobFormat`),
//! preferring `erofs` and falling back to `squashfs`. This keeps the scheme
//! portable across Kata guest kernels — e.g. the Cloud-Hypervisor guest here
//! (kernel 6.18.x) ships `erofs`+`overlay`+loop but NOT `squashfs`, while a
//! QEMU guest built with `CONFIG_SQUASHFS` would use squashfs. The chosen
//! format is recorded in the OCI layer media type and the blob's file
//! extension, and materialize mounts each blob by its own recorded format —
//! so a build and its consumers only need to agree per-blob, not globally.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::command;

const HOME: &str = "/home/dev";
const SKEL: &str = "/home/skel";
/// Overlay upperdir/workdir/blob-store — all on the PVC (mounted at `/data`,
/// see docs/proposals/toolset-overlay-squashfs.md §3). Blobs living here
/// (not in a per-sandbox tmpfs) is what makes resume registry-independent —
/// a pause `VolumeSnapshot` of `/data` carries them.
const DATA_UPPER: &str = "/data/upper";
const DATA_WORK: &str = "/data/work";
const DATA_TOOLSETS: &str = "/data/toolsets";
/// Per-blob loop-mount points. Ephemeral (tmpfs-backed `/run`) — mounts don't
/// survive pod recreation, so materialize re-mounts every boot (idempotent:
/// the blob pull is skipped when already on the PVC, only the mount reruns).
const RUN_TOOLSETS: &str = "/run/toolsets";
/// Written by `materialize` as its last step, once `/home/dev` is fully
/// assembled. `sandbox-boot.sh` waits for this file before starting sshd —
/// the race-free handshake that replaces the old base-overlay-then-remount
/// design (docs/proposals/toolset-overlay-squashfs.md §5): nothing can hold
/// `/home/dev` busy before this point, because nothing touches it before
/// this point.
pub(crate) const HOME_READY_MARKER: &str = "/run/home-ready";
/// Written by `materialize` when assembly FAILS. The entrypoint waits for
/// either this or HOME_READY_MARKER, so a genuine failure starts sshd (onto a
/// degraded home, for diagnosis) immediately instead of burning the full pull
/// budget waiting for a `/run/home-ready` that will never appear
/// (toolset-overlay-squashfs.md §5).
const HOME_FAILED_MARKER: &str = "/run/home-failed";
/// The last successful materialize's toolset selection, persisted on the PVC
/// (so it rides the pause snapshot). Read by `self_heal_home` to re-assemble
/// `/home/dev` after a whole-container (kubelet) restart — which the runtime
/// does NOT re-drive. Lives under DATA_TOOLSETS but is not a blob
/// (`*.erofs`/`*.sqfs`), so the stale-blob sweep leaves it alone.
const MATERIALIZE_REQUEST_PATH: &str = "/data/toolsets/.materialize.json";
/// Overlay mount option tail for `/home/dev`. `/data` (the upper) is a native
/// ext4 on a virtio-blk device — NOT a virtio-fs share — so overlayfs gets real
/// `trusted.overlay.*` xattrs and we do NOT use `userxattr`. `redirect_dir=on`
/// is passed explicitly (don't rely on the kernel default) so npm's atomic
/// rename-then-mkdir works on the first in-place toolset update; `index`/
/// `metacopy` stay off (see toolset-inplace-update-fix-options.md §5).
const OVERLAY_MOUNT_OPTS: &str = "redirect_dir=on,index=off,metacopy=off";
const ARTIFACT_TYPE: &str = "application/vnd.atelier.toolset.v1";

// The shell the agent drives lives in apps/agent/scripts (one file per step,
// see its README). Each runs as `bash -c <script> bash <args...>`: paths,
// globs and references go in as positional args, fixed settings as env.
const SWEEP_STAGE_SCRATCH_SH: &str = include_str!("../scripts/sweep-stage-scratch.sh");
const SQUASH_AND_PUSH_SH: &str = include_str!("../scripts/squash-and-push.sh");
const SCAN_SECRETS_SH: &str = include_str!("../scripts/scan-secrets.sh");
const PULL_BLOB_SH: &str = include_str!("../scripts/pull-blob.sh");
const MOUNT_BLOB_SH: &str = include_str!("../scripts/mount-blob.sh");
const ASSEMBLE_HOME_SH: &str = include_str!("../scripts/assemble-home.sh");
const SWEEP_STALE_BLOBS_SH: &str = include_str!("../scripts/sweep-stale-blobs.sh");

fn env_map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// Run a script with the agent's usual bounds; `user: None` is root.
async fn run_script(
    script: &str,
    args: &[String],
    timeout_ms: u64,
    user: Option<&str>,
    env: &HashMap<String, String>,
    login: bool,
) -> command::ExecResult {
    command::run_script(script, args, timeout_ms, user, env, login).await
}

/// A read-only, loop-mountable blob filesystem. The agent builds with the
/// preferred format the guest kernel supports and mounts each blob by the
/// format it was actually built with (recorded in its file extension).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BlobFormat {
    Erofs,
    Squashfs,
    /// zstd-compressed tarball. NOT loop-mounted — extracted into a plain
    /// directory used directly as an overlay lowerdir. The copy fallback for a
    /// guest kernel that can mount neither erofs nor squashfs (the real
    /// portability enabler for locked-down/rootless — proposal §6): tar needs
    /// no read-only filesystem driver and no loop device.
    Tar,
}

impl BlobFormat {
    /// Loop-mount preference order (erofs first — modern, and what the CLH guest
    /// here supports; squashfs second). `Tar` is deliberately absent: it is the
    /// extraction fallback chosen only when neither mountable format is
    /// available, not a mount option to prefer. Detection scans
    /// `/proc/filesystems`.
    const PREFERENCE: [BlobFormat; 2] = [BlobFormat::Erofs, BlobFormat::Squashfs];

    /// `mount -t` filesystem type, or `None` for a format that is extracted
    /// rather than mounted (`Tar`).
    fn fs_type(self) -> Option<&'static str> {
        match self {
            BlobFormat::Erofs => Some("erofs"),
            BlobFormat::Squashfs => Some("squashfs"),
            BlobFormat::Tar => None,
        }
    }

    /// On-PVC blob file extension (`<digest>.<ext>`). Also how materialize
    /// recovers a blob's format on resume (the extension is the record). `tzst`
    /// is a single extension (not `tar.zst`) so `<digest>.tzst` survives the
    /// `<digest>.*` glob + `${blob##*.}` extension recovery unchanged.
    fn ext(self) -> &'static str {
        match self {
            BlobFormat::Erofs => "erofs",
            BlobFormat::Squashfs => "sqfs",
            BlobFormat::Tar => "tzst",
        }
    }

    /// OCI layer media type stamped on push (debuggable provenance; the mount
    /// path keys off the extension, not this).
    fn media_type(self) -> &'static str {
        match self {
            BlobFormat::Erofs => "application/vnd.atelier.toolset.layer.v1.erofs",
            BlobFormat::Squashfs => "application/vnd.atelier.toolset.layer.v1.squashfs",
            BlobFormat::Tar => "application/vnd.atelier.toolset.layer.v1.tar+zstd",
        }
    }

    /// The `BLOB_FORMAT` value squash-and-push.sh switches on to pick the
    /// packer (mkfs.erofs / mksquashfs / tar).
    fn name(self) -> &'static str {
        match self {
            BlobFormat::Erofs => "erofs",
            BlobFormat::Squashfs => "squashfs",
            BlobFormat::Tar => "tar",
        }
    }
}

/// Choose the build format from a kernel-support predicate: the first
/// loop-mountable format the guest supports, else `Tar` (extraction needs no
/// read-only FS driver, so it always works — removing the old hard-error).
/// Pure so it is unit-testable without a real `/proc/filesystems`.
fn select_build_format(is_supported: impl Fn(&str) -> bool) -> BlobFormat {
    BlobFormat::PREFERENCE
        .into_iter()
        .find(|f| f.fs_type().is_some_and(&is_supported))
        .unwrap_or(BlobFormat::Tar)
}

/// Pick the build format this guest kernel supports, by scanning
/// `/proc/filesystems` (authoritative for built-ins; the minimal Kata guest
/// has no loadable-module tree). Build/capture run on the same guest kernel
/// as the consuming sandboxes, so this is exactly “what can be mounted here”;
/// when neither erofs nor squashfs is mountable it falls back to `Tar`.
async fn detect_build_format() -> BlobFormat {
    let listed = tokio::fs::read_to_string("/proc/filesystems")
        .await
        .unwrap_or_default();
    select_build_format(|fs| listed.split_whitespace().any(|w| w == fs))
}
/// Packaging stages the selected path-sets into a scratch tree here, on the
/// PVC-backed home (the overlay's `/data/upper`), NOT the pod's small
/// ephemeral rootfs `/tmp`: a node_modules-heavy staged copy can be many
/// hundreds of MB and the pod declares no ephemeral-storage budget.
/// Dot-prefixed and not bare `/home/dev`, so build/capture can sweep it at the
/// start of every call (sweep-stage-scratch.sh) without touching user files:
/// the scripts' EXIT-trap cleanup is best-effort and a live capture sandbox
/// would otherwise keep the debris in `~` forever.
const STAGE_DIR: &str = "/home/dev/.atelier-toolset-scratch";
/// Build/push can move hundreds of MB; give it well past the exec default.
const BUILD_TIMEOUT_MS: u64 = 600_000;
/// Grace for the runtime to drive materialize on a fresh boot before
/// `self_heal_home` assumes a kubelet restart and assembles `/home/dev`
/// itself. Comfortably exceeds a healthy create/resume's boot-to-materialize
/// latency; only the (rare) whole-container-restart path waits it out.
const SELF_HEAL_GRACE_MS: u128 = 90_000;

/// Process-global lock serializing overlay assembly. Both the runtime-driven
/// materialize (router) and the restart self-heal go through `materialize`;
/// the lock plus the HOME_READY_MARKER early-return make a concurrent or
/// duplicate call a safe no-op instead of a double `umount`/remount race on
/// the shared upper/workdir.
fn materialize_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Push a set of home path-sets as a toolset artifact. `target` is the full
/// registry reference incl. host (`zot.zot.svc:5000/toolsets/<name>:<tag>`);
/// the runtime owns the naming/tag. `paths` are home-relative or `~`/absolute
/// under `/home/dev`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildRequest {
    pub target: String,
    pub paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResult {
    /// The pushed manifest digest, `sha256:<64 hex>`.
    pub digest: String,
}

/// Materialize toolset artifacts into the home before the files/env phase. The
/// runtime resolves each spec ref to a full, digest-pinned pull reference
/// (`<registry>/toolsets/<name>@sha256:…`) and lists them in order — later
/// wins on path conflicts (same rule as `files[]`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterializeRequest {
    pub toolsets: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializeResult {
    pub materialized: usize,
}

/// Capture a live sandbox's declared path-sets into a toolset artifact
/// (composed-prebuild-volumes.md §2 "captured (result-keyed)"). NOT a
/// baseline diff (there is no prior snapshot to diff against at capture
/// time) — the mechanism is path-set selection: squash exactly `paths` MINUS
/// `exclude` globs (compose-declared additions to the built-in secret-file
/// excludes), scan the included files for secret patterns, and fail the
/// capture on any finding not covered by `overrides`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRequest {
    pub target: String,
    pub paths: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub overrides: Vec<String>,
}

/// Known secret-file basenames/globs excluded from every capture, regardless
/// of the request's own `exclude[]` (proposal §2: "per-harness exclude lists
/// for known secret files" is a floor, not a ceiling the caller can lower).
const DEFAULT_EXCLUDES: &[&str] = &[
    ".git",
    "auth.json",
    "credentials",
    ".credentials",
    ".git-credentials",
    ".netrc",
    "id_rsa",
    "id_ed25519",
    "id_ecdsa",
    "*.pem",
    "*.key",
    ".env",
    ".env.*",
];

/// Curated secret-pattern regexes (POSIX ERE, for `grep -E`), covering the
/// common high-confidence token shapes. Deliberately conservative (few false
/// positives) over exhaustive — a scan that cries wolf trains devs to reach
/// for `overrides` reflexively, defeating the gate.
const SECRET_PATTERNS: &[&str] = &[
    r"AKIA[0-9A-Z]{16}",                   // AWS access key id
    r"ghp_[A-Za-z0-9]{36}",                // GitHub personal access token
    r"github_pat_[A-Za-z0-9_]{22,}",       // GitHub fine-grained PAT
    r"xox[baprs]-[A-Za-z0-9-]{10,}",       // Slack token
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----", // PEM private key
    r"sk-[A-Za-z0-9]{20,}",                // OpenAI/Anthropic-style secret key
    r"sk_(live|test)_[A-Za-z0-9]{16,}",    // Stripe secret key
    r"npm_[A-Za-z0-9]{36}",                // npm access token
    r"hf_[A-Za-z0-9]{20,}",                // Hugging Face token
    r"AIza[0-9A-Za-z_-]{35}",              // Google API key
];

/// Normalize a declared path to one relative to `/home/dev`, rejecting any
/// path that escapes the home (absolute outside home, or `..` segments) — a
/// toolset is home bytes only.
fn rel_to_home(p: &str) -> Result<String, String> {
    let t = p.trim();
    let rel = if let Some(r) = t.strip_prefix("~/") {
        r
    } else if let Some(r) = t.strip_prefix("$HOME/") {
        r
    } else if let Some(r) = t.strip_prefix("/home/dev/") {
        r
    } else if t == "~" || t == "$HOME" || t == "/home/dev" {
        return Err("refusing to capture the entire home directory".into());
    } else if t.starts_with('/') {
        return Err(format!("path '{t}' is outside the home directory"));
    } else {
        t
    };
    if rel.split('/').any(|seg| seg == "..") {
        return Err(format!("path '{t}' must not contain '..'"));
    }
    let rel = rel.trim_end_matches('/');
    if rel.is_empty() || rel == "." {
        // `~/.` / `./` / `$HOME/` all normalize to the whole home — refuse.
        return Err("refusing to capture the entire home directory".into());
    }
    Ok(rel.to_string())
}

/// A `sha256:<64 lowercase-hex>` digest token, or `None`. Normalizes case:
/// `ToolsetRefSchema` pins `[0-9a-f]`, but oras/registries may echo mixed hex.
fn valid_sha256(token: &str) -> Option<String> {
    let hex = token.strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| format!("sha256:{}", hex.to_ascii_lowercase()))
}

/// The bare `<64 lowercase-hex>` half of a `sha256:<hex>` token, or `None` if
/// the token isn't a well-formed sha256 digest. Same validation as
/// `valid_sha256`, but returns the hex only (no `sha256:` prefix) — the form
/// used as a filesystem path component (blob filename, mount point).
fn valid_sha256_hex(token: &str) -> Option<String> {
    valid_sha256(token).map(|s| s.trim_start_matches("sha256:").to_string())
}

/// Extract the pushed manifest digest from `oras push` output. Prefer the
/// explicit `Digest:` label (oras prints the manifest digest there); only then
/// fall back to the first sha256 token, so a layer digest emitted earlier can
/// never be mistaken for the manifest.
fn parse_digest(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|l| l.trim().strip_prefix("Digest:"))
        .and_then(|rest| valid_sha256(rest.trim()))
        .or_else(|| output.split_whitespace().find_map(valid_sha256))
}

/// Sweep `STAGE_DIR` of debris from an earlier build/capture (see
/// sweep-stage-scratch.sh). Best-effort: a failed sweep costs disk, not
/// correctness, so it never fails the call. Run at the START of each call.
async fn sweep_stage_scratch(caller: &str) {
    let res = run_script(
        SWEEP_STAGE_SCRATCH_SH,
        &[],
        BUILD_TIMEOUT_MS,
        Some("dev"),
        &env_map(&[("STAGE_DIR", STAGE_DIR)]),
        true,
    )
    .await;
    if res.exit_code != 0 {
        eprintln!(
            "toolset {caller}: stage-scratch sweep failed (exit {}): {}",
            res.exit_code,
            res.stderr.trim()
        );
    }
}

/// Squash the existing declared path-sets into one blob and `oras push` it to
/// `target`, returning the pushed digest. Missing path-sets are skipped (a
/// build step may legitimately produce a subset); an empty result is an
/// error.
pub async fn build(req: BuildRequest) -> Result<BuildResult, String> {
    sweep_stage_scratch("build").await;
    let mut rels = Vec::new();
    for p in &req.paths {
        let rel = rel_to_home(p)?;
        if std::path::Path::new(HOME).join(&rel).exists() {
            rels.push(rel);
        }
    }
    if rels.is_empty() {
        return Err("none of the declared toolset paths exist in the home".into());
    }

    // Apply the same secret-file/`.git` exclude floor as `capture` — a built
    // toolset's declared paths can contain a `.git` dir or stray dotfile too.
    let excludes = merged_excludes(&[]);
    // Run as `dev` so the staged copy's ownership/readability matches how the
    // build steps installed the files (consistent with `capture`).
    let res = squash_and_push(&rels, &excludes, &req.target).await;
    if res.exit_code != 0 {
        return Err(format!(
            "toolset push failed (exit {}): {}",
            res.exit_code,
            res.stderr.trim()
        ));
    }
    digest_from_push(&res)
}

/// Stage the selected home-relative paths minus `excludes`, pack them into
/// one blob in the format this guest kernel can mount, and `oras push` it to
/// `target` (squash-and-push.sh). Shared by `build` and `capture`; runs as
/// `dev`. Staging with rsync rather than pointing the packer at `/home/dev`
/// keeps the glob-exclude semantics at every depth and the exact rel-path set.
/// Positional args for the scripts that take an exclude list and a path list:
/// `LEAD... EXCLUDE_COUNT EXCLUDE... PATH...`. The count lets a script split
/// the two lists without any quoting or separator that a glob could contain.
fn exclude_path_args(lead: &[String], excludes: &[String], rels: &[String]) -> Vec<String> {
    let mut args = lead.to_vec();
    args.push(excludes.len().to_string());
    args.extend(excludes.iter().cloned());
    args.extend(rels.iter().cloned());
    args
}

async fn squash_and_push(
    rels: &[String],
    excludes: &[String],
    target: &str,
) -> command::ExecResult {
    let fmt = detect_build_format().await;
    let args = exclude_path_args(&[target.to_string()], excludes, rels);
    let env = env_map(&[
        ("HOME_DIR", HOME),
        ("STAGE_DIR", STAGE_DIR),
        ("BLOB_FORMAT", fmt.name()),
        ("BLOB_EXT", fmt.ext()),
        ("BLOB_MEDIA_TYPE", fmt.media_type()),
        ("ARTIFACT_TYPE", ARTIFACT_TYPE),
    ]);
    run_script(
        SQUASH_AND_PUSH_SH,
        &args,
        BUILD_TIMEOUT_MS,
        Some("dev"),
        &env,
        true,
    )
    .await
}

/// Extract the pushed digest from an `oras push` result, or an error carrying
/// the actual stdout/stderr so a changed oras output format is debuggable.
fn digest_from_push(res: &command::ExecResult) -> Result<BuildResult, String> {
    parse_digest(&res.stdout)
        .map(|digest| BuildResult { digest })
        .ok_or_else(|| {
            format!(
                "could not parse pushed digest from oras output (stdout: {}; stderr: {})",
                res.stdout.trim(),
                res.stderr.trim()
            )
        })
}

/// Directories skipped by the secret SCAN only — still squashed into the blob
/// (a toolset that installs npm tools NEEDS its `node_modules`). `.git` holds
/// no user config; `node_modules` is vendored third-party code — never where a
/// capturing user's own credentials live, but riddled with example keys (e.g.
/// AWS's documented `AKIAIOSFODNN7EXAMPLE` in `@aws-sdk` JSDoc `.d.ts` files)
/// and test fixtures. Scanning them only produces false positives that train
/// devs to reach for `overrides` reflexively, defeating the gate (see
/// SECRET_PATTERNS).
const SCAN_EXCLUDE_DIRS: &[&str] = &[".git", "node_modules"];

/// The built-in secret-file excludes plus the request's own, deduplicated
/// in order. Basename globs only (see `capture`), matched at every depth.
fn merged_excludes(request_exclude: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    DEFAULT_EXCLUDES
        .iter()
        .map(|s| s.to_string())
        .chain(request_exclude.iter().cloned())
        .filter(|glob| seen.insert(glob.clone()))
        .collect()
}

/// Does `offender` (an absolute path under `/home/dev` reported by the scan)
/// match an override? Overrides may be given in any of the forms `paths[]`
/// accepts (`~/…`, `$HOME/…`, `/home/dev/…`, bare-relative); each is
/// normalized the same way and compared by suffix so `overrides: ["auth.json"]`
/// matches `/home/dev/.config/foo/auth.json` too (an explicit, named,
/// per-file opt-out — not a path-prefix escape hatch).
fn is_overridden(offender: &str, overrides: &[String]) -> bool {
    overrides.iter().any(|o| {
        let rel = rel_to_home(o).unwrap_or_else(|_| o.trim_start_matches('/').to_string());
        offender == format!("{HOME}/{rel}") || offender.ends_with(&format!("/{rel}"))
    })
}

/// Capture a live sandbox's declared path-sets: scan for secrets (failing
/// unless overridden), then squash (minus excludes) and `oras push`,
/// mirroring `build`'s push tail. Runs as `dev` — path ownership stays
/// consistent with how the tools were installed/used.
pub async fn capture(req: CaptureRequest) -> Result<BuildResult, String> {
    sweep_stage_scratch("capture").await;
    let mut rels = Vec::new();
    for p in &req.paths {
        let rel = rel_to_home(p)?;
        if std::path::Path::new(HOME).join(&rel).exists() {
            rels.push(rel);
        }
    }
    if rels.is_empty() {
        return Err("none of the declared capture paths exist in the home".into());
    }

    // Reject slash-bearing user excludes: rsync anchors a pattern containing
    // `/` to each path-set's transfer root (matches only there), whereas tar's
    // `--exclude` matched it at any depth. Silently applying rsync's rule
    // would let a `config/secrets`-style exclude quietly miss nested matches
    // and leak the very files it was meant to drop, so fail loudly instead
    // (the built-in DEFAULT_EXCLUDES are all slash-free basenames/globs).
    if let Some(bad) = req.exclude.iter().find(|e| e.contains('/')) {
        return Err(format!(
            "exclude '{bad}' contains '/': use a basename glob — slash-bearing \
             excludes are rejected because they would only match at a path-set's \
             root, silently missing nested matches"
        ));
    }

    let excludes = merged_excludes(&req.exclude);

    // Scan first (read-only), independent of the packing step (see
    // scan-secrets.sh): lists matching files, empty output is a clean pass.
    let scan_args = exclude_path_args(&[], &excludes, &rels);
    let scan = run_script(
        SCAN_SECRETS_SH,
        &scan_args,
        BUILD_TIMEOUT_MS,
        Some("dev"),
        &env_map(&[
            ("HOME_DIR", HOME),
            ("SECRET_PATTERN", &SECRET_PATTERNS.join("|")),
            ("SCAN_EXCLUDE_DIRS", &SCAN_EXCLUDE_DIRS.join("\n")),
        ]),
        true,
    )
    .await;
    if scan.exit_code != 0 {
        return Err(format!(
            "secret scan failed to run (exit {}): {}",
            scan.exit_code,
            scan.stderr.trim()
        ));
    }
    let offenders: Vec<String> = scan
        .stdout
        .lines()
        .filter(|l| !l.is_empty())
        .map(|rel| format!("{HOME}/{}", rel.trim_start_matches("./")))
        .filter(|abs| !is_overridden(abs, &req.overrides))
        .collect();
    if !offenders.is_empty() {
        return Err(format!(
            "secret scan blocked capture: {}; pass overrides to allow",
            offenders.join(", ")
        ));
    }

    let res = squash_and_push(&rels, &excludes, &req.target).await;
    if res.exit_code != 0 {
        return Err(format!(
            "toolset capture push failed (exit {}): {}",
            res.exit_code,
            res.stderr.trim()
        ));
    }
    digest_from_push(&res)
}

/// Extract the bare `<64 hex>` digest from a full pull reference
/// (`<registry>/toolsets/<name>@sha256:<hex>`) for use as the on-PVC blob's
/// filename — a stable, collision-free name keyed by content, independent of
/// `<name>` (two toolsets can't collide; the same digest pulled via two refs
/// correctly reuses one blob). The `sha256:` prefix is dropped so the blob
/// filename (`<hex>.<ext>`) has no `:` in it.
///
/// Hex-validated (reuses `valid_sha256`'s shape), not just prefix-stripped:
/// this string flows straight into root-run `mkdir`/`mv`/`mount` paths and
/// the overlay `lowerdir=` list (materialize), so a malformed or non-sha256
/// digest must hard-fail here rather than pass through as an unvalidated
/// path component (defense-in-depth — today every caller is upstream-
/// validated by `ToolsetRefSchema`, but this is the one place a bad value
/// would land in a filesystem path).
fn digest_suffix(reference: &str) -> Option<String> {
    let (_, token) = reference.rsplit_once('@')?;
    valid_sha256_hex(token)
}

/// Grace floor under which a root-run plumbing command is not even attempted
/// once the global materialize deadline (`BUILD_TIMEOUT_MS`, see
/// `materialize_inner`) is nearly exhausted — long enough for a local
/// mkdir/mount/find/rm, far too short for a fresh `oras pull` to have any
/// real chance of completing. Below this, `materialize_inner`/
/// `pull_blobs_concurrently` fail fast with a "pulled X of N" error instead
/// of burning the remainder of the budget on a doomed attempt.
const MIN_COMMAND_TIMEOUT_MS: u64 = 3_000;

/// Bounded fan-out for the concurrent `oras pull` phase (P2a) — caps how many
/// toolsets pull at once so a large toolset list doesn't open unbounded
/// registry connections; small enough to stay well under typical container
/// fd/conntrack limits, large enough that pulls are the common case that
/// actually overlaps.
const MAX_CONCURRENT_PULLS: usize = 4;

/// Remove pull scratch dirs left by a previous boot that was SIGKILLed
/// mid-pull (pull-blob.sh's EXIT trap is skipped on kill/VM death). Left
/// unswept they ride every pause snapshot and prebuild clone, and the stale
/// blob sweep never matches them. Safe: materialize is the single writer on
/// this PVC and runs before any mount. Best-effort.
async fn sweep_pull_scratch() {
    let Ok(mut dir) = tokio::fs::read_dir(DATA_TOOLSETS).await else {
        return;
    };
    while let Ok(Some(entry)) = dir.next_entry().await {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("atelier-toolset-pull.")
        {
            continue;
        }
        if let Err(e) = tokio::fs::remove_dir_all(entry.path()).await {
            eprintln!(
                "toolset materialize: pull-scratch cleanup of {} failed: {e}",
                entry.path().display()
            );
        }
    }
}

/// Milliseconds remaining until `deadline`, saturating at 0 — never negative,
/// never panics against an already-past deadline (C3's global materialize
/// budget: every root-run command in `materialize_inner` is timed off this
/// shrinking remainder instead of its own fresh `BUILD_TIMEOUT_MS`).
fn remaining_ms(deadline: std::time::Instant) -> u64 {
    deadline
        .saturating_duration_since(std::time::Instant::now())
        .as_millis() as u64
}

/// One deduplicated toolset pull target: a digest-pinned reference plus the
/// bare hex digest extracted from it (`digest_suffix`), carried together so
/// the pull/mount phases don't re-derive or re-validate it.
#[derive(Clone)]
struct PullEntry {
    digest: String,
    reference: String,
}

/// Ensure `entry`'s blob exists on the PVC, pulling it only if absent
/// (pull-blob.sh). No mount here — mounting is a fast, local, ordering-
/// sensitive step (`mount_blob`) done after every pull in the batch has
/// landed (see `pull_blobs_concurrently`). Non-login: root plumbing needs no
/// profile PATH and this runs once per toolset per boot.
async fn pull_blob(entry: &PullEntry, timeout_ms: u64) -> command::ExecResult {
    run_script(
        PULL_BLOB_SH,
        &[entry.digest.clone(), entry.reference.clone()],
        timeout_ms,
        None,
        &env_map(&[("TOOLSETS_DIR", DATA_TOOLSETS)]),
        false,
    )
    .await
}

/// Loop-mount (or, for a tarball blob, extract) `digest`'s blob read-only at
/// `mount_point` (mount-blob.sh).
async fn mount_blob(digest: &str, mount_point: &str, timeout_ms: u64) -> command::ExecResult {
    run_script(
        MOUNT_BLOB_SH,
        &[digest.to_string(), mount_point.to_string()],
        timeout_ms,
        None,
        &env_map(&[("TOOLSETS_DIR", DATA_TOOLSETS)]),
        false,
    )
    .await
}

/// Pull every entry's blob with bounded concurrency (P2a). Independent per
/// digest (own scratch dir, own existence check, own final blob path), so
/// fetching several at once is safe — unlike the loop-mount + final overlay
/// assembly that follows in `materialize_inner`, which must stay sequential/
/// ordered for correct lowerdir priority (mounting is fast and local; pulling
/// is the network-bound step this actually helps). Shares `deadline` (C3's
/// global materialize budget) with the rest of `materialize_inner`: each
/// task's timeout is whatever remains of the budget when it actually starts
/// running (not reserved up front — a task queued behind the concurrency cap
/// naturally gets less), and a task that finds the budget already exhausted
/// fails without attempting the pull. On any failure, returns a single error
/// naming how many of the N toolsets DID complete (not which — with
/// concurrent tasks "first N in request order" is no longer meaningful) so
/// the caller gets the same "pulled X of N" shape C3 asks for.
async fn pull_blobs_concurrently(
    entries: &[PullEntry],
    deadline: std::time::Instant,
) -> Result<(), String> {
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PULLS));
    let mut set = tokio::task::JoinSet::new();
    for entry in entries.iter().cloned() {
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.expect("toolset pull semaphore");
            let timeout = remaining_ms(deadline);
            if timeout < MIN_COMMAND_TIMEOUT_MS {
                return Err(format!(
                    "materialize budget exhausted before pulling {}",
                    entry.reference
                ));
            }
            let res = pull_blob(&entry, timeout).await;
            if res.exit_code != 0 {
                return Err(format!(
                    "toolset pull failed for {} (exit {}): {}",
                    entry.reference,
                    res.exit_code,
                    res.stderr.trim()
                ));
            }
            Ok(())
        });
    }

    let total = entries.len();
    let mut ok_count = 0usize;
    let mut first_err: Option<String> = None;
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok(())) => ok_count += 1,
            Ok(Err(e)) => {
                first_err.get_or_insert(e);
            }
            Err(join_err) => {
                first_err.get_or_insert(format!("toolset pull task panicked: {join_err}"));
            }
        }
    }
    match first_err {
        Some(e) => Err(format!("pulled {ok_count} of {total} toolsets: {e}")),
        None => Ok(()),
    }
}

/// Materialize toolset artifacts into the home as a **mount, not a copy**
/// (docs/proposals/toolset-overlay-squashfs.md §5). Digest-pinned refs are
/// deduplicated, then pulled to `/data/toolsets/<digest>.<ext>` (`.erofs`,
/// `.sqfs`, or `.tzst`, whichever format the builder used — the last is a
/// zstd tarball, extracted into a plain lowerdir instead of loop-mounted, for
/// a guest kernel that can mount neither read-only FS) with bounded
/// concurrency (P2a — independent per digest; skipped per-blob if already
/// present, idempotent across create/resume/retry, and what makes resume
/// registry-independent: the blob rides the PVC's pause snapshot). Once every
/// blob has landed, each is loop-mounted read-only at `/run/toolsets/<digest>`
/// **in request order** (mounting is fast/local — no benefit to
/// parallelizing it, and doing it in order keeps the code simple even though
/// mount order itself doesn't affect the result). Then `/home/dev` is
/// assembled as a **single** overlay stacking every lower — **later refs
/// win** (leftmost lowerdir = highest priority in overlayfs), floored by the
/// image's `/home/skel`, with `/data/{upper,work}` as the writable layer.
/// Called with an empty `req.toolsets` too (every boot, per `boot.ts`): that
/// degrades to a skel-only overlay, which is what makes `/home/dev` usable at
/// all — the entrypoint (`sandbox-boot.sh`) does NOT mount it; this call is
/// the only place `/home/dev` is ever assembled.
///
/// **C3 — global budget**: a single deadline (`BUILD_TIMEOUT_MS` from now) is
/// computed once at the top and shared by every command this function runs
/// (`remaining_ms`) — the pull-scratch cleanup, every pull (via
/// `pull_blobs_concurrently`), every mount, the overlay assembly, and the
/// final blob sweep all draw from the SAME shrinking budget instead of each
/// getting its own fresh `BUILD_TIMEOUT_MS`. For a single toolset this is
/// indistinguishable from the old per-command-timeout behavior (nothing else
/// competes for the budget); for N>1 it caps total wall time at
/// `BUILD_TIMEOUT_MS` instead of up to N×`BUILD_TIMEOUT_MS`, matching the
/// fixed ceilings `agent.client.ts`'s `materializeToolsets` and
/// `sandbox-boot.sh`'s wait loop already enforce on the other two layers.
/// Exhausting the budget mid-pull fails fast with "pulled X of N toolsets";
/// the cheap post-pull steps (mount/assembly/sweep) still run with whatever
/// remains (floored at `MIN_COMMAND_TIMEOUT_MS` so they're not starved to
/// zero by a budget that ran out exactly at the pull/mount boundary).
///
/// On success, writes `/run/home-ready` as the last step — the entrypoint's
/// signal to stop waiting and start sshd. This is the race-free handshake:
/// nothing touches `/home/dev` (no sshd, no session) until this function has
/// fully assembled it exactly once, so there is never a prior mount to tear
/// down and the `umount` this function performs is expected to be a no-op on
/// every normal boot (only a defensive measure for an agent retry within the
/// same pod — see the `mountpoint -q` guard below, which makes a genuine
/// absence of a prior mount a no-op rather than a swallowed failure).
///
/// Runs as **root** (`user: None`): mounting needs `CAP_SYS_ADMIN`, which the
/// container process gets from the pod's `securityContext.capabilities`
/// (`kube.resources.ts` — uid 0 alone has only the default OCI capset, which
/// excludes it), plus the `/dev/loop*` nodes the entrypoint creates. Unlike
/// `build`/`capture`, which run as `dev`. Every root-run script here uses
/// `command::run_with_login(..., false)` (P2c): pure mkdir/mount/find/rm
/// plumbing needs no `/etc/profile`/`profile.d` sourcing, which a login shell
/// would otherwise pay on every one of these calls (`readiness.rs`'s
/// `probe_cmd` set this precedent). Fail-fast: a bad pull/mount aborts
/// assembly; the wrapper (`materialize`) writes `/run/home-failed` so the
/// entrypoint stops waiting and starts sshd onto the degraded home for
/// diagnosis.
async fn materialize_inner(req: &MaterializeRequest) -> Result<MaterializeResult, String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(BUILD_TIMEOUT_MS);

    // Sweep any leftover pull scratch dirs from a previous boot that was
    // SIGKILLed mid-pull (the EXIT trap is skipped on kill/VM-death) — left
    // unswept they ride every pause snapshot and prebuild clone, and the
    // blob sweep below (`*.erofs`/`*.sqfs` only) never matches them. Safe:
    // materialize is the single writer on this PVC and runs before any mount.
    sweep_pull_scratch().await;

    // Dedupe by digest, preserving `req.toolsets`' order: the same ref listed
    // twice would otherwise push the same mount point into `lowerdir=X:X:…`,
    // which overlayfs rejects on some kernels. Identical content ⇒ priority
    // position is irrelevant, so keep the first occurrence.
    let mut entries: Vec<PullEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for reference in &req.toolsets {
        let digest = digest_suffix(reference).ok_or_else(|| {
            format!("toolset reference '{reference}' is missing a valid @sha256:<64 hex> digest")
        })?;
        if !seen.insert(digest.clone()) {
            continue;
        }
        entries.push(PullEntry {
            digest,
            reference: reference.clone(),
        });
    }

    // P2a: fetch every blob concurrently (bounded), sharing the global
    // deadline. Mounting happens after, sequentially, once every blob is on
    // the PVC.
    pull_blobs_concurrently(&entries, deadline).await?;

    let mut mounts: Vec<String> = Vec::new();
    let mut keep_digests: Vec<String> = Vec::new();
    for entry in &entries {
        let mount_point = format!("{RUN_TOOLSETS}/{}", entry.digest);
        let timeout = remaining_ms(deadline);
        if timeout < MIN_COMMAND_TIMEOUT_MS {
            return Err(format!(
                "materialize budget exhausted: mounted {} of {} toolsets",
                mounts.len(),
                entries.len()
            ));
        }
        let res = mount_blob(&entry.digest, &mount_point, timeout).await;
        if res.exit_code != 0 {
            return Err(format!(
                "toolset mount failed for {} (exit {}): {}",
                entry.reference,
                res.exit_code,
                res.stderr.trim()
            ));
        }
        mounts.push(mount_point);
        keep_digests.push(entry.digest.clone());
    }

    // Later refs win: `req.toolsets` is ordered lowest-to-highest priority
    // (same rule as `files[]`), and overlayfs treats the FIRST lowerdir as
    // highest priority — so the mount list is reversed before joining.
    let mut lowerdir_parts: Vec<String> = mounts.into_iter().rev().collect();
    lowerdir_parts.push(SKEL.to_string());
    let lowerdir = lowerdir_parts.join(":");

    // Single overlay assembly (assemble-home.sh); writes the ready marker.
    let res = run_script(
        ASSEMBLE_HOME_SH,
        &[lowerdir],
        remaining_ms(deadline).max(MIN_COMMAND_TIMEOUT_MS),
        None,
        &env_map(&[
            ("HOME_DIR", HOME),
            ("OVERLAY_UPPER", DATA_UPPER),
            ("OVERLAY_WORK", DATA_WORK),
            ("OVERLAY_OPTS", OVERLAY_MOUNT_OPTS),
            ("READY_MARKER", HOME_READY_MARKER),
            ("FAILED_MARKER", HOME_FAILED_MARKER),
        ]),
        false,
    )
    .await;
    if res.exit_code != 0 {
        return Err(format!(
            "overlay assembly failed (exit {}): {}",
            res.exit_code,
            res.stderr.trim()
        ));
    }

    // Sweep stale blobs (sweep-stale-blobs.sh) — only after a successful
    // assembly (a failed boot must never delete a blob it might still need on
    // retry). Anything not in this boot's keep-set is left over from a
    // previous toolset selection and would ride every pause snapshot and
    // prebuild clone forever.
    let sweep = run_script(
        SWEEP_STALE_BLOBS_SH,
        &keep_digests,
        remaining_ms(deadline).max(MIN_COMMAND_TIMEOUT_MS),
        None,
        &env_map(&[("TOOLSETS_DIR", DATA_TOOLSETS)]),
        false,
    )
    .await;
    if sweep.exit_code != 0 {
        // Best-effort: a failed sweep leaves disk usage slightly higher, not
        // a broken boot — don't fail materialize over cleanup.
        eprintln!(
            "toolset materialize: stale blob sweep failed (exit {}): {}",
            sweep.exit_code,
            sweep.stderr.trim()
        );
    }

    Ok(MaterializeResult {
        materialized: req.toolsets.len(),
    })
}

/// Assemble `/home/dev` (see `materialize_inner`), serialized and idempotent.
/// The lock plus the HOME_READY_MARKER early-return make a duplicate or
/// concurrent call (a restart self-heal racing the runtime's own call) a safe
/// no-op rather than a second `umount`/remount of a live overlay. On failure
/// it writes HOME_FAILED_MARKER so the entrypoint stops waiting; on success it
/// persists the selection for `self_heal_home`.
pub async fn materialize(req: MaterializeRequest) -> Result<MaterializeResult, String> {
    let _guard = materialize_lock().lock().await;
    // Already assembled this container life — nothing to redo. (A failed prior
    // attempt leaves no marker, so a retry still proceeds below.)
    if home_ready_marker_exists().await {
        return Ok(MaterializeResult {
            materialized: req.toolsets.len(),
        });
    }
    match materialize_inner(&req).await {
        Ok(result) => {
            persist_materialize_request(&req.toolsets).await;
            Ok(result)
        }
        Err(e) => {
            // Unblock the entrypoint's wait so it starts sshd for diagnosis
            // instead of burning the full pull budget on a doomed boot.
            let _ = tokio::fs::write(HOME_FAILED_MARKER, b"").await;
            Err(e)
        }
    }
}

/// `HOME_READY_MARKER`'s presence, via `tokio::fs` (P2d) rather than the
/// blocking `std::path::Path::exists` — this is polled from `self_heal_home`'s
/// loop and checked in `materialize`, both async fns running on tokio
/// workers; a blocking `stat(2)` against the virtio-fs-backed home is exactly
/// the stall this design flags as risky (doc comment at the top of this
/// file).
async fn home_ready_marker_exists() -> bool {
    tokio::fs::try_exists(HOME_READY_MARKER)
        .await
        .unwrap_or(false)
}

/// Persist the assembled toolset selection to the PVC (atomic write+rename) so
/// `self_heal_home` can rebuild the overlay after a kubelet restart without
/// the runtime. Best-effort: a failed write only degrades restart recovery.
/// `tokio::fs` (P2d) instead of blocking `std::fs`: `write`/`rename` still
/// end up on a blocking-pool thread either way, but going through `tokio::fs`
/// keeps this async fn from ever blocking its own worker thread directly.
/// `rename(2)` is atomic regardless of which pool runs the syscall, so the
/// write-then-rename durability guarantee is unchanged.
async fn persist_materialize_request(toolsets: &[String]) {
    let Ok(bytes) = serde_json::to_vec(toolsets) else {
        return;
    };
    let tmp = format!("{MATERIALIZE_REQUEST_PATH}.tmp");
    let persisted = tokio::fs::write(&tmp, &bytes).await.is_ok()
        && tokio::fs::rename(&tmp, MATERIALIZE_REQUEST_PATH)
            .await
            .is_ok();
    if !persisted {
        eprintln!(
            "toolset: failed to persist materialize request; self-heal after a restart may no-op"
        );
    }
}

/// Re-assemble `/home/dev` after a whole-container (kubelet) restart. A fresh
/// container has an empty `/run` (no HOME_READY_MARKER) and a fresh mount
/// namespace (no overlay), but `/data` still holds the blobs and the persisted
/// selection. The runtime does NOT re-drive materialize on a bare container
/// restart, so without this the entrypoint would eventually start sshd on the
/// un-assembled rootfs home and silently divorce writes from the PVC.
///
/// Fires ONLY on a kubelet restart: on a first-ever boot there is no persisted
/// request (returns immediately), and on a runtime-driven create/resume the
/// runtime's own materialize call writes HOME_READY_MARKER within the grace
/// window — so this observes the marker and no-ops (also correct when a resume
/// changed the selection: the runtime's call, not this stale snapshot, wins).
pub async fn self_heal_home() {
    let Ok(bytes) = tokio::fs::read(MATERIALIZE_REQUEST_PATH).await else {
        return; // first-ever boot: nothing to recover
    };
    if home_ready_marker_exists().await {
        return;
    }
    let toolsets: Vec<String> = match serde_json::from_slice(&bytes) {
        Ok(t) => t,
        Err(_) => return,
    };
    // Let the runtime drive materialize itself (the normal path); only step in
    // if it never does within the window (the kubelet-restart case).
    let start = std::time::Instant::now();
    while start.elapsed().as_millis() < SELF_HEAL_GRACE_MS {
        if home_ready_marker_exists().await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    if home_ready_marker_exists().await {
        return;
    }
    eprintln!(
        "toolset: /home/dev not assembled {}ms after restart; self-healing from persisted selection",
        SELF_HEAL_GRACE_MS
    );
    if let Err(e) = materialize(MaterializeRequest { toolsets }).await {
        eprintln!("toolset: self-heal materialize failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remaining_ms_saturates_at_zero_past_deadline() {
        let past = std::time::Instant::now() - std::time::Duration::from_secs(1);
        assert_eq!(remaining_ms(past), 0);
        let future = std::time::Instant::now() + std::time::Duration::from_secs(60);
        // Allow scheduling jitter: should be close to but not over 60_000ms.
        let r = remaining_ms(future);
        assert!(r > 0 && r <= 60_000, "remaining_ms out of range: {r}");
    }

    #[test]
    fn overlay_mount_opts_use_trusted_xattrs_not_userxattr() {
        // Option C: the upper is native ext4 on virtio-blk, so overlay must use
        // real trusted.overlay.* (redirect_dir=on) and NEVER userxattr — which
        // would force redirect_dir=nofollow and re-break in-place `pi update`.
        assert!(OVERLAY_MOUNT_OPTS.contains("redirect_dir=on"));
        assert!(!OVERLAY_MOUNT_OPTS.contains("userxattr"));
        // index/metacopy stay off (squashfs lowers are -no-exports; metacopy
        // drags in origin-xattr paths we don't need).
        assert!(OVERLAY_MOUNT_OPTS.contains("index=off"));
        assert!(OVERLAY_MOUNT_OPTS.contains("metacopy=off"));
    }

    #[test]
    fn blob_format_mount_type_matches_extension_case_in_materialize() {
        // The materialize shell maps *.erofs->erofs, *.sqfs->squashfs, and
        // extracts *.tzst; keep the enum in lockstep with that mapping and the
        // pushed media types.
        assert_eq!(BlobFormat::Erofs.ext(), "erofs");
        assert_eq!(BlobFormat::Erofs.fs_type(), Some("erofs"));
        assert_eq!(BlobFormat::Squashfs.ext(), "sqfs");
        assert_eq!(BlobFormat::Squashfs.fs_type(), Some("squashfs"));
        // Tar is extracted, not mounted: no mount fs type, and its extension is
        // a single token so `<digest>.*` + `${blob##*.}` recovery still works.
        assert_eq!(BlobFormat::Tar.ext(), "tzst");
        assert_eq!(BlobFormat::Tar.fs_type(), None);
        assert!(BlobFormat::Erofs.media_type().ends_with(".erofs"));
        assert!(BlobFormat::Squashfs.media_type().ends_with(".squashfs"));
        assert!(BlobFormat::Tar.media_type().ends_with(".tar+zstd"));
        // erofs is preferred when a kernel supports both mountable formats.
        assert_eq!(BlobFormat::PREFERENCE[0], BlobFormat::Erofs);
    }

    #[test]
    fn blob_format_names_match_the_packer_switch_in_squash_and_push() {
        // squash-and-push.sh switches on exactly these values.
        for (fmt, name) in [
            (BlobFormat::Erofs, "erofs"),
            (BlobFormat::Squashfs, "squashfs"),
            (BlobFormat::Tar, "tar"),
        ] {
            assert_eq!(fmt.name(), name);
            assert!(
                SQUASH_AND_PUSH_SH.contains(&format!("\n{name})\n")),
                "squash-and-push.sh has no `{name})` case"
            );
        }
    }

    #[test]
    fn exclude_path_args_counts_excludes_so_the_lists_split_cleanly() {
        let args = exclude_path_args(
            &["target".to_string()],
            &["*.pem".to_string(), ".env".to_string()],
            &[".config/pi".to_string()],
        );
        assert_eq!(args, ["target", "2", "*.pem", ".env", ".config/pi"]);
        // No excludes: just the zero count, then paths.
        let args = exclude_path_args(&[], &[], &["a".to_string(), "b".to_string()]);
        assert_eq!(args, ["0", "a", "b"]);
    }

    #[test]
    fn select_build_format_falls_back_to_tar_when_no_mountable_fs() {
        // erofs preferred when present.
        assert_eq!(
            select_build_format(|fs| fs == "erofs" || fs == "ext4"),
            BlobFormat::Erofs
        );
        // squashfs when erofs absent.
        assert_eq!(
            select_build_format(|fs| fs == "squashfs"),
            BlobFormat::Squashfs
        );
        // neither mountable RO fs -> tar (no hard-error). This is the copy
        // fallback the whole rung exists for.
        assert_eq!(select_build_format(|_| false), BlobFormat::Tar);
        assert_eq!(
            select_build_format(|fs| fs == "ext4" || fs == "overlay"),
            BlobFormat::Tar
        );
    }

    #[test]
    fn rel_to_home_normalizes_prefixes() {
        assert_eq!(rel_to_home("~/.config/pi").unwrap(), ".config/pi");
        assert_eq!(rel_to_home("$HOME/.local/bin").unwrap(), ".local/bin");
        assert_eq!(rel_to_home("/home/dev/.claude").unwrap(), ".claude");
        assert_eq!(rel_to_home(".local/share/pi/").unwrap(), ".local/share/pi");
    }

    #[test]
    fn rel_to_home_rejects_escapes() {
        assert!(rel_to_home("/etc/passwd").is_err());
        assert!(rel_to_home("~/../root").is_err());
        assert!(rel_to_home("~").is_err());
        assert!(rel_to_home("/home/dev").is_err());
        // Whole-home aliases must all be refused.
        assert!(rel_to_home("~/.").is_err());
        assert!(rel_to_home("./").is_err());
        assert!(rel_to_home(".").is_err());
        assert!(rel_to_home("/home/dev/.").is_err());
    }

    #[test]
    fn parse_digest_finds_manifest_sha() {
        let out = "Uploading 46bc684ddba9 layer.sqfs\nPushed [registry] \
                   zot.zot.svc:5000/toolsets/x:t\nArtifactType: \
                   application/vnd.atelier.toolset.v1\nDigest: \
                   sha256:48f338c9fd3283dfc27a52c58bb5e8a3fe621e74e124666181da40ef59fe047a\n";
        assert_eq!(
            parse_digest(out).unwrap(),
            "sha256:48f338c9fd3283dfc27a52c58bb5e8a3fe621e74e124666181da40ef59fe047a"
        );
    }

    #[test]
    fn parse_digest_none_when_absent() {
        assert!(parse_digest("no digest here").is_none());
    }

    #[test]
    fn parse_digest_rejects_malformed_and_normalizes_case() {
        // 63 hex (too short), 65 (too long), and a non-hex char all reject.
        assert!(valid_sha256(&format!("sha256:{}", "a".repeat(63))).is_none());
        assert!(valid_sha256(&format!("sha256:{}", "a".repeat(65))).is_none());
        assert!(valid_sha256(&format!("sha256:{}g", "a".repeat(63))).is_none());
        // Uppercase hex is normalized to lowercase (ToolsetRefSchema pins [0-9a-f]).
        let upper = format!("sha256:{}", "A".repeat(64));
        assert_eq!(
            valid_sha256(&upper).unwrap(),
            format!("sha256:{}", "a".repeat(64))
        );
    }

    #[test]
    fn parse_digest_prefers_the_manifest_label_over_earlier_tokens() {
        let layer = "a".repeat(64);
        let manifest = "b".repeat(64);
        let out = format!("Uploaded sha256:{layer} layer\nDigest: sha256:{manifest}\n");
        assert_eq!(parse_digest(&out).unwrap(), format!("sha256:{manifest}"));
    }

    #[test]
    fn merged_excludes_covers_every_default() {
        let merged = merged_excludes(&[]);
        for d in DEFAULT_EXCLUDES {
            assert!(merged.iter().any(|g| g == d), "missing default exclude {d}");
        }
    }

    #[test]
    fn node_modules_is_scan_excluded_but_still_captured() {
        // The scan skips node_modules (vendored deps trip patterns on example
        // keys, e.g. AWS's AKIAIOSFODNN7EXAMPLE) …
        assert!(SCAN_EXCLUDE_DIRS.contains(&"node_modules"));
        assert!(SCAN_EXCLUDE_DIRS.contains(&".git"));
        // … but it must NOT be a pack exclude, or an npm toolset would ship
        // without its dependencies.
        assert!(!merged_excludes(&[]).iter().any(|g| g == "node_modules"));
    }

    #[test]
    fn merged_excludes_includes_defaults_and_request() {
        let merged = merged_excludes(&["custom-secret.json".to_string()]);
        assert!(merged.iter().any(|g| g == "auth.json"));
        assert!(merged.iter().any(|g| g == ".env"));
        assert!(merged.iter().any(|g| g == "custom-secret.json"));
    }

    #[test]
    fn merged_excludes_dedupes_in_order() {
        let merged = merged_excludes(&["auth.json".to_string(), "mine".to_string()]);
        assert_eq!(merged.iter().filter(|g| *g == "auth.json").count(), 1);
        assert_eq!(merged.last().map(String::as_str), Some("mine"));
    }

    #[test]
    fn digest_suffix_extracts_the_bare_hex_digest() {
        let hex = "a".repeat(64);
        assert_eq!(
            digest_suffix(&format!("zot.zot.svc:5000/toolsets/pi-base@sha256:{hex}")),
            Some(hex.clone())
        );
        // Uppercase hex is normalized to lowercase, mirroring `valid_sha256`.
        assert_eq!(
            digest_suffix(&format!(
                "zot.zot.svc:5000/toolsets/pi-base@sha256:{}",
                hex.to_ascii_uppercase()
            )),
            Some(hex)
        );
    }

    #[test]
    fn digest_suffix_rejects_missing_or_malformed_digests() {
        // No `@` at all (a bare tag ref).
        assert!(digest_suffix("zot.zot.svc:5000/toolsets/pi-base:latest").is_none());
        // Too-short hex, non-hex char, and a non-sha256 algorithm all reject —
        // this string flows straight into root-run mkdir/mv/mount paths, so a
        // malformed digest must hard-fail rather than pass through unchecked.
        assert!(digest_suffix("zot.zot.svc:5000/toolsets/pi-base@sha256:abc123").is_none());
        assert!(
            digest_suffix(&format!(
                "zot.zot.svc:5000/toolsets/pi-base@sha256:{}g",
                "a".repeat(63)
            ))
            .is_none()
        );
        assert!(
            digest_suffix(&format!(
                "zot.zot.svc:5000/toolsets/pi-base@sha512:{}",
                "a".repeat(128)
            ))
            .is_none()
        );
    }

    #[test]
    fn is_overridden_matches_by_suffix_across_forms() {
        let overrides = vec!["auth.json".to_string()];
        assert!(is_overridden(
            "/home/dev/.config/opencode/auth.json",
            &overrides
        ));
        assert!(is_overridden("/home/dev/auth.json", &overrides));
        assert!(!is_overridden(
            "/home/dev/.config/opencode/config.json",
            &overrides
        ));
    }

    #[test]
    fn is_overridden_accepts_home_relative_override_forms() {
        let overrides = vec!["~/.config/pi/auth.json".to_string()];
        assert!(is_overridden("/home/dev/.config/pi/auth.json", &overrides));
        assert!(!is_overridden(
            "/home/dev/.config/other/auth.json",
            &overrides
        ));
    }

    #[test]
    fn is_overridden_false_when_no_overrides() {
        assert!(!is_overridden("/home/dev/.env", &[]));
    }

    const ALL_SCRIPTS: [(&str, &str); 7] = [
        ("sweep-stage-scratch.sh", SWEEP_STAGE_SCRATCH_SH),
        ("squash-and-push.sh", SQUASH_AND_PUSH_SH),
        ("scan-secrets.sh", SCAN_SECRETS_SH),
        ("pull-blob.sh", PULL_BLOB_SH),
        ("mount-blob.sh", MOUNT_BLOB_SH),
        ("assemble-home.sh", ASSEMBLE_HOME_SH),
        ("sweep-stale-blobs.sh", SWEEP_STALE_BLOBS_SH),
    ];

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("atelier-toolset-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn every_embedded_script_parses() {
        // A syntax slip would otherwise only surface on a real boot. (CI also
        // runs `shellcheck -s bash apps/agent/scripts/*.sh` where available.)
        let dir = scratch("syntax");
        for (name, body) in ALL_SCRIPTS {
            let path = dir.join(name);
            std::fs::write(&path, body).unwrap();
            let res = run_script(
                "bash -n \"$1\"",
                &[path.to_string_lossy().into_owned()],
                10_000,
                None,
                &HashMap::new(),
                false,
            )
            .await;
            assert_eq!(res.exit_code, 0, "{name}: {}", res.stderr);
        }
    }

    #[tokio::test]
    async fn sweep_stale_blobs_keeps_only_listed_digests_in_any_format() {
        let dir = scratch("sweep");
        let (keep, drop_a, drop_b) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
        for f in [
            format!("{keep}.sqfs"),
            format!("{drop_a}.erofs"),
            format!("{drop_b}.tzst"),
            ".materialize.json".to_string(),
        ] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let env = env_map(&[("TOOLSETS_DIR", dir.to_str().unwrap())]);
        let res = run_script(
            SWEEP_STALE_BLOBS_SH,
            std::slice::from_ref(&keep),
            10_000,
            None,
            &env,
            false,
        )
        .await;
        assert_eq!(res.exit_code, 0, "{}", res.stderr);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(
            left,
            [".materialize.json".to_string(), format!("{keep}.sqfs")]
        );

        // No keep list: every blob goes, the non-blob state file stays.
        let res = run_script(SWEEP_STALE_BLOBS_SH, &[], 10_000, None, &env, false).await;
        assert_eq!(res.exit_code, 0, "{}", res.stderr);
        assert!(!dir.join(format!("{keep}.sqfs")).exists());
        assert!(dir.join(".materialize.json").exists());
    }

    #[tokio::test]
    async fn pull_blob_skips_the_pull_when_the_blob_is_already_there() {
        // No `oras` involved: an existing `<digest>.*` short-circuits.
        let dir = scratch("pull-skip");
        let digest = "d".repeat(64);
        std::fs::write(dir.join(format!("{digest}.erofs")), b"blob").unwrap();
        let env = env_map(&[("TOOLSETS_DIR", dir.to_str().unwrap())]);
        let args = [digest.clone(), "never-pulled/x@sha256:0".to_string()];
        let res = run_script(PULL_BLOB_SH, &args, 10_000, None, &env, false).await;
        assert_eq!(res.exit_code, 0, "{}", res.stderr);
    }

    #[tokio::test]
    async fn mount_blob_fails_clearly_when_the_blob_is_missing() {
        let dir = scratch("mount-missing");
        let mount = dir.join("mnt");
        let env = env_map(&[("TOOLSETS_DIR", dir.to_str().unwrap())]);
        let args = ["e".repeat(64), mount.to_string_lossy().into_owned()];
        let res = run_script(MOUNT_BLOB_SH, &args, 10_000, None, &env, false).await;
        assert_ne!(res.exit_code, 0);
        assert!(res.stderr.contains("missing after pull"), "{}", res.stderr);
    }

    #[tokio::test]
    async fn scan_secrets_reports_matches_and_honours_excludes() {
        let home = scratch("scan");
        std::fs::create_dir_all(home.join(".config/x")).unwrap();
        std::fs::create_dir_all(home.join(".config/node_modules/m")).unwrap();
        let key = format!("ghp_{}", "A".repeat(36));
        std::fs::write(home.join(".config/x/leak.txt"), &key).unwrap();
        std::fs::write(home.join(".config/x/skipped.pem"), &key).unwrap();
        std::fs::write(home.join(".config/node_modules/m/vendored.js"), &key).unwrap();
        std::fs::write(home.join(".config/x/clean.txt"), "nothing here").unwrap();
        let env = env_map(&[
            ("HOME_DIR", home.to_str().unwrap()),
            ("SECRET_PATTERN", &SECRET_PATTERNS.join("|")),
            ("SCAN_EXCLUDE_DIRS", &SCAN_EXCLUDE_DIRS.join("\n")),
        ]);
        let args = exclude_path_args(&[], &["*.pem".to_string()], &[".config".to_string()]);
        let res = run_script(SCAN_SECRETS_SH, &args, 10_000, None, &env, false).await;
        assert_eq!(res.exit_code, 0, "{}", res.stderr);
        assert_eq!(res.stdout.trim(), ".config/x/leak.txt");

        // A clean tree is an empty, successful scan.
        let args = exclude_path_args(&[], &[], &[".config/x/clean.txt".to_string()]);
        let res = run_script(SCAN_SECRETS_SH, &args, 10_000, None, &env, false).await;
        assert_eq!(res.exit_code, 0, "{}", res.stderr);
        assert_eq!(res.stdout.trim(), "");
    }
}
