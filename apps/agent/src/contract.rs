//! Wire-contract tests against the golden JSON in `tests/fixtures`, shared
//! with the server's `agent.contract.test.ts`. The config fixture is produced
//! by the server's `specToAgentConfig` and must parse here (strictly); the
//! other fixtures are what this agent serializes and what the server's TS
//! types must describe.

use serde::Serialize;
use serde_json::Value;

use crate::activity::{ActivityReport, BucketReport};
use crate::command::ExecResult;
use crate::config::{AgentConfig, Readiness, RestartPolicy, StdioMode};
use crate::files::FileWriteResult;
use crate::hooks::{HookResult, PhaseResult};
use crate::supervisor::{ProcessState, ProcessStatus};

fn fixture(raw: &str) -> Value {
    serde_json::from_str(raw).expect("fixture is valid JSON")
}

fn assert_wire<T: Serialize>(value: &T, golden: &str) {
    assert_eq!(serde_json::to_value(value).unwrap(), fixture(golden));
}

#[test]
fn agent_config_fixture_parses_strictly() {
    let raw = include_str!("../tests/fixtures/agent-config.json");
    let config: AgentConfig = serde_json::from_str(raw).expect("server config parses");
    config.validate().expect("server config validates");

    assert_eq!(config.sandbox_id, "sb_fixture");
    assert_eq!(config.processes.len(), 3);
    let web = &config.processes[0];
    assert!(web.primary);
    assert_eq!(
        web.readiness,
        Some(Readiness::Http {
            http: "/health".into()
        })
    );
    assert_eq!(web.restart, RestartPolicy::OnFailure);
    let acp = &config.processes[1];
    assert_eq!(acp.stdio, StdioMode::Bridge);
    assert!(acp.lazy);
    assert_eq!(acp.after, vec!["web".to_string()]);
    assert!(config.processes[2].pty);
    assert_eq!(config.ports[0].port, 3000);
    assert_eq!(config.hooks.post_create.len(), 1);
    assert_eq!(config.hooks.on_resume.len(), 1);

    // Lossless through our own serializer.
    let again: AgentConfig =
        serde_json::from_value(serde_json::to_value(&config).unwrap()).unwrap();
    assert_eq!(again, config);
}

#[test]
fn agent_config_rejects_unknown_fields() {
    let mut value = fixture(include_str!("../tests/fixtures/agent-config.json"));
    value["processes"][0]["bogus"] = Value::Bool(true);
    assert!(serde_json::from_value::<AgentConfig>(value).is_err());
    let mut value = fixture(include_str!("../tests/fixtures/agent-config.json"));
    value["bogus"] = Value::Bool(true);
    assert!(serde_json::from_value::<AgentConfig>(value).is_err());
}

#[test]
fn process_state_wire_shape() {
    let running = ProcessState {
        name: "web".into(),
        status: ProcessStatus::Running,
        pid: 4242,
        ready: true,
        primary: true,
        exit_code: None,
        started_at: "2026-11-05T10:00:00Z".into(),
        log_file: "/var/log/sandbox/web.log".into(),
        generation: 7,
    };
    let stopped = ProcessState {
        name: "job".into(),
        status: ProcessStatus::Stopped,
        pid: 0,
        ready: false,
        primary: false,
        exit_code: Some(1),
        started_at: "2026-11-05T10:01:00Z".into(),
        log_file: "/var/log/sandbox/job.log".into(),
        generation: 2,
    };
    assert_wire(
        &serde_json::json!({ "processes": [running, stopped] }),
        include_str!("../tests/fixtures/process-state.json"),
    );
}

#[test]
fn activity_wire_shape() {
    let report = ActivityReport {
        now_ms: 1_793_872_800_000,
        booted_at_ms: 1_793_872_000_000,
        bucket_seconds: 60,
        network: "netdev",
        files: "fanotify",
        cpu: "cgroup2",
        buckets: vec![BucketReport {
            start_ms: 1_793_872_740_000,
            received_bytes: 1024,
            sent_bytes: 512,
            file_writes: 3,
            cpu_ms: 250,
        }],
    };
    assert_wire(&report, include_str!("../tests/fixtures/activity.json"));
}

#[test]
fn hook_result_wire_shape() {
    let result = PhaseResult {
        success: false,
        results: vec![
            HookResult {
                command: "true".into(),
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            HookResult {
                command: "false".into(),
                exit_code: 1,
                stdout: String::new(),
                stderr: "boom".into(),
            },
        ],
    };
    assert_wire(&result, include_str!("../tests/fixtures/hook-result.json"));
}

#[test]
fn exec_result_wire_shape() {
    let result = ExecResult {
        exit_code: 0,
        stdout: "hi\n".into(),
        stderr: String::new(),
    };
    assert_wire(&result, include_str!("../tests/fixtures/exec-result.json"));
}

#[test]
fn files_write_result_wire_shape() {
    let results = serde_json::json!({
        "results": [
            FileWriteResult { path: "/home/dev/a".into(), success: true, error: None },
            FileWriteResult {
                path: "/home/dev/b".into(),
                success: false,
                error: Some("bad mode: zzz".into()),
            },
        ]
    });
    assert_wire(
        &results,
        include_str!("../tests/fixtures/files-write-result.json"),
    );
}
