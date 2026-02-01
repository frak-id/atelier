mod config;
mod router;
mod routes;

use std::convert::Infallible;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use tokio_vsock::{VsockAddr, VsockListener};

use config::VSOCK_PORT;

async fn handle(req: Request<hyper::body::Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {
    Ok(router::route(req).await)
}

#[tokio::main]
async fn main() {
    println!("Sandbox agent starting...");

    let addr = VsockAddr::new(libc::VMADDR_CID_ANY, VSOCK_PORT);
    let mut listener = match VsockListener::bind(addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed to bind vsock port {VSOCK_PORT}: {e}");
            return;
        }
    };
    println!("Listening on vsock port {VSOCK_PORT}");

    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("vsock accept error: {e}");
                continue;
            }
        };
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            if let Err(e) = http1::Builder::new()
                .serve_connection(io, service_fn(handle))
                .await
            {
                if !e.is_incomplete_message() {
                    eprintln!("connection error: {e}");
                }
            }
        });
    }
}
