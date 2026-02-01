use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Request, Response};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::process::Command;

use crate::config::DEFAULT_EXEC_TIMEOUT_MS;
use crate::response::json_ok;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoRef {
    clone_path: String,
}

#[derive(Deserialize)]
struct MultiRepoBody {
    repos: Vec<RepoRef>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitBody {
    repo_path: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushBody {
    repo_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitRepoStatus {
    path: String,
    branch: Option<String>,
    dirty: bool,
    ahead: u32,
    behind: u32,
    last_commit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct GitStatusResponse {
    repos: Vec<GitRepoStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffFile {
    path: String,
    added: u32,
    removed: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffRepo {
    path: String,
    files: Vec<GitDiffFile>,
    total_added: u32,
    total_removed: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct GitDiffResponse {
    repos: Vec<GitDiffRepo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommitResponse {
    path: String,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitPushResponse {
    path: String,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn read_body(req: Request<hyper::body::Incoming>) -> Result<Bytes, hyper::Error> {
    Ok(req.collect().await?.to_bytes())
}

async fn run_as_dev(cmd: &str) -> (i32, String, String) {
    let timeout = Duration::from_millis(DEFAULT_EXEC_TIMEOUT_MS);
    let result = tokio::time::timeout(timeout, async {
        Command::new("su")
            .args(["-", "dev", "-c", cmd])
            .output()
            .await
    })
    .await;

    match result {
        Ok(Ok(output)) => (
            output.status.code().unwrap_or(1),
            String::from_utf8_lossy(&output.stdout).to_string(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        ),
        Ok(Err(e)) => (1, String::new(), e.to_string()),
        Err(_) => (1, String::new(), "Command timed out".to_string()),
    }
}

fn full_path(clone_path: &str) -> String {
    format!("/home/dev{clone_path}")
}

async fn get_repo_status(clone_path: String) -> GitRepoStatus {
    let path = full_path(&clone_path);

    let (code, _, _) = run_as_dev(&format!("git -C '{path}' rev-parse --git-dir")).await;
    if code != 0 {
        return GitRepoStatus {
            path: clone_path,
            branch: None,
            dirty: false,
            ahead: 0,
            behind: 0,
            last_commit: None,
            error: Some("Not a git repository".to_string()),
        };
    }

    let (_, branch_out, _) =
        run_as_dev(&format!("git -C '{path}' branch --show-current")).await;
    let branch = branch_out.trim().to_string();

    let (_, dirty_out, _) =
        run_as_dev(&format!("git -C '{path}' status --porcelain | head -1")).await;
    let dirty = !dirty_out.trim().is_empty();

    let (ab_code, ab_out, _) = run_as_dev(&format!(
        "git -C '{path}' rev-list --left-right --count HEAD...@{{upstream}}"
    ))
    .await;
    let (ahead, behind) = if ab_code == 0 {
        let parts: Vec<&str> = ab_out.trim().split_whitespace().collect();
        (
            parts.first().and_then(|s| s.parse().ok()).unwrap_or(0u32),
            parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0u32),
        )
    } else {
        (0, 0)
    };

    let (_, commit_out, _) =
        run_as_dev(&format!("git -C '{path}' log -1 --format='%h %s'")).await;
    let commit = commit_out.trim().to_string();

    GitRepoStatus {
        path: clone_path,
        branch: if branch.is_empty() { None } else { Some(branch) },
        dirty,
        ahead,
        behind,
        last_commit: if commit.is_empty() {
            None
        } else {
            Some(commit)
        },
        error: None,
    }
}

pub async fn handle_git_status(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(_) => return json_ok(serde_json::json!({"repos": []})),
    };
    let parsed: MultiRepoBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => return json_ok(serde_json::json!({"repos": []})),
    };

    let mut set = tokio::task::JoinSet::new();
    for repo in parsed.repos {
        set.spawn(get_repo_status(repo.clone_path));
    }

    let mut repos = Vec::with_capacity(set.len());
    while let Some(Ok(status)) = set.join_next().await {
        repos.push(status);
    }

    json_ok(serde_json::to_value(GitStatusResponse { repos }).unwrap())
}

async fn get_repo_diff(clone_path: String) -> GitDiffRepo {
    let path = full_path(&clone_path);

    let (code, _, _) = run_as_dev(&format!("git -C '{path}' rev-parse --git-dir")).await;
    if code != 0 {
        return GitDiffRepo {
            path: clone_path,
            files: vec![],
            total_added: 0,
            total_removed: 0,
            error: Some("Not a git repository".to_string()),
        };
    }

    let (_, unstaged_out, _) =
        run_as_dev(&format!("git -C '{path}' diff --numstat HEAD")).await;
    let (_, staged_out, _) =
        run_as_dev(&format!("git -C '{path}' diff --numstat --cached HEAD")).await;
    let (_, untracked_out, _) = run_as_dev(&format!(
        "git -C '{path}' ls-files --others --exclude-standard"
    ))
    .await;

    let mut files = Vec::new();
    let mut total_added: u32 = 0;
    let mut total_removed: u32 = 0;

    for line in unstaged_out
        .lines()
        .chain(staged_out.lines())
    {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            let added: u32 = parts[0].parse().unwrap_or(0);
            let removed: u32 = parts[1].parse().unwrap_or(0);
            let file_path = parts[2..].join("\t");
            total_added += added;
            total_removed += removed;
            files.push(GitDiffFile {
                path: file_path,
                added,
                removed,
            });
        }
    }

    for line in untracked_out.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        total_added += 1;
        files.push(GitDiffFile {
            path: line.to_string(),
            added: 1,
            removed: 0,
        });
    }

    GitDiffRepo {
        path: clone_path,
        files,
        total_added,
        total_removed,
        error: None,
    }
}

pub async fn handle_git_diff(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(_) => return json_ok(serde_json::json!({"repos": []})),
    };
    let parsed: MultiRepoBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => return json_ok(serde_json::json!({"repos": []})),
    };

    let mut set = tokio::task::JoinSet::new();
    for repo in parsed.repos {
        set.spawn(get_repo_diff(repo.clone_path));
    }

    let mut repos = Vec::with_capacity(set.len());
    while let Some(Ok(diff)) = set.join_next().await {
        repos.push(diff);
    }

    json_ok(serde_json::to_value(GitDiffResponse { repos }).unwrap())
}

pub async fn handle_git_commit(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(_) => {
            return json_ok(serde_json::to_value(GitCommitResponse {
                path: String::new(),
                success: false,
                hash: None,
                error: Some("Failed to read body".to_string()),
            }).unwrap())
        }
    };
    let parsed: CommitBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => {
            return json_ok(serde_json::to_value(GitCommitResponse {
                path: String::new(),
                success: false,
                hash: None,
                error: Some("Invalid JSON".to_string()),
            }).unwrap())
        }
    };

    let path = full_path(&parsed.repo_path);
    let escaped_msg = parsed.message.replace('\'', "'\\''");

    let cmd = format!(
        "git -C '{path}' add -A && git -C '{path}' commit -m '{escaped_msg}'"
    );
    let (code, _stdout, stderr) = run_as_dev(&cmd).await;

    if code != 0 {
        return json_ok(serde_json::to_value(GitCommitResponse {
            path: parsed.repo_path,
            success: false,
            hash: None,
            error: Some(stderr.trim().to_string()),
        }).unwrap());
    }

    let (_, hash_out, _) =
        run_as_dev(&format!("git -C '{path}' rev-parse --short HEAD")).await;

    json_ok(serde_json::to_value(GitCommitResponse {
        path: parsed.repo_path,
        success: true,
        hash: Some(hash_out.trim().to_string()),
        error: None,
    }).unwrap())
}

pub async fn handle_git_push(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(_) => {
            return json_ok(serde_json::to_value(GitPushResponse {
                path: String::new(),
                success: false,
                error: Some("Failed to read body".to_string()),
            }).unwrap())
        }
    };
    let parsed: PushBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => {
            return json_ok(serde_json::to_value(GitPushResponse {
                path: String::new(),
                success: false,
                error: Some("Invalid JSON".to_string()),
            }).unwrap())
        }
    };

    let path = full_path(&parsed.repo_path);

    let (code, _, _stderr) = run_as_dev(&format!("git -C '{path}' push")).await;

    if code != 0 {
        let (code2, _, stderr2) = run_as_dev(&format!(
            "git -C '{path}' push --set-upstream origin $(git -C '{path}' branch --show-current)"
        ))
        .await;

        if code2 != 0 {
            return json_ok(serde_json::to_value(GitPushResponse {
                path: parsed.repo_path,
                success: false,
                error: Some(stderr2.trim().to_string()),
            }).unwrap());
        }
    }

    json_ok(serde_json::to_value(GitPushResponse {
        path: parsed.repo_path,
        success: true,
        error: None,
    }).unwrap())
}
