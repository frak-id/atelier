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
const TARBALL_NAME: &str = "atelier-toolset.tar.gz";
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
    r"sk-[A-Za-z0-9]{20,}",                 // OpenAI-style secret key
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

/// Extract the `sha256:<64hex>` manifest digest from `oras push` output.
fn parse_digest(output: &str) -> Option<String> {
    for token in output.split_whitespace() {
        if let Some(hex) = token.strip_prefix("sha256:")
            && hex.len() == 64
            && hex.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Some(format!("sha256:{hex}"));
        }
    }
    None
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
    // `oras push` refuses an absolute tarball path ("absolute file path
    // detected" — its default traversal guard), so `cd` into the tarball's
    // directory first and reference it by bare filename.
    let script = format!(
        "set -euo pipefail\n\
         cd {dir}\n\
         tar -czf {name} -C {home} {paths}\n\
         oras push --plain-http {target} \
           --artifact-type {at} {name}:{lt}\n\
         rm -f {name}",
        dir = TARBALL_DIR,
        name = TARBALL_NAME,
        home = HOME,
        paths = quoted_paths,
        target = sh_quote(&req.target),
        at = ARTIFACT_TYPE,
        lt = LAYER_TYPE,
    );

    let res = command::run(
        &script,
        BUILD_TIMEOUT_MS,
        None,
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
    parse_digest(&res.stdout)
        .map(|digest| BuildResult { digest })
        .ok_or_else(|| "could not parse pushed digest from oras output".to_string())
}

/// Build the `tar --exclude=<glob>` flags for a merged (default + request)
/// exclude list, deduplicated and shell-quoted. Each glob is passed twice —
/// bare and `*/`-prefixed — so it matches both a top-level file and one
/// nested under a captured directory (tar's `--exclude` matches path
/// components, not just basenames, when the pattern has no `/`; passing the
/// bare glob already covers nested matches, but the explicit `*/` form keeps
/// intent obvious for maintainers reading the generated script).
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
    let scan_script = format!(
        "set -euo pipefail\n\
         cd {home}\n\
         grep -rIlE {pattern}{excludes} --exclude-dir=.git -- {paths} 2>/dev/null || true",
        home = HOME,
        pattern = pattern,
        excludes = grep_excludes,
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
    // filename.
    let script = format!(
        "set -euo pipefail\n\
         cd {dir}\n\
         tar -czf {name}{tar_excludes} -C {home} {paths}\n\
         oras push --plain-http {target} \
           --artifact-type {at} {name}:{lt}\n\
         rm -f {name}",
        dir = TARBALL_DIR,
        name = TARBALL_NAME,
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
    parse_digest(&res.stdout)
        .map(|digest| BuildResult { digest })
        .ok_or_else(|| "could not parse pushed digest from oras output".to_string())
}

/// Pull each toolset artifact by its digest-pinned reference and extract it
/// into the home as `dev` (uid 1000), in list order. Digest-pull verifies
/// content-addressing for free. Fail-fast: a bad pull/extract aborts the boot.
pub async fn materialize(req: MaterializeRequest) -> Result<MaterializeResult, String> {
    for reference in &req.toolsets {
        let script = format!(
            "set -euo pipefail\n\
             d=$(mktemp -d)\n\
             oras pull --plain-http {reference} -o \"$d\"\n\
             for f in \"$d\"/*.tar.gz; do tar -xzf \"$f\" -C {home}; done\n\
             rm -rf \"$d\"",
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
