//! HTTP control plane on :9998. Surface: health, config push/read, supervised
//! process control, phased hooks, one-shot exec, file writes, and activity
//! measurement (idle auto-pause). Every route except `GET /health` requires
//! the agent token (auth.rs).

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use http_body_util::{BodyExt, Full};
use hyper::body::{Body, Buf, Bytes};
use hyper::{Method, Request, Response, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::activity::Activity;
use crate::auth::{Auth, Denied};
use crate::command::{self, DEFAULT_EXEC_TIMEOUT_MS};
use crate::config::AgentConfig;
use crate::files::{self, WriteFilesRequest};
use crate::hooks::{self, Phase};
use crate::limits::{EXEC_SEMAPHORE, FILES_SEMAPHORE, MAX_REQUEST_BODY_BYTES};
use crate::store::ConfigStore;
use crate::supervisor::Supervisor;
use crate::terminal::{CreateRequest, TerminalRegistry};
use crate::toolset;

/// Config bodies are runtime-authored (spec-sized), not user uploads.
const MAX_CONFIG_BODY_BYTES: usize = 4 * 1024 * 1024;

type Resp = Response<Full<Bytes>>;

/// Everything a request handler can reach.
pub struct AppState {
    pub store: Arc<ConfigStore>,
    pub supervisor: Arc<Supervisor>,
    pub terminals: Arc<TerminalRegistry>,
    pub activity: Arc<Activity>,
    pub auth: Arc<Auth>,
}

/// `GET /health` body (TS: `AgentHealth`). `healthy` reflects the spec's
/// `primary` process readiness — the generic, harness-agnostic boot gate (any
/// process can be `primary`). `version` lets the server flag an agent image
/// that drifted from its own release.
#[derive(Serialize)]
struct Health {
    status: &'static str,
    version: &'static str,
    uptime: f64,
    configured: bool,
    healthy: bool,
}

#[derive(Serialize)]
struct Success {
    success: bool,
}

const OK_SUCCESS: Success = Success { success: true };

pub async fn route<B>(req: Request<B>, state: &AppState) -> Resp
where
    B: Body + Unpin,
    B::Data: Buf,
{
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let start = *START.get_or_init(Instant::now);

    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();

    // Liveness stays open: the runtime polls it before it can know anything
    // else, and it carries no sensitive data.
    let is_health = method == Method::GET && path == "/health";
    if !is_health && let Err(denied) = state.auth.check_http(req.headers()) {
        return match denied {
            Denied::NotConfigured => error(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent token not configured",
            ),
            Denied::Unauthorized => {
                let mut resp = error(StatusCode::UNAUTHORIZED, "unauthorized");
                resp.headers_mut()
                    .insert("www-authenticate", "Bearer".parse().expect("static header"));
                resp
            }
        };
    }

    let store = &state.store;
    let supervisor = &state.supervisor;
    let terminals = &state.terminals;

    match (&method, path.as_str()) {
        (&Method::GET, "/health") => json(
            StatusCode::OK,
            Health {
                status: "ok",
                version: env!("CARGO_PKG_VERSION"),
                uptime: start.elapsed().as_secs_f64(),
                configured: store.get().is_some(),
                healthy: supervisor.is_healthy().await,
            },
        ),
        (&Method::GET, "/config") => match store.get() {
            Some(cfg) => json(StatusCode::OK, cfg.as_ref()),
            None => error(StatusCode::NOT_FOUND, "No config pushed yet"),
        },
        (&Method::PUT, "/config") => {
            json_call(
                req,
                MAX_CONFIG_BODY_BYTES,
                |config: AgentConfig| async move { store.set(config).await.map(|()| OK_SUCCESS) },
            )
            .await
        }
        // SSH host-key pinning (see ssh.rs): the sandbox's sshd public host
        // key(s), regenerated fresh every boot (no more baked-in keys).
        (&Method::GET, "/ssh/host-keys") => json(
            StatusCode::OK,
            serde_json::json!({ "keys": crate::ssh::host_keys() }),
        ),
        // The last hour of measured activity, raw (the server applies the
        // idle thresholds).
        (&Method::GET, "/activity") => json(StatusCode::OK, state.activity.report()),
        (&Method::GET, "/processes") => json(
            StatusCode::OK,
            serde_json::json!({ "processes": supervisor.list().await }),
        ),
        // Start all non-lazy processes not already running. The runtime calls
        // this as the "processes" phase, after files/write + postCreate. A
        // config push alone never autostarts (crash-recovery excepted).
        (&Method::POST, "/reconcile") => {
            supervisor.reconcile().await;
            json(StatusCode::OK, OK_SUCCESS)
        }
        // One-shot exec + phased hooks + file writes.
        (&Method::POST, "/exec") => handle_exec(req, store).await,
        (&Method::POST, "/files/write") => handle_write_files(req).await,
        // Build+push a toolset artifact from declared home path-sets (the
        // runtime drives this in a throwaway build pod; the tail of the
        // toolset build path — docs/archive/proposals/composed-prebuild-volumes.md §2).
        (&Method::POST, "/toolsets/build") => {
            json_call(req, MAX_REQUEST_BODY_BYTES, toolset::build).await
        }
        // Capture a live sandbox's declared path-sets into a toolset artifact
        // (secret-scanned, exclude-filtered) — docs/archive/proposals/composed-prebuild-volumes.md §2
        // "captured (result-keyed)".
        (&Method::POST, "/toolsets/capture") => {
            json_call(req, MAX_REQUEST_BODY_BYTES, toolset::capture).await
        }
        // Materialize toolset artifacts into the home (runtime drives this as
        // a boot phase before files/env, fresh boots only).
        (&Method::POST, "/toolsets") => {
            json_call(req, MAX_REQUEST_BODY_BYTES, toolset::materialize).await
        }
        // Interactive terminal sessions (byte relay + resize on the attach port, /terminal/{id}).
        (&Method::GET, "/terminal/sessions") => json(StatusCode::OK, terminals.list().await),
        // Spawn a login shell on a fresh PTY, returning its `TerminalSession`
        // metadata. The WS byte relay lives on the attach port.
        (&Method::POST, "/terminal/sessions") => {
            json_call(req, MAX_REQUEST_BODY_BYTES, |create: CreateRequest| {
                terminals.create(create)
            })
            .await
        }
        _ if method == Method::POST && path.starts_with("/hooks/") => {
            handle_hooks(&path, store).await
        }
        _ if path.starts_with("/terminal/sessions/") => {
            route_terminal_session(&method, &path, terminals).await
        }
        _ => route_process(&method, &path, &query, supervisor).await,
    }
}

/// Parse a `u64` query param (e.g. `offset`, `limit`) from a raw query string,
/// falling back to `default` when absent or malformed.
fn query_u64(query: &str, key: &str, default: u64) -> u64 {
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix(key)?.strip_prefix('='))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Pod env (with resolved secrets) that exec/hooks run under; empty if no
/// config has been pushed yet.
fn pod_env(store: &Arc<ConfigStore>) -> HashMap<String, String> {
    store.get().map(|c| c.env.clone()).unwrap_or_default()
}

#[derive(serde::Deserialize)]
struct ExecBody {
    command: String,
    timeout: Option<u64>,
    user: Option<String>,
    workdir: Option<String>,
}

async fn handle_exec<B>(req: Request<B>, store: &Arc<ConfigStore>) -> Resp
where
    B: Body + Unpin,
    B::Data: Buf,
{
    let _permit = EXEC_SEMAPHORE.acquire().await.expect("exec semaphore");
    json_call(req, MAX_REQUEST_BODY_BYTES, |p: ExecBody| async move {
        Ok::<_, String>(
            command::run(
                &p.command,
                p.timeout.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS),
                p.user.as_deref(),
                p.workdir.as_deref(),
                &pod_env(store),
                command::MAX_COMMAND_OUTPUT_BYTES,
            )
            .await,
        )
    })
    .await
}

/// `POST /hooks/{phase}` runs the config's commands for that lifecycle phase
/// (mechanism); the runtime decides when to fire each phase (policy).
async fn handle_hooks(path: &str, store: &Arc<ConfigStore>) -> Resp {
    let name = path.strip_prefix("/hooks/").unwrap_or_default();
    let Some(phase) = Phase::parse(name) else {
        return error(StatusCode::NOT_FOUND, "Unknown hook phase");
    };
    let Some(cfg) = store.get() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "no config");
    };
    let result = hooks::run_phase(phase, &cfg.hooks, &cfg.env).await;
    let status = if result.success {
        StatusCode::OK
    } else {
        StatusCode::UNPROCESSABLE_ENTITY
    };
    json(status, result)
}

async fn handle_write_files<B>(req: Request<B>) -> Resp
where
    B: Body + Unpin,
    B::Data: Buf,
{
    let _permit = FILES_SEMAPHORE.acquire().await.expect("files semaphore");
    let parsed: WriteFilesRequest = match read_json(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    let results = files::write_files(parsed).await;
    let status = if results.iter().all(|r| r.success) {
        StatusCode::OK
    } else {
        StatusCode::MULTI_STATUS
    };
    json(status, serde_json::json!({ "results": results }))
}

/// `GET|DELETE /terminal/sessions/{id}` — inspect or kill one shell.
async fn route_terminal_session(
    method: &Method,
    path: &str,
    terminals: &Arc<TerminalRegistry>,
) -> Resp {
    let id = path.strip_prefix("/terminal/sessions/").unwrap_or_default();
    if id.is_empty() || id.contains('/') {
        return error(StatusCode::NOT_FOUND, "Not found");
    }
    if *method == Method::GET {
        match terminals.get(id).await {
            Some(meta) => json(StatusCode::OK, meta),
            None => error(StatusCode::NOT_FOUND, "Unknown terminal session"),
        }
    } else if *method == Method::DELETE {
        let removed = terminals.delete(id).await;
        json(StatusCode::OK, Success { success: removed })
    } else {
        error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed")
    }
}

/// `/processes/{name}` and `/processes/{name}/{start|stop}` — the supervised
/// process control surface (lazy activation, restart, inspection).
async fn route_process(
    method: &Method,
    path: &str,
    query: &str,
    supervisor: &Arc<Supervisor>,
) -> Resp {
    let Some(rest) = path.strip_prefix("/processes/") else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    let (name, action) = match rest.split_once('/') {
        Some((n, a)) => (n, Some(a)),
        None => (rest, None),
    };
    if name.is_empty() {
        return error(StatusCode::NOT_FOUND, "Not found");
    }
    match (method, action) {
        (&Method::GET, None) => match supervisor.get(name).await {
            Some(state) => json(StatusCode::OK, state),
            None => error(StatusCode::NOT_FOUND, "Unknown process"),
        },
        // Byte-windowed log read; `offset`/`limit` are optional query params.
        // Caps `limit` at the shared body ceiling so a huge log can't be
        // slurped whole in one response.
        (&Method::GET, Some("logs")) => {
            let offset = query_u64(query, "offset", 0);
            let limit = query_u64(query, "limit", MAX_REQUEST_BODY_BYTES as u64)
                .min(MAX_REQUEST_BODY_BYTES as u64) as usize;
            json(
                StatusCode::OK,
                supervisor.read_logs(name, offset, limit).await,
            )
        }
        (&Method::POST, Some("start")) => match supervisor.ensure_started(name).await {
            Ok(()) => json(StatusCode::OK, OK_SUCCESS),
            Err(e) => error(classify_start_error(&e), &e),
        },
        (&Method::POST, Some("stop")) => match supervisor.stop(name).await {
            Ok(()) => json(StatusCode::OK, OK_SUCCESS),
            Err(e) => error(StatusCode::NOT_FOUND, &e),
        },
        _ => error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"),
    }
}

/// Map a supervisor start error to an HTTP status: missing config is a
/// transient 503, an unknown process is 404, a spawn/log failure is 500.
fn classify_start_error(e: &str) -> StatusCode {
    if e == "no config" {
        StatusCode::SERVICE_UNAVAILABLE
    } else if e.starts_with("unknown process") {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

/// Read the body (capped at `max`) and parse it as JSON: 413 past the cap,
/// 400 for malformed JSON or unknown fields.
async fn read_json<T, B>(req: Request<B>, max: usize) -> Result<T, Resp>
where
    T: DeserializeOwned,
    B: Body + Unpin,
    B::Data: Buf,
{
    let body = read_body(req, max).await?;
    serde_json::from_slice(&body)
        .map_err(|e| error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {e}")))
}

/// The shared "read body, parse, run, respond" shape: `Ok` answers 200 with
/// the result as JSON, `Err` answers 422 with the message.
async fn json_call<T, R, B, F, Fut>(req: Request<B>, max: usize, call: F) -> Resp
where
    T: DeserializeOwned,
    R: Serialize,
    B: Body + Unpin,
    B::Data: Buf,
    F: FnOnce(T) -> Fut,
    Fut: Future<Output = Result<R, String>>,
{
    let parsed = match read_json(req, max).await {
        Ok(p) => p,
        Err(resp) => return resp,
    };
    match call(parsed).await {
        Ok(result) => json(StatusCode::OK, result),
        Err(e) => error(StatusCode::UNPROCESSABLE_ENTITY, &e),
    }
}

async fn read_body<B>(req: Request<B>, max: usize) -> Result<Bytes, Resp>
where
    B: Body + Unpin,
    B::Data: Buf,
{
    let mut body = req.into_body();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| error(StatusCode::BAD_REQUEST, "Failed to read body"))?;
        if let Ok(mut data) = frame.into_data() {
            if buf.len().saturating_add(data.remaining()) > max {
                return Err(error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Request body too large",
                ));
            }
            buf.extend_from_slice(&data.copy_to_bytes(data.remaining()));
        }
    }
    Ok(Bytes::from(buf))
}

fn json(status: StatusCode, body: impl Serialize) -> Resp {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(
            serde_json::to_vec(&body).unwrap_or_default(),
        )))
        .expect("static response builder")
}

fn error(status: StatusCode, message: &str) -> Resp {
    json(status, serde_json::json!({ "error": message }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attach::AttachRegistry;

    const TOKEN: &str = "test-token";

    fn state(token: Option<&str>) -> AppState {
        let store = Arc::new(ConfigStore::new_for_test(None));
        AppState {
            supervisor: Supervisor::new(store.clone()),
            terminals: TerminalRegistry::new(store.clone(), AttachRegistry::new()),
            activity: Activity::new(),
            auth: Arc::new(Auth::new(token.map(Into::into))),
            store,
        }
    }

    async fn call(
        state: &AppState,
        method: Method,
        path: &str,
        bearer: Option<&str>,
        body: impl Into<Bytes>,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder().method(method).uri(path);
        if let Some(token) = bearer {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        let resp = route(req.body(Full::new(body.into())).unwrap(), state).await;
        let status = resp.status();
        let bytes = resp.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }

    #[test]
    fn health_wire_shape() {
        let health = Health {
            status: "ok",
            version: "0.0.0",
            uptime: 12.5,
            configured: true,
            healthy: true,
        };
        assert_eq!(
            serde_json::to_value(health).unwrap(),
            serde_json::from_str::<serde_json::Value>(include_str!(
                "../tests/fixtures/health.json"
            ))
            .unwrap()
        );
    }

    #[tokio::test]
    async fn health_is_open_and_reports_version_without_config() {
        // No token configured and none presented: /health still answers.
        let state = state(None);
        let (status, body) = call(&state, Method::GET, "/health", None, "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ok");
        assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(body["configured"], false);
        assert_eq!(body["healthy"], true);
    }

    #[tokio::test]
    async fn other_routes_need_the_bearer_token() {
        let state = state(Some(TOKEN));
        let (status, _) = call(&state, Method::GET, "/processes", None, "").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = call(&state, Method::GET, "/processes", Some("wrong"), "").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = call(&state, Method::POST, "/exec", None, r#"{"command":"id"}"#).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, body) = call(&state, Method::GET, "/processes", Some(TOKEN), "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["processes"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn refuses_everything_but_health_without_a_configured_token() {
        let state = state(None);
        let (status, _) = call(&state, Method::GET, "/processes", Some(TOKEN), "").await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn invalid_put_config_is_rejected() {
        let state = state(Some(TOKEN));
        // Structurally invalid (duplicate process names): 422.
        let dup = serde_json::json!({
            "sandboxId": "sb",
            "processes": [
                { "name": "a", "command": "true" },
                { "name": "a", "command": "true" },
            ],
        });
        let (status, body) =
            call(&state, Method::PUT, "/config", Some(TOKEN), dup.to_string()).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(body["error"].as_str().unwrap().contains("duplicate"));
        // Malformed or unknown-field JSON never reaches validation: 400.
        let unknown = r#"{"sandboxId":"sb","bogus":1}"#;
        let (status, _) = call(&state, Method::PUT, "/config", Some(TOKEN), unknown).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = call(&state, Method::PUT, "/config", Some(TOKEN), "{").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(state.store.get().is_none(), "a rejected push must not swap");
    }

    #[tokio::test]
    async fn oversized_body_is_rejected() {
        let state = state(Some(TOKEN));
        let body = vec![b' '; MAX_CONFIG_BODY_BYTES + 1];
        let (status, _) = call(&state, Method::PUT, "/config", Some(TOKEN), body).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn unknown_targets_are_404() {
        let state = state(Some(TOKEN));
        for (method, path) in [
            (Method::GET, "/processes/nope"),
            (Method::POST, "/processes/nope/stop"),
            (Method::POST, "/processes/nope/start"),
            (Method::POST, "/hooks/bogus"),
            (Method::GET, "/terminal/sessions/term-404"),
            (Method::GET, "/nope"),
        ] {
            // Starting needs a config to resolve the name against.
            let (status, _) = call(&state, method.clone(), path, Some(TOKEN), "").await;
            let expected = if path == "/processes/nope/start" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::NOT_FOUND
            };
            assert_eq!(status, expected, "{method} {path}");
        }
    }

    #[tokio::test]
    async fn health_reports_configured_after_a_push() {
        let state = state(Some(TOKEN));
        state
            .store
            .set(serde_json::from_str(r#"{"sandboxId":"sb"}"#).unwrap())
            .await
            .unwrap();
        let (status, body) = call(&state, Method::GET, "/health", None, "").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["configured"], true);
        let (status, _) = call(
            &state,
            Method::POST,
            "/processes/nope/start",
            Some(TOKEN),
            "",
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
