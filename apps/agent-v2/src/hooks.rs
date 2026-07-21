//! Phased lifecycle hooks. The agent owns the *mechanism* (run these shell
//! commands, in order, fail-fast, as the sandbox's `dev` user with pod env);
//! the runtime owns the *policy* (which phase fires when — postCreate before
//! processes, postStart after, onResume on every resume, envChanged on
//! `PATCH /env`). The runtime drives a phase via `POST /hooks/{phase}`; the
//! agent runs the commands the config carries for it.
//!
//! Hooks run as `dev` (uid 1000, HOME=/home/dev): the canonical hooks —
//! `git config --global`, `~/.atelier/refresh-tokens.sh` — are user-scoped by
//! default. A hook needing root uses `sudo`.

use std::collections::HashMap;

use serde::Serialize;

use crate::command::{self, DEFAULT_EXEC_TIMEOUT_MS, MAX_COMMAND_OUTPUT_BYTES};
use crate::config::Hooks;

/// The four lifecycle phases, mirroring spec `HooksSchema`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    PostCreate,
    PostStart,
    OnResume,
    EnvChanged,
}

impl Phase {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "postCreate" => Some(Self::PostCreate),
            "postStart" => Some(Self::PostStart),
            "onResume" => Some(Self::OnResume),
            "envChanged" => Some(Self::EnvChanged),
            _ => None,
        }
    }

    fn commands<'a>(&self, hooks: &'a Hooks) -> &'a [String] {
        match self {
            Self::PostCreate => &hooks.post_create,
            Self::PostStart => &hooks.post_start,
            Self::OnResume => &hooks.on_resume,
            Self::EnvChanged => &hooks.env_changed,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookResult {
    pub command: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseResult {
    pub success: bool,
    pub results: Vec<HookResult>,
}

/// Run a phase's commands sequentially, stopping at the first non-zero exit
/// (fail-fast within a phase, per the ordering contract). Returns each
/// command's outcome up to and including the failing one.
pub async fn run_phase(phase: Phase, hooks: &Hooks, env: &HashMap<String, String>) -> PhaseResult {
    let mut results = Vec::new();
    let mut success = true;
    for command in phase.commands(hooks) {
        let out = command::run(
            command,
            DEFAULT_EXEC_TIMEOUT_MS,
            Some("dev"),
            None,
            env,
            MAX_COMMAND_OUTPUT_BYTES,
        )
        .await;
        let failed = out.exit_code != 0;
        results.push(HookResult {
            command: command.clone(),
            exit_code: out.exit_code,
            stdout: out.stdout,
            stderr: out.stderr,
        });
        if failed {
            success = false;
            break;
        }
    }
    PhaseResult { success, results }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_phase_names() {
        assert_eq!(Phase::parse("postCreate"), Some(Phase::PostCreate));
        assert_eq!(Phase::parse("postStart"), Some(Phase::PostStart));
        assert_eq!(Phase::parse("onResume"), Some(Phase::OnResume));
        assert_eq!(Phase::parse("envChanged"), Some(Phase::EnvChanged));
        assert_eq!(Phase::parse("bogus"), None);
    }

    #[tokio::test]
    async fn empty_phase_succeeds() {
        // The phase runner drops to `dev` (uid 1000), which can't setuid
        // off-pod, so a non-empty phase isn't unit-testable here; the
        // fail-fast ordering is covered by the live smoke. Assert the
        // base case: an empty phase is trivially successful.
        let empty = run_phase(Phase::PostStart, &Hooks::default(), &HashMap::new()).await;
        assert!(empty.success);
        assert!(empty.results.is_empty());
    }
}
