//! Toolset artifact build/push (composed-prebuild-volumes.md §2). The agent
//! tars declared home path-sets and pushes them as an OCI artifact to the
//! in-cluster registry by shelling out to the baked `oras` CLI + `tar`. The
//! agent links NO OCI/HTTP/tar library — it stays lean and orchestrates the
//! tools already present in the image (the runtime never proxies the bytes).

use serde::{Deserialize, Serialize};

use crate::command::{self, MAX_COMMAND_OUTPUT_BYTES};

const HOME: &str = "/home/dev";
const ARTIFACT_TYPE: &str = "application/vnd.atelier.toolset.v1+tar";
const LAYER_TYPE: &str = "application/vnd.atelier.toolset.layer.v1.tar+gzip";
const TARBALL_DIR: &str = "/tmp";
/// Build/push can move hundreds of MB; give it well past the exec default.
const BUILD_TIMEOUT_MS: u64 = 600_000;

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
/// time) — the mechanism is path-set selection: tar exactly `paths` MINUS
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
    r"AKIA[0-9A-Z]{16}",                    // AWS access key id
    r"ghp_[A-Za-z0-9]{36}",                 // GitHub personal access token
    r"github_pat_[A-Za-z0-9_]{22,}",        // GitHub fine-grained PAT
    r"xox[baprs]-[A-Za-z0-9-]{10,}",        // Slack token
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----",  // PEM private key
    r"sk-[A-Za-z0-9]{20,}",                 // OpenAI/Anthropic-style secret key
    r"sk_(live|test)_[A-Za-z0-9]{16,}",     // Stripe secret key
    r"npm_[A-Za-z0-9]{36}",                 // npm access token
    r"hf_[A-Za-z0-9]{20,}",                 // Hugging Face token
    r"AIza[0-9A-Za-z_-]{35}",               // Google API key
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

/// POSIX single-quote a shell argument.
fn sh_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// A `sha256:<64 lowercase-hex>` digest token, or `None`. Normalizes case:
/// `ToolsetRefSchema` pins `[0-9a-f]`, but oras/registries may echo mixed hex.
fn valid_sha256(token: &str) -> Option<String> {
    let hex = token.strip_prefix("sha256:")?;
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| format!("sha256:{}", hex.to_ascii_lowercase()))
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

/// Tar the existing declared path-sets and `oras push` them to `target`,
/// returning the pushed digest. Missing path-sets are skipped (a build step
/// may legitimately produce a subset); an empty result is an error.
pub async fn build(req: BuildRequest) -> Result<BuildResult, String> {
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

    let quoted_paths = rels.iter().map(|r| sh_quote(r)).collect::<Vec<_>>().join(" ");
    // Apply the same secret-file/`.git` exclude floor as `capture` — a built
    // toolset's declared paths can contain a `.git` dir or stray dotfile too.
    let tar_excludes = tar_exclude_flags(&merged_excludes(&[]));
    // `oras push` refuses an absolute tarball path ("absolute file path
    // detected" — its default traversal guard), so `cd` into the tarball's
    // directory first and reference it by bare filename. `mktemp` keeps the
    // name unique so concurrent pushes never clobber each other's tarball; the
    // `trap` removes it on any exit path (`set -e` would otherwise skip a
    // trailing `rm` when `oras push` fails).
    let script = format!(
        "set -euo pipefail\n\
         cd {dir}\n\
         name=$(mktemp atelier-toolset.XXXXXX.tar.gz)\n\
         trap 'rm -f \"$name\"' EXIT\n\
         tar -czf \"$name\"{tar_excludes} -C {home} {paths}\n\
         oras push --plain-http {target} \
           --artifact-type {at} \"$name\":{lt}",
        dir = TARBALL_DIR,
        tar_excludes = tar_excludes,
        home = HOME,
        paths = quoted_paths,
        target = sh_quote(&req.target),
        at = ARTIFACT_TYPE,
        lt = LAYER_TYPE,
    );

    // Run as `dev` so the tarball's ownership/readability matches how the
    // build steps installed the files (consistent with `capture`).
    let res = command::run(
        &script,
        BUILD_TIMEOUT_MS,
        Some("dev"),
        None,
        &std::collections::HashMap::new(),
        MAX_COMMAND_OUTPUT_BYTES,
    )
    .await;
    if res.exit_code != 0 {
        return Err(format!(
            "toolset push failed (exit {}): {}",
            res.exit_code,
            res.stderr.trim()
        ));
    }
    digest_from_push(&res)
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

/// Build the `tar --exclude=<glob>` flags for a merged (default + request)
/// exclude list, deduplicated and shell-quoted. A bare glob (no `/`) already
/// matches at every path depth — tar's `--exclude` matches path components,
/// not just basenames — so one `--exclude=<glob>` per glob covers both
/// top-level and nested files.
fn tar_exclude_flags(excludes: &[String]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut flags = String::new();
    for glob in excludes {
        if !seen.insert(glob.clone()) {
            continue;
        }
        flags.push_str(&format!(" --exclude={}", sh_quote(glob)));
    }
    flags
}

/// Directories skipped by the secret SCAN only — still captured into the tar
/// (a toolset that installs npm tools NEEDS its `node_modules`). `.git` holds
/// no user config; `node_modules` is vendored third-party code — never where a
/// capturing user's own credentials live, but riddled with example keys (e.g.
/// AWS's documented `AKIAIOSFODNN7EXAMPLE` in `@aws-sdk` JSDoc `.d.ts` files)
/// and test fixtures. Scanning them only produces false positives that train
/// devs to reach for `overrides` reflexively, defeating the gate (see
/// SECRET_PATTERNS).
const SCAN_EXCLUDE_DIRS: &[&str] = &[".git", "node_modules"];

/// `grep --exclude-dir=<dir>` flags for the scan-only directory excludes.
fn scan_exclude_dir_flags() -> String {
    SCAN_EXCLUDE_DIRS
        .iter()
        .map(|d| format!(" --exclude-dir={}", sh_quote(d)))
        .collect()
}

/// Merge the built-in secret-file excludes with the request's own, as owned
/// `String`s ready for `tar_exclude_flags` / grep-exclude construction.
fn merged_excludes(request_exclude: &[String]) -> Vec<String> {
    let mut merged: Vec<String> = DEFAULT_EXCLUDES.iter().map(|s| s.to_string()).collect();
    merged.extend(request_exclude.iter().cloned());
    merged
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
/// unless overridden), then tar (minus excludes) and `oras push`, mirroring
/// `build`'s push tail. Runs as `dev` — path ownership stays consistent with
/// how the tools were installed/used.
pub async fn capture(req: CaptureRequest) -> Result<BuildResult, String> {
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

    let excludes = merged_excludes(&req.exclude);
    let quoted_paths = rels.iter().map(|r| sh_quote(r)).collect::<Vec<_>>().join(" ");
    let grep_excludes = excludes
        .iter()
        .map(|g| format!(" --exclude={}", sh_quote(g)))
        .collect::<String>();
    let pattern = sh_quote(&SECRET_PATTERNS.join("|"));

    // Scan first (read-only), independent of the tar step: `grep -rIlE` lists
    // matching files (`-I` skips binaries, `-l` = names only), never fails the
    // command itself (`|| true`) so an empty result is a clean pass, not an
    // error exit this script would otherwise abort on under `set -e`.
    // Accepted limitation: `-I` means secrets embedded in BINARY files (e.g. a
    // sqlite keystore) are not scanned though they would still be tarred. This
    // is tolerated because captures default to `private: true` and publishing
    // is an explicit, separate user action — the scan gates the common
    // plaintext-dotfile case, not every conceivable blob.
    let scan_script = format!(
        "set -euo pipefail\n\
         cd {home}\n\
         grep -rIlE {pattern}{excludes}{dir_excludes} -- {paths} 2>/dev/null \
           || {{ rc=$?; [ \"$rc\" -le 1 ] || exit \"$rc\"; }}",
        home = HOME,
        pattern = pattern,
        excludes = grep_excludes,
        dir_excludes = scan_exclude_dir_flags(),
        paths = quoted_paths,
    );
    let scan = command::run(
        &scan_script,
        BUILD_TIMEOUT_MS,
        Some("dev"),
        None,
        &std::collections::HashMap::new(),
        MAX_COMMAND_OUTPUT_BYTES,
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

    let tar_excludes = tar_exclude_flags(&excludes);
    // `oras push` refuses an absolute tarball path (found live, see `build`),
    // so `cd` into the tarball's directory first and reference it by bare
    // `mktemp` name (unique so concurrent captures never clobber each other);
    // the `trap` removes it on any exit path, incl. an `oras push` failure
    // that `set -e` would otherwise abort on before a trailing `rm`.
    let script = format!(
        "set -euo pipefail\n\
         cd {dir}\n\
         name=$(mktemp atelier-toolset.XXXXXX.tar.gz)\n\
         trap 'rm -f \"$name\"' EXIT\n\
         tar -czf \"$name\"{tar_excludes} -C {home} {paths}\n\
         oras push --plain-http {target} \
           --artifact-type {at} \"$name\":{lt}",
        dir = TARBALL_DIR,
        tar_excludes = tar_excludes,
        home = HOME,
        paths = quoted_paths,
        target = sh_quote(&req.target),
        at = ARTIFACT_TYPE,
        lt = LAYER_TYPE,
    );
    let res = command::run(
        &script,
        BUILD_TIMEOUT_MS,
        Some("dev"),
        None,
        &std::collections::HashMap::new(),
        MAX_COMMAND_OUTPUT_BYTES,
    )
    .await;
    if res.exit_code != 0 {
        return Err(format!(
            "toolset capture push failed (exit {}): {}",
            res.exit_code,
            res.stderr.trim()
        ));
    }
    digest_from_push(&res)
}

/// Pull each toolset artifact by its digest-pinned reference and extract it
/// into the home as `dev` (uid 1000), in list order. Digest-pull verifies
/// content-addressing for free. Fail-fast: a bad pull/extract aborts the boot.
pub async fn materialize(req: MaterializeRequest) -> Result<MaterializeResult, String> {
    for reference in &req.toolsets {
        let script = format!(
            "set -euo pipefail\n\
             shopt -s nullglob\n\
             d=$(mktemp -d)\n\
             trap 'rm -rf \"$d\"' EXIT\n\
             oras pull --plain-http {reference} -o \"$d\"\n\
             count=0\n\
             for f in \"$d\"/*.tar.gz; do tar -xzf \"$f\" -C {home}; count=$((count+1)); done\n\
             [ \"$count\" -gt 0 ] || {{ echo \"no tar.gz layers in {reference}\" >&2; exit 1; }}",
            reference = sh_quote(reference),
            home = HOME,
        );
        let res = command::run(
            &script,
            BUILD_TIMEOUT_MS,
            Some("dev"),
            None,
            &std::collections::HashMap::new(),
            MAX_COMMAND_OUTPUT_BYTES,
        )
        .await;
        if res.exit_code != 0 {
            return Err(format!(
                "toolset materialize failed for {reference} (exit {}): {}",
                res.exit_code,
                res.stderr.trim()
            ));
        }
    }
    Ok(MaterializeResult {
        materialized: req.toolsets.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let out = "Uploading 46bc684ddba9 layer.tar.gz\nPushed [registry] \
                   zot.zot.svc:5000/toolsets/x:t\nArtifactType: \
                   application/vnd.atelier.toolset.v1+tar\nDigest: \
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
        assert_eq!(valid_sha256(&upper).unwrap(), format!("sha256:{}", "a".repeat(64)));
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
        let flags = scan_exclude_dir_flags();
        assert!(flags.contains("--exclude-dir='node_modules'"));
        assert!(flags.contains("--exclude-dir='.git'"));
        // … but it must NOT be a tar exclude, or an npm toolset would ship
        // without its dependencies.
        assert!(!merged_excludes(&[]).iter().any(|g| g == "node_modules"));
    }

    #[test]
    fn sh_quote_escapes_embedded_single_quote() {
        assert_eq!(sh_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn merged_excludes_includes_defaults_and_request() {
        let merged = merged_excludes(&["custom-secret.json".to_string()]);
        assert!(merged.iter().any(|g| g == "auth.json"));
        assert!(merged.iter().any(|g| g == ".env"));
        assert!(merged.iter().any(|g| g == "custom-secret.json"));
    }

    #[test]
    fn tar_exclude_flags_quotes_and_dedupes() {
        let excludes = vec!["auth.json".to_string(), "auth.json".to_string()];
        let flags = tar_exclude_flags(&excludes);
        assert_eq!(flags.matches("--exclude=").count(), 1);
        assert!(flags.contains("'auth.json'"));
    }

    #[test]
    fn is_overridden_matches_by_suffix_across_forms() {
        let overrides = vec!["auth.json".to_string()];
        assert!(is_overridden("/home/dev/.config/opencode/auth.json", &overrides));
        assert!(is_overridden("/home/dev/auth.json", &overrides));
        assert!(!is_overridden("/home/dev/.config/opencode/config.json", &overrides));
    }

    #[test]
    fn is_overridden_accepts_home_relative_override_forms() {
        let overrides = vec!["~/.config/pi/auth.json".to_string()];
        assert!(is_overridden("/home/dev/.config/pi/auth.json", &overrides));
        assert!(!is_overridden("/home/dev/.config/other/auth.json", &overrides));
    }

    #[test]
    fn is_overridden_false_when_no_overrides() {
        assert!(!is_overridden("/home/dev/.env", &[]));
    }
}
