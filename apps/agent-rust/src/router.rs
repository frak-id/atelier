use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Method, Request, Response, StatusCode};

use crate::response::json_error;
use crate::routes;

pub async fn route(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    match (method.clone(), path.as_str()) {
        (Method::GET, "/health") => routes::health::handle_health().await,
        (Method::GET, "/metrics") => routes::health::handle_metrics().await,

        (Method::POST, "/exec") => routes::exec::handle_exec(req).await,
        (Method::POST, "/exec/batch") => routes::exec::handle_exec_batch(req).await,

        (Method::POST, "/git/status") => routes::git::handle_git_status(req).await,
        (Method::POST, "/git/diff") => routes::git::handle_git_diff(req).await,
        (Method::POST, "/git/commit") => routes::git::handle_git_commit(req).await,
        (Method::POST, "/git/push") => routes::git::handle_git_push(req).await,

        (Method::GET, "/config") => routes::config::handle_config(),
        (Method::GET, "/editor-config") => routes::config::handle_editor_config().await,

        (Method::GET, "/dev") => routes::dev::handle_get_dev().await,
        (Method::GET, "/services") => routes::services::handle_services_list().await,

        _ => {
            if let Some(rest) = path.strip_prefix("/services/") {
                let parts: Vec<&str> = rest.splitn(2, '/').collect();
                if parts.len() == 2 {
                    let name = urlencoding::decode(parts[0])
                        .unwrap_or_default()
                        .into_owned();
                    match (method.clone(), parts[1]) {
                        (Method::GET, "status") => {
                            return routes::services::handle_service_status(&name).await
                        }
                        (Method::POST, "start") => {
                            return routes::services::handle_service_start(&name).await
                        }
                        (Method::POST, "stop") => {
                            return routes::services::handle_service_stop(&name).await
                        }
                        (Method::POST, "restart") => {
                            return routes::services::handle_service_restart(&name).await
                        }
                        (Method::GET, sub) if sub.starts_with("logs") => {
                            let query = req.uri().query().unwrap_or("");
                            return routes::services::handle_service_logs(&name, query).await;
                        }
                        _ => {
                            return json_error(
                                StatusCode::METHOD_NOT_ALLOWED,
                                "Method Not Allowed",
                            )
                        }
                    }
                }
            }

            if let Some(rest) = path.strip_prefix("/dev/") {
                let parts: Vec<&str> = rest.splitn(2, '/').collect();
                if parts.len() == 2 {
                    let name = urlencoding::decode(parts[0]).unwrap_or_default().into_owned();
                    match (method, parts[1]) {
                        (Method::POST, "start") => return routes::dev::handle_dev_start(&name, req).await,
                        (Method::POST, "stop") => return routes::dev::handle_dev_stop(&name).await,
                        (Method::GET, "logs") => {
                            let query = req.uri().query().unwrap_or("");
                            return routes::dev::handle_dev_logs(&name, query).await;
                        }
                        _ => return json_error(StatusCode::METHOD_NOT_ALLOWED, "Method Not Allowed"),
                    }
                }
            }

            json_error(StatusCode::NOT_FOUND, "Not Found")
        }
    }
}
