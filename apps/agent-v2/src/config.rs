//! The v2 agent config schema — a strict *projection* of `@atelier/spec`'s
//! `SandboxSpec` (packages/spec/src/sandbox-spec.ts), never a reshape.
//!
//! What crosses into the guest: `sandboxId`, `env`, `processes[]`, `ports[]`,
//! `hooks`. What never crosses: `source`/`resources` (runtime picked the
//! image; Kata enforces resources), `caches` (PVC mounts), `files[]` (pushed
//! in the boot request body and written to their paths — file *contents* are
//! never persisted in the config), `metadata`/`annotations` (observability,
//! runtime-side), `timeoutSeconds` (runtime lifecycle).
//!
//! `deny_unknown_fields` everywhere: the runtime owns the payload, so schema
//! drift between seam and guest fails loudly instead of silently dropping.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Mirrors spec `ReadinessSchema`: exactly one of `port` | `http` | `cmd`.
/// Deserialized through `ReadinessRepr` so "exactly one, no extras" is
/// enforced at parse time (untagged enums can't deny unknown fields).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged, try_from = "ReadinessRepr")]
pub enum Readiness {
    Port { port: u16 },
    Http { http: String },
    Cmd { cmd: String },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadinessRepr {
    port: Option<u16>,
    http: Option<String>,
    cmd: Option<String>,
}

impl TryFrom<ReadinessRepr> for Readiness {
    type Error = String;

    fn try_from(r: ReadinessRepr) -> Result<Self, Self::Error> {
        match (r.port, r.http, r.cmd) {
            (Some(port), None, None) => Ok(Readiness::Port { port }),
            (None, Some(http), None) => Ok(Readiness::Http { http }),
            (None, None, Some(cmd)) => Ok(Readiness::Cmd { cmd }),
            _ => Err("readiness must have exactly one of port | http | cmd".into()),
        }
    }
}

/// Mirrors spec `StdioModeSchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StdioMode {
    #[default]
    None,
    Bridge,
}

/// Mirrors spec `RestartPolicySchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RestartPolicy {
    #[default]
    Never,
    OnFailure,
    Always,
}

/// Mirrors spec `ProcessSchema`. `name` is the only identity.
///
/// `user` is an agent-side mechanism knob (uid selection at spawn) that the
/// spec does not type yet — the runtime defaults it; flagged upstream as a
/// `ProcessSchema` gap (v1 hardcoded harness=dev, services=root).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessEntry {
    pub name: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// Sandbox "ready"/"healthy" == this process (at most one).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub primary: bool,
    #[serde(default, skip_serializing_if = "is_default_stdio")]
    pub stdio: StdioMode,
    /// Allocate a PTY for this process (today's terminal).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pty: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readiness: Option<Readiness>,
    /// Wait for these processes' readiness before spawning.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub after: Vec<String>,
    #[serde(default, skip_serializing_if = "is_default_restart")]
    pub restart: RestartPolicy,
    /// Socket-activation style: spawn on first access, not at boot.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub lazy: bool,
}

fn is_default_stdio(s: &StdioMode) -> bool {
    *s == StdioMode::None
}

fn is_default_restart(r: &RestartPolicy) -> bool {
    *r == RestartPolicy::Never
}

/// The forwarder subset of spec `PortSchema`. `public`/`auth` are ingress
/// concerns and never reach the guest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortEntry {
    pub name: String,
    pub port: u16,
}

/// Mirrors spec `HooksSchema`: arbitrary shell, phase-scheduled, ordered.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct Hooks {
    pub post_create: Vec<String>,
    pub post_start: Vec<String>,
    /// Fires on every resume — the credential-rotation primitive.
    pub on_resume: Vec<String>,
    /// Fired by `PATCH /env`; the user wires it to reload their processes.
    pub env_changed: Vec<String>,
}

impl Hooks {
    pub fn is_empty(&self) -> bool {
        self.post_create.is_empty()
            && self.post_start.is_empty()
            && self.on_resume.is_empty()
            && self.env_changed.is_empty()
    }
}

/// The full guest config, pushed by the runtime (never ConfigMap-mounted:
/// per-process `env` may hold resolved secrets, which must not persist in
/// etcd). Persisted to tmpfs only, so it survives an agent crash-restart but
/// dies with the pod — resume re-pushes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentConfig {
    pub sandbox_id: String,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub processes: Vec<ProcessEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ports: Vec<PortEntry>,
    #[serde(default, skip_serializing_if = "Hooks::is_empty")]
    pub hooks: Hooks,
}

impl AgentConfig {
    /// Structural validation beyond serde: unique process names, `after`
    /// references resolve (and aren't self-references), at most one `primary`.
    /// Cycle detection across `after` chains is the supervisor's concern.
    pub fn validate(&self) -> Result<(), String> {
        let mut names = std::collections::HashSet::new();
        for p in &self.processes {
            if p.name.is_empty() {
                return Err("process name must not be empty".into());
            }
            if !names.insert(p.name.as_str()) {
                return Err(format!("duplicate process name: {}", p.name));
            }
        }
        let mut primaries = self.processes.iter().filter(|p| p.primary);
        if primaries.next().is_some() && primaries.next().is_some() {
            return Err("at most one process may be primary".into());
        }
        for p in &self.processes {
            for dep in &p.after {
                if dep == &p.name {
                    return Err(format!("process {} cannot be after itself", p.name));
                }
                if !names.contains(dep.as_str()) {
                    return Err(format!("process {} is after unknown process {dep}", p.name));
                }
            }
        }
        let mut port_names = std::collections::HashSet::new();
        for port in &self.ports {
            if !port_names.insert(port.name.as_str()) {
                return Err(format!("duplicate port name: {}", port.name));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proc(name: &str) -> ProcessEntry {
        ProcessEntry {
            name: name.into(),
            command: "true".into(),
            cwd: None,
            env: None,
            user: None,
            primary: false,
            stdio: StdioMode::None,
            pty: false,
            readiness: None,
            after: vec![],
            restart: RestartPolicy::Never,
            lazy: false,
        }
    }

    #[test]
    fn deserializes_spec_shaped_json() {
        let json = r#"{
          "sandboxId": "sb_1",
          "env": { "GITHUB_TOKEN": "ghp_x" },
          "processes": [
            { "name": "acp", "command": "opencode acp", "stdio": "bridge", "primary": true },
            { "name": "web", "command": "bun run dev", "cwd": "/home/dev/app",
              "env": { "PORT": "5173" }, "restart": "on-failure", "after": ["acp"],
              "readiness": { "port": 5173 } },
            { "name": "vscode", "command": "code-server", "lazy": true,
              "readiness": { "http": "/health" } },
            { "name": "db", "command": "pg", "readiness": { "cmd": "pg_isready" } }
          ],
          "ports": [ { "name": "web", "port": 5173 } ],
          "hooks": { "onResume": ["~/.atelier/refresh-tokens.sh"] }
        }"#;
        let cfg: AgentConfig = serde_json::from_str(json).expect("parse");
        assert_eq!(cfg.processes.len(), 4);
        assert_eq!(cfg.processes[0].stdio, StdioMode::Bridge);
        assert!(cfg.processes[0].primary);
        assert_eq!(cfg.processes[1].restart, RestartPolicy::OnFailure);
        assert_eq!(
            cfg.processes[1].readiness,
            Some(Readiness::Port { port: 5173 })
        );
        assert_eq!(
            cfg.processes[2].readiness,
            Some(Readiness::Http {
                http: "/health".into()
            })
        );
        assert!(cfg.processes[2].lazy);
        assert_eq!(cfg.hooks.on_resume.len(), 1);
        cfg.validate().expect("valid");
    }

    #[test]
    fn roundtrips_serialization() {
        let cfg = AgentConfig {
            sandbox_id: "sb_1".into(),
            env: HashMap::new(),
            processes: vec![
                ProcessEntry {
                    readiness: Some(Readiness::Cmd { cmd: "true".into() }),
                    after: vec!["other".into()],
                    ..proc("acp")
                },
                proc("other"),
            ],
            ports: vec![PortEntry {
                name: "web".into(),
                port: 5173,
            }],
            hooks: Hooks::default(),
        };
        let json = serde_json::to_string(&cfg).expect("serialize");
        let back: AgentConfig = serde_json::from_str(&json).expect("parse");
        assert_eq!(cfg, back);
    }

    #[test]
    fn rejects_unknown_fields() {
        // A raw SandboxSpec (with `resources`) must fail loudly, not be
        // silently accepted — the runtime projects before pushing.
        let json = r#"{ "sandboxId": "sb", "resources": { "vcpus": 4 } }"#;
        assert!(serde_json::from_str::<AgentConfig>(json).is_err());
    }

    #[test]
    fn rejects_ambiguous_readiness() {
        let json = r#"{ "port": 1, "http": "/x" }"#;
        assert!(serde_json::from_str::<Readiness>(json).is_err());
    }

    #[test]
    fn validate_rejects_duplicate_names() {
        let cfg = AgentConfig {
            sandbox_id: "sb".into(),
            env: HashMap::new(),
            processes: vec![proc("a"), proc("a")],
            ports: vec![],
            hooks: Hooks::default(),
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn validate_rejects_unknown_after() {
        let mut p = proc("a");
        p.after = vec!["ghost".into()];
        let cfg = AgentConfig {
            sandbox_id: "sb".into(),
            env: HashMap::new(),
            processes: vec![p],
            ports: vec![],
            hooks: Hooks::default(),
        };
        assert!(cfg.validate().is_err());
    }

    #[test]
    fn validate_rejects_two_primaries() {
        let mut a = proc("a");
        a.primary = true;
        let mut b = proc("b");
        b.primary = true;
        let cfg = AgentConfig {
            sandbox_id: "sb".into(),
            env: HashMap::new(),
            processes: vec![a, b],
            ports: vec![],
            hooks: Hooks::default(),
        };
        assert!(cfg.validate().is_err());
    }
}
