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
const TARBALL: &str = "/tmp/atelier-toolset.tar.gz";
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
    let script = format!(
        "set -euo pipefail\n\
         tar -czf {tar} -C {home} {paths}\n\
         oras push --plain-http {target} \
           --artifact-type {at} {tar}:{lt}\n\
         rm -f {tar}",
        tar = TARBALL,
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
}
