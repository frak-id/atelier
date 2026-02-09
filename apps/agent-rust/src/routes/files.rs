use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Request, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::fs::{self, Permissions};
use std::os::unix::fs::{chown, PermissionsExt};
use std::path::Path;

use crate::body::{read_body_limited, ReadBodyError};
use crate::limits::{FILES_SEMAPHORE, MAX_REQUEST_BODY_BYTES};
use crate::response::{json, json_error, json_ok};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFilesRequest {
    pub files: Vec<FileWrite>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWrite {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFilesResponse {
    pub results: Vec<FileWriteResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub path: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn get_uid_gid(owner: &str) -> Option<(u32, u32)> {
    match owner {
        "dev" => Some((1000, 1000)),
        "root" => Some((0, 0)),
        _ => None,
    }
}

fn parse_mode(mode_str: &str) -> Option<u32> {
    u32::from_str_radix(mode_str, 8).ok()
}

fn write_single_file(file: &FileWrite) -> Result<(), String> {
    let path = Path::new(&file.path);

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
    }

    fs::write(path, &file.content).map_err(|e| format!("Failed to write file: {}", e))?;

    if let Some(mode_str) = &file.mode {
        if let Some(mode) = parse_mode(mode_str) {
            fs::set_permissions(path, Permissions::from_mode(mode))
                .map_err(|e| format!("Failed to set mode: {}", e))?;
        }
    }

    if let Some(owner) = &file.owner {
        if let Some((uid, gid)) = get_uid_gid(owner) {
            chown(path, Some(uid), Some(gid)).map_err(|e| format!("Failed to chown: {}", e))?;
        }
    }

    Ok(())
}

pub async fn handle_write_files(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let _permit = FILES_SEMAPHORE.acquire().await.unwrap();

    let body = match read_body_limited(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(ReadBodyError::TooLarge) => {
            return json_ok(serde_json::json!({
                "results": [],
                "error": "Request body too large"
            }))
        }
        Err(ReadBodyError::ReadFailed) => {
            return json_error(StatusCode::BAD_REQUEST, "Failed to read body")
        }
    };

    let write_req: WriteFilesRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {}", e)),
    };

    let results: Vec<FileWriteResult> = write_req
        .files
        .iter()
        .map(|file| match write_single_file(file) {
            Ok(()) => FileWriteResult {
                path: file.path.clone(),
                success: true,
                error: None,
            },
            Err(e) => FileWriteResult {
                path: file.path.clone(),
                success: false,
                error: Some(e),
            },
        })
        .collect();

    let all_success = results.iter().all(|r| r.success);
    let status = if all_success {
        StatusCode::OK
    } else {
        StatusCode::MULTI_STATUS
    };

    json(
        status,
        Bytes::from(serde_json::to_vec(&WriteFilesResponse { results }).unwrap_or_default()),
    )
}
