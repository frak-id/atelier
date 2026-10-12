//! Atelier's REST API, as far as this adapter calls it: `/v1` (hosts, their lifecycle, the
//! jobs a long one runs as, a file written into one, a command run in one) and `/api`
//! (the caller's SSH keys, the server's settings).
//!
//! A host is what Atelier's API serves under `/v1/sandboxes`; that path is Atelier's word
//! and is sent as it is. Every item here is named by Steery's words: [`Host`] is one as
//! Atelier lists it.

use std::collections::BTreeMap;
use std::time::Duration;

use reqwest::{Method, RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::Instant;

/// How often a job or a host changing state is read again.
const POLL: Duration = Duration::from_secs(1);

/// How a call to Atelier failed.
#[derive(Debug)]
pub enum Fault {
    /// Atelier has no such host or job (HTTP 404).
    NotFound(String),
    /// Atelier refused the API key (HTTP 401, 403), and what it said: a key that does not
    /// heal by waiting, given again by the person.
    KeyRefused { status: u16, said: String },
    /// Atelier is down: not reached, a gateway that answers for it (HTTP 502, 503, 504),
    /// or a request that got no answer in its time.
    Offline(String),
    /// Atelier answered, and the host or its job did not get where it was asked in time.
    TimedOut(String),
    /// Anything else Atelier answered, or a job that failed.
    Failed(String),
}

/// A host as `GET /v1/sandboxes` lists it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

/// A host as `GET /v1/sandboxes/:id` answers it.
#[derive(Debug, Deserialize)]
pub struct Found {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub urls: Vec<Url>,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

/// One of a host's URLs; the one named `ssh` is how to reach it.
#[derive(Debug, Deserialize)]
pub struct Url {
    pub name: String,
    pub url: String,
}

impl Found {
    /// The URL Atelier gives for SSH into it, where it gives one.
    pub fn ssh(&self) -> Option<&str> {
        self.urls
            .iter()
            .find(|url| url.name == "ssh")
            .map(|url| url.url.as_str())
    }
}

/// What a host is made from, as `POST /v1/sandboxes` takes it.
#[derive(Serialize)]
pub struct Create<'a> {
    pub source: Source<'a>,
    pub metadata: &'a BTreeMap<String, String>,
}

/// Exactly one of an image or a snapshot.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source<'a> {
    Image(&'a str),
    Snapshot(&'a str),
}

/// A long operation, as `POST /v1/sandboxes` and `…/fork` answer it and `GET /v1/jobs/:id`
/// reads it.
#[derive(Debug, Deserialize)]
pub struct Job {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
    #[serde(default)]
    pub error: Option<String>,
}

impl Job {
    /// The id of the host the job makes, which Atelier picks before it starts.
    pub fn host(&self) -> Result<String, Fault> {
        self.metadata
            .get("sandboxId")
            .filter(|id| !id.is_empty())
            .cloned()
            .ok_or_else(|| Fault::Failed(format!("job {} names no sandbox", self.id)))
    }
}

/// One file `PATCH /v1/sandboxes/:id/files` writes.
#[derive(Serialize)]
pub struct File<'a> {
    pub path: &'a str,
    pub content: &'a str,
    pub mode: String,
    pub owner: &'a str,
}

/// What `POST /v1/sandboxes/:id/exec` answers.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ran {
    pub exit_code: i64,
    #[serde(default)]
    pub stdout: String,
    #[serde(default)]
    pub stderr: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshKey {
    public_key: String,
}

#[derive(Deserialize)]
struct Setting {
    key: String,
    value: Value,
}

/// A time by which a method answers.
#[derive(Clone, Copy)]
pub struct Deadline {
    at: Instant,
    seconds: u64,
}

impl Deadline {
    pub fn after(seconds: u64) -> Self {
        Self {
            at: Instant::now() + Duration::from_secs(seconds),
            seconds,
        }
    }

    pub fn seconds(&self) -> u64 {
        self.seconds
    }

    /// The time left, or none.
    pub fn left(&self) -> Option<Duration> {
        self.at
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
    }

    fn within(&self) -> Result<Duration, Fault> {
        self.left()
            .ok_or_else(|| Fault::TimedOut(format!("no answer within {} s", self.seconds)))
    }
}

/// A client of one Atelier server, as the user an API key is.
pub struct Atelier {
    http: reqwest::Client,
    base: String,
    key: String,
}

impl Atelier {
    pub fn new(base: &str, key: String) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .user_agent(concat!(
                "steery-adapter-atelier/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|e| e.to_string())?;
        let base = base.trim_end_matches('/').to_owned();
        if !(base.starts_with("https://") || base.starts_with("http://")) {
            return Err(format!("ATELIER_URL must be an http(s) URL, not {base}"));
        }
        Ok(Self { http, base, key })
    }

    /// The API key, to keep out of every line.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// The server's host name, as `ATELIER_URL` names it.
    pub fn host_name(&self) -> &str {
        let rest = self
            .base
            .split_once("://")
            .map_or(self.base.as_str(), |(_, rest)| rest);
        let authority = rest.split('/').next().unwrap_or(rest);
        authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host)
            .split(':')
            .next()
            .unwrap_or(authority)
    }

    fn call(
        &self,
        method: Method,
        path: &str,
        deadline: Deadline,
    ) -> Result<RequestBuilder, Fault> {
        Ok(self
            .http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(&self.key)
            .timeout(deadline.within()?))
    }

    /// Every host whose metadata holds all of `labels`.
    pub async fn list(
        &self,
        labels: &BTreeMap<String, String>,
        deadline: Deadline,
    ) -> Result<Vec<Host>, Fault> {
        let labels = serde_json::to_string(labels).map_err(|e| Fault::Failed(e.to_string()))?;
        let request = self
            .call(Method::GET, "/v1/sandboxes", deadline)?
            .query(&[("metadata", labels)]);
        json(send(request).await?).await
    }

    pub async fn get(&self, id: &str, deadline: Deadline) -> Result<Found, Fault> {
        json(send(self.call(Method::GET, &host_path(id, ""), deadline)?).await?).await
    }

    /// `POST /v1/sandboxes`: its job.
    pub async fn create(&self, create: &Create<'_>, deadline: Deadline) -> Result<Job, Fault> {
        let request = self
            .call(Method::POST, "/v1/sandboxes", deadline)?
            .json(create);
        json(send(request).await?).await
    }

    /// `POST /v1/sandboxes/:id/fork`: its job.
    pub async fn fork(
        &self,
        id: &str,
        metadata: &BTreeMap<String, String>,
        deadline: Deadline,
    ) -> Result<Job, Fault> {
        let request = self
            .call(Method::POST, &host_path(id, "fork"), deadline)?
            .json(&serde_json::json!({ "metadata": metadata }));
        json(send(request).await?).await
    }

    /// `POST /v1/sandboxes/:id/{action}` with an empty body: `pause`, `resume`. Atelier
    /// answers once it is done.
    pub async fn act(&self, id: &str, action: &str, deadline: Deadline) -> Result<(), Fault> {
        let request = self
            .call(Method::POST, &host_path(id, action), deadline)?
            .json(&serde_json::json!({}));
        send(request).await.map(drop)
    }

    pub async fn delete(&self, id: &str, deadline: Deadline) -> Result<(), Fault> {
        send(self.call(Method::DELETE, &host_path(id, ""), deadline)?)
            .await
            .map(drop)
    }

    /// `PATCH /v1/sandboxes/:id/files`: one text file.
    pub async fn write(&self, id: &str, file: &File<'_>, deadline: Deadline) -> Result<(), Fault> {
        let request = self
            .call(Method::PATCH, &host_path(id, "files"), deadline)?
            .json(&[file]);
        send(request).await.map(drop)
    }

    /// `POST /v1/sandboxes/:id/exec`: `command` run by `sh` as the host's user.
    pub async fn exec(&self, id: &str, command: &str, deadline: Deadline) -> Result<Ran, Fault> {
        let within = deadline.within()?;
        let request = self
            .call(Method::POST, &host_path(id, "exec"), deadline)?
            .json(&serde_json::json!({
                "command": command,
                "timeoutMs": within.as_millis().min(30_000) as u64,
            }));
        json(send(request).await?).await
    }

    /// The image Atelier makes a host from where none is named: its `sandbox.defaultImage`.
    pub async fn default_image(&self, deadline: Deadline) -> Result<String, Fault> {
        let settings: Vec<Setting> =
            json(send(self.call(Method::GET, "/api/config", deadline)?).await?).await?;
        settings
            .into_iter()
            .find(|setting| setting.key == "sandbox.defaultImage")
            .and_then(|setting| setting.value.as_str().map(str::to_owned))
            .filter(|image| !image.is_empty())
            .ok_or_else(|| Fault::Failed("the server names no sandbox.defaultImage".into()))
    }

    /// Registers `public` (one OpenSSH line) as one of the caller's SSH keys, where it is
    /// not one already.
    pub async fn register(&self, public: &str, deadline: Deadline) -> Result<(), Fault> {
        let held: Vec<SshKey> =
            json(send(self.call(Method::GET, "/api/ssh-keys", deadline)?).await?).await?;
        if held.iter().any(|key| same_key(&key.public_key, public)) {
            return Ok(());
        }
        let request =
            self.call(Method::POST, "/api/ssh-keys", deadline)?
                .json(&serde_json::json!({
                    "publicKey": public,
                    "name": "steery",
                    "type": "generated",
                }));
        send(request).await.map(drop)
    }

    /// Reads job `id` until it is done; the host it made once it succeeded.
    pub async fn finish(&self, job: Job, deadline: Deadline) -> Result<String, Fault> {
        let host = job.host()?;
        let mut job = job;
        loop {
            match job.status.as_str() {
                "succeeded" => return Ok(host),
                "failed" | "canceled" => {
                    let why = job.error.as_deref().unwrap_or("no reason given");
                    return Err(Fault::Failed(format!(
                        "making host {host} {}: {why}",
                        job.status
                    )));
                }
                _ => {}
            }
            let Some(left) = deadline.left() else {
                return Err(Fault::TimedOut(format!(
                    "job {} still {} after {} s",
                    job.id,
                    job.status,
                    deadline.seconds()
                )));
            };
            tokio::time::sleep(POLL.min(left)).await;
            let path = format!("/v1/jobs/{}", escape(&job.id));
            job = json(send(self.call(Method::GET, &path, deadline)?).await?).await?;
        }
    }

    /// Reads `id` until it is `running`; `error` fails.
    pub async fn running(&self, id: &str, deadline: Deadline) -> Result<String, Fault> {
        loop {
            let found = self.get(id, deadline).await?;
            match found.status.as_str() {
                "running" => return Ok(found.status),
                "error" => {
                    return Err(Fault::Failed(format!("host {id} is in error")));
                }
                _ => {}
            }
            let Some(left) = deadline.left() else {
                return Err(Fault::TimedOut(format!(
                    "host {id} still {} after {} s, not running",
                    found.status,
                    deadline.seconds()
                )));
            };
            tokio::time::sleep(POLL.min(left)).await;
        }
    }
}

/// Whether two OpenSSH public key lines are one key: their type and data, whatever the
/// comment.
fn same_key(a: &str, b: &str) -> bool {
    let words = |line: &str| {
        line.split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ")
    };
    words(a) == words(b)
}

/// `text` as one URL path segment.
fn escape(text: &str) -> String {
    text.bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// The path of host `id`, and of its `action` where one is named.
fn host_path(id: &str, action: &str) -> String {
    let id = escape(id);
    if action.is_empty() {
        format!("/v1/sandboxes/{id}")
    } else {
        format!("/v1/sandboxes/{id}/{action}")
    }
}

/// Sends `request`; an answer outside 2xx is a fault, with Atelier's own message.
async fn send(request: RequestBuilder) -> Result<Response, Fault> {
    let response = request.send().await.map_err(transport)?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    let message = said(&body).unwrap_or_else(|| {
        let reason = status.canonical_reason().unwrap_or("error");
        if body.trim().is_empty() {
            reason.to_owned()
        } else {
            body
        }
    });
    Err(fault(status, message))
}

/// The fault an answer outside 2xx is, `message` being what Atelier said.
fn fault(status: StatusCode, message: String) -> Fault {
    let line = format!("{message} (HTTP {})", status.as_u16());
    match status {
        StatusCode::NOT_FOUND => Fault::NotFound(line),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Fault::KeyRefused {
            status: status.as_u16(),
            said: message,
        },
        StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT => {
            Fault::Offline(line)
        }
        _ => Fault::Failed(line),
    }
}

/// The `message` of an Atelier error body (`{error, message}`).
fn said(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("message")?
        .as_str()
        .map(str::to_owned)
}

async fn json<T: DeserializeOwned>(response: Response) -> Result<T, Fault> {
    let body = response.bytes().await.map_err(transport)?;
    serde_json::from_slice(&body)
        .map_err(|e| Fault::Failed(format!("an answer that does not read: {e}")))
}

/// A request that got no answer: Atelier not reached, or not answering in its time; both
/// are Atelier down.
fn transport(error: reqwest::Error) -> Fault {
    let line = chain(&error);
    if error.is_timeout() {
        Fault::Offline(format!("{line} (no answer in time)"))
    } else if error.is_connect() || error.is_request() {
        Fault::Offline(line)
    } else {
        Fault::Failed(line)
    }
}

/// An error with every cause under it, which reqwest keeps apart.
fn chain(error: &dyn std::error::Error) -> String {
    let mut line = error.to_string();
    let mut cause = error.source();
    while let Some(inner) = cause {
        line.push_str(": ");
        line.push_str(&inner.to_string());
        cause = inner.source();
    }
    line
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpListener;

    /// An Atelier on localhost that answers each request with what `answer` gives for its
    /// request line (`GET /v1/sandboxes?metadata=…`): a status and a body, or none to take
    /// the request and never answer. Its URL.
    pub async fn atelier_answering(
        answer: impl Fn(&str) -> Option<(u16, String)> + Send + 'static,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = Vec::new();
                let mut chunk = [0u8; 4096];
                while !request.windows(4).any(|end| end == b"\r\n\r\n") {
                    match socket.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&chunk[..read]),
                    }
                }
                let text = String::from_utf8_lossy(&request);
                let line = text.lines().next().unwrap_or("");
                let line = line.rsplit_once(' ').map_or(line, |(line, _)| line);
                match answer(line) {
                    Some((status, body)) => {
                        let reply = format!(
                            "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = socket.write_all(reply.as_bytes()).await;
                    }
                    None => held.push(socket),
                }
            }
        });
        url
    }

    async fn fault_of(status: Option<u16>) -> Fault {
        let url = atelier_answering(move |_| {
            status.map(|status| (status, r#"{"error":"X","message":"said"}"#.to_owned()))
        })
        .await;
        let atelier = Atelier::new(&url, "atl_x".into()).unwrap();
        atelier.get("s", Deadline::after(1)).await.unwrap_err()
    }

    #[tokio::test]
    async fn atelier_down_behind_its_gateway_is_offline() {
        for status in [502, 503, 504] {
            let fault = fault_of(Some(status)).await;
            assert!(
                matches!(&fault, Fault::Offline(line) if line == &format!("said (HTTP {status})")),
                "{fault:?}"
            );
        }
        let fault = fault_of(None).await;
        assert!(
            matches!(&fault, Fault::Offline(line) if line.ends_with("(no answer in time)")),
            "{fault:?}"
        );
    }

    #[tokio::test]
    async fn a_refused_key_and_other_answers_read_as_their_faults() {
        for status in [401, 403] {
            let fault = fault_of(Some(status)).await;
            assert!(
                matches!(&fault, Fault::KeyRefused { status: got, said } if *got == status && said == "said"),
                "{fault:?}"
            );
        }
        assert!(matches!(fault_of(Some(404)).await, Fault::NotFound(_)));
        assert!(matches!(fault_of(Some(409)).await, Fault::Failed(_)));
    }

    #[test]
    fn a_key_is_the_same_whatever_its_comment() {
        assert!(same_key(
            "ssh-ed25519 AAAA steery",
            "ssh-ed25519 AAAA other\n"
        ));
        assert!(!same_key("ssh-ed25519 AAAA", "ssh-ed25519 BBBB"));
    }

    #[test]
    fn the_server_name_is_read_from_its_url() {
        let name = |url: &str| {
            Atelier::new(url, "k".into())
                .unwrap()
                .host_name()
                .to_owned()
        };
        assert_eq!(name("https://atelier.example.com"), "atelier.example.com");
        assert_eq!(name("http://localhost:3000/"), "localhost");
        assert!(Atelier::new("atelier.example.com", "k".into()).is_err());
    }
}
