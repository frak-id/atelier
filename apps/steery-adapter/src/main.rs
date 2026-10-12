//! Atelier's adapter for Steery. It provides `hosts` (Steery's PROTOCOL.md §3.2, §5.2) on Atelier,
//! through Atelier's REST API. Atelier's own words for a host (its API paths) stay inside
//! [`api`], which names the items around them by Steery's.
//!
//! Its client is built from the settings `initialize` passes, and from nothing else: the
//! host, its image, toolboxes, secrets and network are the person's and Atelier's, so no
//! host is given an image, environment, secret or network setting of the adapter's own.
//! The one thing it keeps is the SSH key its channels authenticate with, made once in its
//! folder under the runtime's config folder and registered as one of the API key's user's
//! SSH keys.

mod api;

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::Engine;
use parking_lot::Mutex;
use serde_json::Value;
use steery_sdk::wire::{self, hosts};
use steery_sdk::{Error, PROTOCOL, Program, method, refusal};
use tokio::io::AsyncWriteExt as _;

use api::{Atelier, Create, Deadline, Fault, File, Source};

/// The label every host this adapter makes carries, and every list is filtered by.
const MINE: (&str, &str) = ("steery", "host");
/// The label that finds a host again by the runtime's key.
const KEY_LABEL: &str = "steery-key";
/// Seconds the adapter waits for Atelier, inside the runtime's bounds (§9: 300 s, 60 s).
const LONG_SECONDS: u64 = 280;
const CHANGE_SECONDS: u64 = 55;
/// The user a host's files are written as: the one SSH and `exec` run as.
const OWNER: &str = "dev";
/// The longest line a refusal carries.
const LINE_CHARS: usize = 300;

#[tokio::main(flavor = "current_thread")]
async fn main() -> io::Result<()> {
    steery_sdk::serve(|_notifier| Adapter::default()).await
}

/// The adapter: an Atelier client once `initialize` gave a URL and an API key, and none
/// before; its SSH key's folder; whether this computer has the OpenSSH client its channels
/// run; and one lock per key a `hosts/ensure` runs for.
#[derive(Default)]
struct Adapter {
    atelier: OnceLock<Result<Atelier, String>>,
    folder: OnceLock<PathBuf>,
    ssh: OnceLock<bool>,
    key: tokio::sync::Mutex<Option<PathBuf>>,
    keys: Keys,
}

/// Why no channel can be had here: Atelier's runs `ssh` on the controlling computer, and
/// waiting does not install one. Said by `initialize` as `unavailable` (PROTOCOL.md §3.2),
/// so the machine is never added where it cannot work, and by `hosts/channel` and
/// `hosts/list` as the guard where it is used.
const NO_SSH: &str = "Atelier's channel runs `ssh` and `ssh-keygen` on this computer, and they are not installed: install an OpenSSH client (e.g. apt install openssh-client)";

/// One lock per key a `hosts/ensure` runs for: two ensures for one key in this process
/// run one after the other, so the second finds what the first made.
#[derive(Default)]
struct Keys(Mutex<BTreeMap<String, Arc<tokio::sync::Mutex<()>>>>);

impl Keys {
    fn of(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.0.lock().entry(key.to_owned()).or_default().clone()
    }

    /// Forget `key`'s lock once no other ensure holds or waits for it.
    fn release(&self, key: &str, lock: Arc<tokio::sync::Mutex<()>>) {
        let mut keys = self.0.lock();
        if Arc::strong_count(&lock) == 2 {
            keys.remove(key);
        }
    }
}

impl Adapter {
    /// `ssh` and `ssh-keygen` are on `PATH`, as found when the adapter was initialized.
    fn reach(&self) -> Result<(), Error> {
        let found = *self.ssh.get_or_init(|| {
            std::env::var_os("PATH")
                .is_some_and(|path| ["ssh", "ssh-keygen"].iter().all(|name| within(&path, name)))
        });
        found
            .then_some(())
            .ok_or_else(|| Error::refused(refusal::REFUSED, NO_SSH))
    }

    fn atelier(&self) -> Result<&Atelier, Error> {
        match self.atelier.get() {
            Some(Ok(atelier)) => Ok(atelier),
            Some(Err(why)) => Err(Error::refused(refusal::REFUSED, format!("Atelier: {why}"))),
            None => Err(Error::refused(refusal::REFUSED, "Atelier: not initialized")),
        }
    }

    /// The private key a channel authenticates with: made once in the adapter's folder
    /// with `ssh-keygen`, and registered as one of the API key's user's SSH keys once per
    /// run, so a key removed in Atelier's console is registered again.
    async fn identity(&self, atelier: &Atelier, deadline: Deadline) -> Result<PathBuf, Error> {
        let mut held = self.key.lock().await;
        if let Some(path) = held.as_ref() {
            return Ok(path.clone());
        }
        let folder = self
            .folder
            .get()
            .ok_or_else(|| Error::refused(refusal::REFUSED, "Atelier: not initialized"))?;
        let path = folder.join("id_ed25519");
        let public = made_key(&path).await?;
        atelier
            .register(&public, deadline)
            .await
            .map_err(|fault| refuse(atelier, fault, refusal::REFUSED))?;
        *held = Some(path.clone());
        Ok(path)
    }
}

/// Whether a folder of `path` (as `PATH` spells it) holds an executable `name`.
fn within(path: &std::ffi::OsStr, name: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::env::split_paths(path).any(|dir| {
        std::fs::metadata(dir.join(name))
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    })
}

/// The public line of the ed25519 key at `path`, made there first where none is.
async fn made_key(path: &Path) -> Result<String, Error> {
    let public = path.with_extension("pub");
    if !path.exists() {
        let folder = path.parent().unwrap_or(path);
        std::fs::create_dir_all(folder).map_err(|e| {
            Error::refused(
                refusal::REFUSED,
                format!("Atelier: making {}: {e}", folder.display()),
            )
        })?;
        let _ = std::fs::remove_file(&public);
        let made = tokio::process::Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", "steery", "-f"])
            .arg(path)
            .stdin(Stdio::null())
            .output()
            .await
            .map_err(|e| Error::refused(refusal::REFUSED, format!("Atelier: ssh-keygen: {e}")))?;
        if !made.status.success() {
            return Err(Error::refused(
                refusal::REFUSED,
                format!(
                    "Atelier: ssh-keygen failed: {}",
                    String::from_utf8_lossy(&made.stderr).trim()
                ),
            ));
        }
    }
    std::fs::read_to_string(&public)
        .map(|line| line.trim().to_owned())
        .map_err(|e| {
            Error::refused(
                refusal::REFUSED,
                format!("Atelier: reading {}: {e}", public.display()),
            )
        })
}

impl Program for Adapter {
    fn initialize(&self, params: &wire::InitializeParams) -> Result<wire::Initialized, Error> {
        if !params.protocol.contains(&PROTOCOL) {
            return Err(Error::invalid(format!(
                "this adapter speaks protocol {PROTOCOL} only"
            )));
        }
        let given = |name: &str| params.settings.get(name).filter(|value| !value.is_empty());
        let atelier = match (given("ATELIER_URL"), given("ATELIER_API_KEY")) {
            (Some(url), Some(key)) => Atelier::new(url, key.clone()),
            (None, _) => Err("no URL was given: give ATELIER_URL".to_owned()),
            (_, None) => Err("no API key was given: give ATELIER_API_KEY".to_owned()),
        };
        let _ = self.atelier.set(atelier);
        let _ = self.folder.set(params.config.join("atelier"));
        // Said up front (PROTOCOL.md §3.2), so no machine is added where its channel cannot
        // run; the channel and the list still refuse, as the guard where it is used.
        let unavailable = self.reach().err().map(|_| NO_SSH.to_owned());
        Ok(wire::Initialized {
            protocol: PROTOCOL,
            program: wire::ProgramInfo {
                id: "atelier".parse().map_err(Error::invalid)?,
                kind: wire::Kind::Machine,
                release: env!("CARGO_PKG_VERSION").into(),
                label: "Atelier".into(),
                short: "At".into(),
                tint: None,
                mark: None,
            },
            harness: None,
            machine: Some(wire::Machine::Hosts(wire::HostFacts {
                keeps: wire::Survives::Filesystem,
                persist: None,
                idle: wire::Idle::None,
                optional: vec![wire::Optional::Pause, wire::Optional::Fork],
                channel: wire::Channel::Argv,
                os: wire::Os::Linux,
                unavailable,
            })),
            settings: vec![
                setting(
                    "ATELIER_URL",
                    false,
                    true,
                    "Your Atelier server's URL: https://atelier.example.com",
                ),
                setting(
                    "ATELIER_API_KEY",
                    true,
                    true,
                    "An Atelier API key (atl_…), from your console's API keys",
                ),
            ],
        })
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, Error> {
        use steery_sdk::{params as given, result};
        match method {
            method::HOSTS_LIST => {
                self.reach()?;
                result(list(self.atelier()?, given(params)?).await?)
            }
            method::HOSTS_ENSURE => {
                let asked: hosts::Ensure = given(params)?;
                let atelier = self.atelier()?;
                let key = asked.key.clone();
                let lock = self.keys.of(&key);
                let answer = {
                    let _held = lock.lock().await;
                    ensure(self, atelier, asked).await
                };
                self.keys.release(&key, lock);
                result(answer?)
            }
            method::HOSTS_START => result(start(self.atelier()?, given(params)?).await?),
            method::HOSTS_STOP | method::HOSTS_PAUSE => {
                result(pause(self.atelier()?, given(params)?).await?)
            }
            method::HOSTS_DELETE => result(delete(self.atelier()?, given(params)?).await?),
            method::HOSTS_FORK => result(fork(self, self.atelier()?, given(params)?).await?),
            method::HOSTS_PUT => result(put(self, self.atelier()?, given(params)?).await?),
            method::HOSTS_CHANNEL => {
                self.reach()?;
                result(channel(self, self.atelier()?, given(params)?).await?)
            }
            _ => Err(Error::Unknown),
        }
    }
}

fn setting(name: &str, secret: bool, required: bool, about: &str) -> wire::Setting {
    wire::Setting {
        name: name.into(),
        secret,
        required,
        about: about.into(),
    }
}

/// The refusal a fault is; `otherwise` where it is none of not found, key, down or time.
/// A refused key is `refused`, never `offline`: it does not heal by waiting, and its line
/// names the setting to give again. Its line never holds the API key.
fn refuse(atelier: &Atelier, fault: Fault, otherwise: &'static str) -> Error {
    let (word, line) = match fault {
        Fault::NotFound(line) => (refusal::NOT_FOUND, format!("Atelier: {line}")),
        Fault::KeyRefused { status, said } => (
            refusal::REFUSED,
            format!(
                "Atelier refused the API key (HTTP {status}: {said}): give ATELIER_API_KEY again"
            ),
        ),
        Fault::Offline(line) => (refusal::OFFLINE, format!("Atelier: {line}")),
        // Atelier answered, and the host was not there in time.
        Fault::TimedOut(line) => (refusal::REFUSED, format!("Atelier: {line} (timed out)")),
        Fault::Failed(line) => (otherwise, format!("Atelier: {line}")),
    };
    Error::refused(word, one_line(atelier.key(), &line))
}

/// `text` on one line, without `key`, at most [`LINE_CHARS`] characters.
fn one_line(key: &str, text: &str) -> String {
    let text = text.replace(key, "[redacted]");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    match text.char_indices().nth(LINE_CHARS - 1) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text,
    }
}

/// A host's id, never empty.
fn named(id: &str) -> Result<&str, Error> {
    if id.is_empty() {
        Err(Error::invalid("host must be a non-empty string"))
    } else {
        Ok(id)
    }
}

/// Milliseconds since 1970 of a time Atelier writes (RFC 3339); 0 where it is none.
fn millis(at: Option<&str>) -> u64 {
    at.and_then(|at| {
        time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339).ok()
    })
    .and_then(|at| u64::try_from(at.unix_timestamp_nanos() / 1_000_000).ok())
    .unwrap_or(0)
}

/// One argument as a POSIX shell reads it back.
fn quote(arg: &str) -> String {
    let plain = !arg.is_empty()
        && arg
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_/.:=@%+,-".contains(&byte));
    if plain {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', r"'\''"))
    }
}

async fn list(atelier: &Atelier, params: hosts::List) -> Result<hosts::Listed, Error> {
    let mut labels = params.labels.unwrap_or_default();
    labels.insert(MINE.0.into(), MINE.1.into());
    let found = atelier
        .list(&labels, Deadline::after(CHANGE_SECONDS))
        .await
        .map_err(|fault| refuse(atelier, fault, refusal::REFUSED))?;
    let hosts = found
        .into_iter()
        .map(|host| hosts::Host {
            created_at: millis(host.created_at.as_deref()),
            state: host.status,
            labels: host.metadata,
            host: host.id,
        })
        .collect();
    Ok(hosts::Listed { hosts })
}

/// The host made for `key`, or one made for it now from the source asked, or from
/// Atelier's default image, and running.
///
/// Atelier takes no name to make a host by, and a host it is making is listed only once
/// its source is resolved; so ensures for one key run one after the other in this
/// adapter, and after making one it lists the key again: the oldest host is the key's, and
/// a younger one made here is deleted.
async fn ensure(
    adapter: &Adapter,
    atelier: &Atelier,
    params: hosts::Ensure,
) -> Result<hosts::Named, Error> {
    if params.key.is_empty() {
        return Err(Error::invalid("key must be a non-empty string"));
    }
    let deadline = Deadline::after(LONG_SECONDS);
    let fail = |fault| refuse(atelier, fault, refusal::REFUSED);
    let mine = BTreeMap::from([
        (MINE.0.to_owned(), MINE.1.to_owned()),
        (KEY_LABEL.to_owned(), params.key.clone()),
    ]);
    if let Some(found) = oldest(&atelier.list(&mine, deadline).await.map_err(fail)?) {
        return Ok(hosts::Named { host: found });
    }
    // Registered before the host is made, so a host whose sshd takes its keys at boot
    // takes this one.
    adapter.identity(atelier, deadline).await?;
    let image;
    let source = match &params.source {
        Some(hosts::Source::Snapshot(snapshot)) => Source::Snapshot(snapshot),
        Some(hosts::Source::Image(reference)) => Source::Image(reference),
        None => {
            image = atelier.default_image(deadline).await.map_err(fail)?;
            Source::Image(&image)
        }
    };
    let mut metadata = params.labels;
    metadata.extend(mine.clone());
    let made = async {
        let job = atelier
            .create(
                &Create {
                    source,
                    metadata: &metadata,
                },
                deadline,
            )
            .await?;
        let host = atelier.finish(job, deadline).await?;
        atelier.running(&host, deadline).await?;
        Ok(host)
    };
    let made = made
        .await
        .map_err(|fault| refuse(atelier, fault, refusal::START_FAILED))?;
    let listed = match atelier.list(&mine, deadline).await {
        Ok(listed) => listed,
        Err(fault) => {
            eprintln!("atelier: listing the key again: {fault:?}");
            Vec::new()
        }
    };
    match oldest(&listed) {
        Some(kept) if kept != made => {
            if let Err(fault) = atelier.delete(&made, Deadline::after(CHANGE_SECONDS)).await {
                eprintln!("atelier: deleting the younger host {made}: {fault:?}");
            }
            Ok(hosts::Named { host: kept })
        }
        _ => Ok(hosts::Named { host: made }),
    }
}

/// The oldest host not in error; of two made at once, the one whose id sorts first.
fn oldest(found: &[api::Host]) -> Option<String> {
    found
        .iter()
        .filter(|host| host.status != "error")
        .min_by_key(|host| {
            let at = millis(host.created_at.as_deref());
            (if at == 0 { u64::MAX } else { at }, &host.id)
        })
        .map(|host| host.id.clone())
}

/// Start: resume a paused host (or one in error), wait for one being made, and answer a
/// running one as it is.
async fn start(atelier: &Atelier, params: hosts::Target) -> Result<hosts::State, Error> {
    let id = named(&params.host)?;
    let deadline = Deadline::after(LONG_SECONDS);
    let started = async {
        let found = atelier.get(id, deadline).await?;
        if matches!(found.status.as_str(), "paused" | "error" | "stopped") {
            atelier.act(id, "resume", deadline).await?;
        }
        atelier.running(id, deadline).await
    };
    let state = started
        .await
        .map_err(|fault| refuse(atelier, fault, refusal::START_FAILED))?;
    Ok(hosts::State { state })
}

/// Stop and pause are one: Atelier's pause snapshots the host's filesystem and frees its
/// machine, and its only stop that keeps the host. A host already paused is answered as
/// it is.
async fn pause(atelier: &Atelier, params: hosts::Target) -> Result<hosts::State, Error> {
    let id = named(&params.host)?;
    let deadline = Deadline::after(CHANGE_SECONDS);
    let paused = async {
        let found = atelier.get(id, deadline).await?;
        if found.status == "running" {
            atelier.act(id, "pause", deadline).await?;
            return Ok(atelier.get(id, deadline).await?.status);
        }
        Ok(found.status)
    };
    let state = paused
        .await
        .map_err(|fault| refuse(atelier, fault, refusal::REFUSED))?;
    Ok(hosts::State { state })
}

/// Atelier deletes a host and answers once it is gone.
async fn delete(atelier: &Atelier, params: hosts::Target) -> Result<hosts::State, Error> {
    let id = named(&params.host)?;
    atelier
        .delete(id, Deadline::after(CHANGE_SECONDS))
        .await
        .map_err(|fault| refuse(atelier, fault, refusal::REFUSED))?;
    Ok(hosts::State {
        state: "deleted".into(),
    })
}

/// A new host from a snapshot of `host`, with its spec and its labels but its key's: the
/// copy is no key's host, and no ensure finds it.
async fn fork(
    adapter: &Adapter,
    atelier: &Atelier,
    params: hosts::Target,
) -> Result<hosts::Named, Error> {
    let id = named(&params.host)?;
    let deadline = Deadline::after(CHANGE_SECONDS);
    let mut metadata = atelier
        .get(id, deadline)
        .await
        .map_err(|fault| refuse(atelier, fault, refusal::REFUSED))?
        .metadata;
    metadata.remove(KEY_LABEL);
    metadata.insert(MINE.0.to_owned(), MINE.1.to_owned());
    adapter.identity(atelier, deadline).await?;
    let forked = async {
        let job = atelier.fork(id, &metadata, deadline).await?;
        let host = atelier.finish(job, deadline).await?;
        atelier.running(&host, deadline).await?;
        Ok(host)
    };
    let host = forked
        .await
        .map_err(|fault| refuse(atelier, fault, refusal::START_FAILED))?;
    Ok(hosts::Named { host })
}

/// Writes the file. Text goes through Atelier's file write, whose size is then read back
/// in the host; anything else is carried over the channel into a file beside it, checked
/// whole, given its mode and renamed into place. A file that did not arrive whole is
/// removed before the put refuses.
async fn put(
    adapter: &Adapter,
    atelier: &Atelier,
    params: hosts::Put,
) -> Result<wire::Empty, Error> {
    let id = named(&params.host)?;
    let path = params
        .path
        .to_str()
        .filter(|path| Path::new(path).is_absolute())
        .ok_or_else(|| Error::invalid("path must be an absolute UTF-8 path"))?
        .to_owned();
    if params.mode > 0o7777 {
        return Err(Error::invalid("mode must be Unix mode bits"));
    }
    let content = base64::engine::general_purpose::STANDARD
        .decode(&params.content)
        .map_err(|e| Error::invalid(format!("content must be base64: {e}")))?;
    let deadline = Deadline::after(LONG_SECONDS);
    let fail = |fault| refuse(atelier, fault, refusal::REFUSED);
    let short = |why: String| {
        Error::refused(
            refusal::REFUSED,
            one_line(atelier.key(), &format!("Atelier: {why}")),
        )
    };
    let length = content.len();
    match String::from_utf8(content) {
        Ok(text) if !text.contains('\0') => {
            let file = File {
                path: &path,
                content: &text,
                mode: format!("{:o}", params.mode),
                owner: OWNER,
            };
            atelier.write(id, &file, deadline).await.map_err(fail)?;
            let quoted = quote(&path);
            let ran = atelier
                .exec(id, &format!("wc -c < {quoted}"), deadline)
                .await
                .map_err(fail)?;
            let written = ran.stdout.trim().parse::<usize>().ok();
            if ran.exit_code != 0 || written != Some(length) {
                let removed = atelier.exec(id, &format!("rm -f {quoted}"), deadline).await;
                return Err(short(format!(
                    "{path} had {} of {length} bytes written ({}); {}",
                    written.map_or("unknown".to_owned(), |n| n.to_string()),
                    ran.stderr.trim(),
                    if removed.is_ok() {
                        "removed it"
                    } else {
                        "could not remove it"
                    },
                )));
            }
            Ok(wire::Empty {})
        }
        Ok(text) => {
            carry(
                adapter,
                atelier,
                id,
                &path,
                text.into_bytes(),
                params.mode,
                deadline,
            )
            .await
        }
        Err(bytes) => {
            carry(
                adapter,
                atelier,
                id,
                &path,
                bytes.into_bytes(),
                params.mode,
                deadline,
            )
            .await
        }
    }
}

/// `content` written to `path` over the channel: into `<path>.steery-part`, its size
/// checked, its mode set and renamed into place; the part removed where any step fails.
async fn carry(
    adapter: &Adapter,
    atelier: &Atelier,
    id: &str,
    path: &str,
    content: Vec<u8>,
    mode: u32,
    deadline: Deadline,
) -> Result<wire::Empty, Error> {
    adapter.reach()?;
    let part = quote(&format!("{path}.steery-part"));
    let script = format!(
        "mkdir -p \"$(dirname {target})\" && cat > {part} && [ \"$(wc -c < {part} | tr -d ' ')\" = {length} ] && chmod {mode:o} {part} && mv -f {part} {target} || {{ rm -f {part}; exit 1; }}",
        target = quote(path),
        length = content.len(),
    );
    let argv = reach(
        adapter,
        atelier,
        id,
        &["sh".to_owned(), "-c".to_owned(), script],
        deadline,
    )
    .await?;
    let left = deadline.left().unwrap_or(Duration::ZERO);
    let ran = async {
        let mut child = tokio::process::Command::new(&argv[0])
            .args(&argv[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let mut stdin = child.stdin.take().expect("piped");
        stdin.write_all(&content).await?;
        drop(stdin);
        child.wait_with_output().await
    };
    let failed = match tokio::time::timeout(left, ran).await {
        Ok(Ok(output)) if output.status.success() => return Ok(wire::Empty {}),
        Ok(Ok(output)) => String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        Ok(Err(e)) => e.to_string(),
        Err(_) => format!("no answer in {} s", deadline.seconds()),
    };
    Err(Error::refused(
        refusal::REFUSED,
        one_line(
            atelier.key(),
            &format!(
                "Atelier: {path} was not written whole over SSH, and what arrived is removed: {failed}"
            ),
        ),
    ))
}

/// An argv channel: `ssh -T` to the host through Atelier's SSH gateway, with the
/// adapter's key, running `command` in the host.
async fn channel(
    adapter: &Adapter,
    atelier: &Atelier,
    params: hosts::Channel,
) -> Result<hosts::Reach, Error> {
    let id = named(&params.host)?;
    if params.command.is_empty() {
        return Err(Error::invalid(
            "command must be a non-empty array of strings",
        ));
    }
    let argv = reach(
        adapter,
        atelier,
        id,
        &params.command,
        Deadline::after(CHANGE_SECONDS),
    )
    .await?;
    Ok(hosts::Reach::Argv {
        argv,
        env: BTreeMap::new(),
    })
}

/// The `ssh` command that runs `command` in host `id`.
async fn reach(
    adapter: &Adapter,
    atelier: &Atelier,
    id: &str,
    command: &[String],
    deadline: Deadline,
) -> Result<Vec<String>, Error> {
    let found = atelier
        .get(id, deadline)
        .await
        .map_err(|fault| refuse(atelier, fault, refusal::REFUSED))?;
    let key = adapter.identity(atelier, deadline).await?;
    let (user, host, port) = gateway(found.ssh(), &found.id, atelier.host_name());
    let mut argv: Vec<String> = vec!["ssh".into(), "-T".into(), "-i".into()];
    argv.push(key.to_string_lossy().into_owned());
    argv.extend(
        [
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=accept-new",
        ]
        .map(String::from),
    );
    if let Some(port) = port {
        argv.extend(["-p".to_owned(), port]);
    }
    argv.push(format!("{user}@{host}"));
    argv.push(
        command
            .iter()
            .map(|arg| quote(arg))
            .collect::<Vec<_>>()
            .join(" "),
    );
    Ok(argv)
}

/// The user, host and port of the SSH URL Atelier gives a host: `ssh <id>@<host> [-p
/// <port>]` behind its gateway, or `ssh://<user>@<host>:<port>` to a host's own sshd. Where
/// it gives none: the host's id at `ATELIER_URL`'s host, on port 22.
fn gateway(url: Option<&str>, id: &str, server: &str) -> (String, String, Option<String>) {
    let url = url.unwrap_or("").trim();
    if let Some(rest) = url.strip_prefix("ssh://") {
        let rest = rest.split('/').next().unwrap_or(rest);
        let (user, at) = rest.rsplit_once('@').unwrap_or((id, rest));
        let (host, port) = match at.rsplit_once(':') {
            Some((host, port)) if !port.is_empty() => (host, Some(port.to_owned())),
            _ => (at, None),
        };
        return (user.to_owned(), host.to_owned(), port);
    }
    let words: Vec<&str> = url.split_whitespace().collect();
    let (user, host) = words
        .iter()
        .skip(1)
        .find_map(|word| word.rsplit_once('@'))
        .filter(|(user, host)| !user.is_empty() && !host.is_empty())
        .unwrap_or((id, server));
    let port = words
        .iter()
        .position(|word| *word == "-p")
        .and_then(|at| words.get(at + 1))
        .map(|port| (*port).to_owned());
    (user.to_owned(), host.to_owned(), port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_what_a_shell_would_split() {
        assert_eq!(quote("/usr/bin/steery"), "/usr/bin/steery");
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote(""), "''");
    }

    #[test]
    fn reads_the_gateway_from_ateliers_ssh_url() {
        assert_eq!(
            gateway(Some("ssh abc@ssh.atelier.dev"), "abc", "atelier.dev"),
            ("abc".into(), "ssh.atelier.dev".into(), None)
        );
        assert_eq!(
            gateway(
                Some("ssh abc@ssh.atelier.dev -p 2222"),
                "abc",
                "atelier.dev"
            ),
            ("abc".into(), "ssh.atelier.dev".into(), Some("2222".into()))
        );
        assert_eq!(
            gateway(Some("ssh://dev@127.0.0.1:32768"), "abc", "localhost"),
            ("dev".into(), "127.0.0.1".into(), Some("32768".into()))
        );
        assert_eq!(
            gateway(None, "abc", "atelier.dev"),
            ("abc".into(), "atelier.dev".into(), None)
        );
    }

    #[test]
    fn keeps_the_key_out_of_a_line() {
        assert_eq!(
            one_line("atl_k", "Atelier: bad  key atl_k\nhere"),
            "Atelier: bad key [redacted] here"
        );
    }

    #[test]
    fn the_keys_host_is_the_oldest_not_in_error() {
        let host = |id: &str, status: &str, at: &str| api::Host {
            id: id.into(),
            status: status.into(),
            created_at: Some(at.into()),
            metadata: BTreeMap::new(),
        };
        let found = [
            host("b", "running", "2026-10-11T10:00:01Z"),
            host("a", "error", "2026-10-11T10:00:00Z"),
            host("c", "creating", "2026-10-11T10:00:01Z"),
        ];
        assert_eq!(oldest(&found).as_deref(), Some("b"));
        assert_eq!(oldest(&[]), None);
    }

    /// `text` with `%XX` read back, as a query value is sent.
    fn unescaped(text: &str) -> String {
        let bytes = text.as_bytes();
        let mut out = Vec::new();
        let mut at = 0;
        while at < bytes.len() {
            match bytes[at] {
                b'%' if at + 2 < bytes.len() => {
                    let hex = std::str::from_utf8(&bytes[at + 1..at + 3]).unwrap();
                    out.push(u8::from_str_radix(hex, 16).unwrap());
                    at += 3;
                }
                b'+' => {
                    out.push(b' ');
                    at += 1;
                }
                byte => {
                    out.push(byte);
                    at += 1;
                }
            }
        }
        String::from_utf8(out).unwrap()
    }

    /// The metadata filter a `GET /v1/sandboxes` request line sends.
    fn filter_of(line: &str) -> Option<BTreeMap<String, String>> {
        let query = line.strip_prefix("GET /v1/sandboxes?")?;
        let value = query.strip_prefix("metadata=")?;
        serde_json::from_str(&unescaped(value)).ok()
    }

    #[tokio::test]
    async fn a_list_asks_for_steerys_hosts_with_the_labels_asked_and_reads_them() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let held = seen.clone();
        let url = api::tests::atelier_answering(move |line| {
            held.lock().push(filter_of(line));
            Some((
                200,
                r#"[{"id":"s1","status":"paused","createdAt":"2024-10-01T12:00:00.000Z","metadata":{"steery":"host","steery-machine":"m"},"annotations":{}}]"#.to_owned(),
            ))
        })
        .await;
        let atelier = Atelier::new(&url, "atl_k".into()).unwrap();
        let labels = BTreeMap::from([("steery-machine".to_owned(), "m".to_owned())]);
        let listed = list(
            &atelier,
            hosts::List {
                labels: Some(labels),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            listed.hosts,
            vec![hosts::Host {
                host: "s1".into(),
                state: "paused".into(),
                labels: BTreeMap::from([
                    ("steery".to_owned(), "host".to_owned()),
                    ("steery-machine".to_owned(), "m".to_owned()),
                ]),
                created_at: 1_727_784_000_000,
            }]
        );
        assert_eq!(
            seen.lock().as_slice(),
            [Some(BTreeMap::from([
                ("steery".to_owned(), "host".to_owned()),
                ("steery-machine".to_owned(), "m".to_owned()),
            ]))]
        );
    }

    #[tokio::test]
    async fn an_ensure_finds_the_keys_host_without_making_one() {
        let url = api::tests::atelier_answering(|line| {
            let filter = filter_of(line)?;
            assert_eq!(filter.get(KEY_LABEL).map(String::as_str), Some("k1"));
            Some((
                200,
                r#"[{"id":"s9","status":"paused","createdAt":"2024-10-01T12:00:00Z","metadata":{}}]"#.to_owned(),
            ))
        })
        .await;
        let adapter = Adapter::default();
        let atelier = Atelier::new(&url, "atl_k".into()).unwrap();
        let asked = hosts::Ensure {
            key: "k1".into(),
            source: None,
            labels: BTreeMap::new(),
        };
        assert_eq!(
            ensure(&adapter, &atelier, asked).await.unwrap(),
            hosts::Named { host: "s9".into() }
        );
    }

    /// The refusal word and line `hosts/list` answers against an Atelier answering
    /// `status` with `body`.
    async fn listed(status: u16, body: &'static str) -> (String, String) {
        let url = api::tests::atelier_answering(move |_| Some((status, body.to_owned()))).await;
        let atelier = Atelier::new(&url, "atl_secret".into()).unwrap();
        match list(&atelier, hosts::List { labels: None }).await {
            Err(Error::Refused { word, line }) => (word, line.unwrap_or_default()),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn a_refused_key_is_refused_and_names_the_setting_to_give_again() {
        assert_eq!(
            listed(401, r#"{"error":"UNAUTHORIZED","message":"Invalid token atl_secret"}"#).await,
            (
                refusal::REFUSED.to_owned(),
                "Atelier refused the API key (HTTP 401: Invalid token [redacted]): give ATELIER_API_KEY again"
                    .to_owned()
            )
        );
        let (word, _) = listed(403, r#"{"error":"FORBIDDEN","message":"no"}"#).await;
        assert_eq!(word, refusal::REFUSED);
    }

    #[tokio::test]
    async fn atelier_down_is_offline_and_a_missing_host_not_found() {
        for status in [502, 503, 504] {
            let (word, line) = listed(status, "").await;
            assert_eq!(word, refusal::OFFLINE, "{line}");
        }
        let url = api::tests::atelier_answering(|_| {
            Some((
                404,
                r#"{"error":"NOT_FOUND","message":"Sandbox 'x' not found"}"#.to_owned(),
            ))
        })
        .await;
        let atelier = Atelier::new(&url, "atl_k".into()).unwrap();
        match start(&atelier, hosts::Named { host: "x".into() }).await {
            Err(Error::Refused { word, .. }) => assert_eq!(word, refusal::NOT_FOUND),
            other => panic!("{other:?}"),
        }
    }

    /// Without `ssh` on this computer no channel can be had, so `hosts/channel` and
    /// `hosts/list` refuse `refused`, saying what to install, before asking Atelier
    /// anything; and `initialize` says so up front.
    #[tokio::test]
    async fn without_an_ssh_client_a_channel_is_refused_saying_what_to_install() {
        let without = Adapter {
            ssh: OnceLock::from(false),
            ..Adapter::default()
        };
        for (method, params) in [
            (method::HOSTS_LIST, serde_json::json!({})),
            (
                method::HOSTS_CHANNEL,
                serde_json::json!({"host": "s", "command": ["steery", "host", "attach"]}),
            ),
        ] {
            match without.call(method, params).await {
                Err(Error::Refused { word, line }) => {
                    assert_eq!(
                        (word.as_str(), line.as_deref()),
                        (refusal::REFUSED, Some(NO_SSH))
                    )
                }
                other => panic!("{method}: {other:?}"),
            }
        }
        let params: wire::InitializeParams = serde_json::from_value(serde_json::json!({
            "protocol": [PROTOCOL],
            "runtime": {"release": "7.0.0", "os": "linux", "arch": "x86_64"},
            "home": "/home/p", "config": "/home/p/.config/steery",
        }))
        .unwrap();
        match without.initialize(&params).unwrap().machine {
            Some(wire::Machine::Hosts(facts)) => {
                assert_eq!(facts.unavailable.as_deref(), Some(NO_SSH))
            }
            other => panic!("{other:?}"),
        }
    }
}
