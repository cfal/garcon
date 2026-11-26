//! Garcon's Rust front door. It accepts the controller's arguments, starts the
//! TypeScript original behind it, serves the routes that have been ported, and
//! proxies everything else. See rust/README.md and rust/DECISIONS.md.

mod compression;
mod config;
mod original;
mod proxy;
mod shadow;
mod static_assets;

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;

use hyper::body::Incoming;
use hyper::header::CONTENT_LENGTH;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio::signal::unix::{SignalKind, signal};

use crate::compression::NativeResponse;
use crate::config::{FrontDoorConfig, LaunchMode, ProcessEnvironment};
use crate::proxy::{FallbackLog, Proxy, ResponseBody, full_body};
use crate::shadow::Shadow;

struct FrontDoor {
    config: FrontDoorConfig,
    proxy: Proxy,
    /// `GARCON_RS_UNIT_STATIC_ASSETS=original` sends the unit's routes back to
    /// the original without a rebuild.
    static_assets_native: bool,
    /// `GARCON_RS_SHADOW_LOG` compares every native response with the
    /// original's answer before returning it.
    shadow: Option<Shadow>,
}

/// Mirrors `stripBasePath` in `common/base-path.ts`.
fn strip_base_path<'a>(pathname: &'a str, base_path: &str) -> Option<&'a str> {
    if base_path.is_empty() {
        return pathname.starts_with('/').then_some(pathname);
    }
    if pathname == base_path {
        return Some("/");
    }
    pathname
        .strip_prefix(base_path)
        .filter(|rest| rest.starts_with('/'))
}

fn into_response(method: &Method, response: NativeResponse) -> Response<ResponseBody> {
    let NativeResponse {
        status,
        mut headers,
        body,
    } = response;
    // HEAD keeps the GET representation's headers, as Bun does for GET routes.
    let body = if method == Method::HEAD {
        if !headers.contains_key(CONTENT_LENGTH) {
            headers.insert(CONTENT_LENGTH, body.len().into());
        }
        bytes::Bytes::new()
    } else {
        body
    };
    let mut built = Response::new(full_body(body));
    *built.status_mut() = status;
    *built.headers_mut() = headers;
    built
}

impl FrontDoor {
    async fn handle(&self, request: Request<Incoming>, peer: SocketAddr) -> Response<ResponseBody> {
        if self.static_assets_native
            && let Some(pathname) = strip_base_path(request.uri().path(), &self.config.base_path)
            && let Some(asset) = static_assets::claim(request.method(), request.headers(), pathname)
        {
            let response = static_assets::serve(&self.config.web_build_dir, &asset).await;
            let response = compression::finish(
                request.method(),
                request.headers(),
                response,
                self.config.http_compression,
            );
            if let Some(shadow) = &self.shadow {
                shadow
                    .check(
                        request.method(),
                        request.uri(),
                        request.headers(),
                        &response,
                    )
                    .await;
            }
            return into_response(request.method(), response);
        }
        self.proxy.forward(request, peer).await
    }
}

/// Accepts a client connection. Small writes such as WebSocket frames must not
/// wait for Nagle's algorithm, which the original's server also disables;
/// without this the Chromium sidebar reorder suite timed out behind the front
/// door.
async fn accept(listener: &TcpListener) -> std::io::Result<(TcpStream, SocketAddr)> {
    let (stream, peer) = listener.accept().await?;
    stream.set_nodelay(true)?;
    Ok((stream, peer))
}

async fn accept_loop(listener: TcpListener, front_door: Arc<FrontDoor>) {
    loop {
        let Ok((stream, peer)) = accept(&listener).await else {
            continue;
        };
        let front_door = front_door.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let front_door = front_door.clone();
                async move { Ok::<_, std::convert::Infallible>(front_door.handle(request, peer).await) }
            });
            let _ = http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades()
                .await;
        });
    }
}

fn exit_code(status: std::process::ExitStatus) -> ExitCode {
    ExitCode::from(
        status
            .code()
            .and_then(|code| u8::try_from(code).ok())
            .unwrap_or(1),
    )
}

async fn run_front_door(config: FrontDoorConfig) -> std::io::Result<ExitCode> {
    let listener = TcpListener::bind((config.bind_address.as_str(), config.port)).await?;
    let port = listener.local_addr()?.port();
    let public_url = config::listening_server_url(&config.bind_address, port);
    let mut original = original::start(
        &config.original_root,
        &config.original_args,
        config.trust_proxy,
        public_url,
        &config::advertised_server_url(&config.bind_address, port),
    )
    .await?;
    let fallback_log = match std::env::var_os("GARCON_RS_FALLBACK_LOG") {
        Some(path) => Some(FallbackLog::open(path.as_ref())?),
        None => None,
    };
    let static_assets_native =
        std::env::var("GARCON_RS_UNIT_STATIC_ASSETS").as_deref() != Ok("original");
    let shadow = match std::env::var_os("GARCON_RS_SHADOW_LOG") {
        Some(path) => Some(Shadow::open(path.as_ref(), original.origin.clone())?),
        None => None,
    };
    let front_door = Arc::new(FrontDoor {
        proxy: Proxy::new(original.origin.clone(), config.trust_proxy, fallback_log),
        config,
        static_assets_native,
        shadow,
    });
    let server = tokio::spawn(accept_loop(listener, front_door));

    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let status = tokio::select! {
        status = original.child.wait() => status?,
        _ = terminate.recv() => original::stop(&mut original.child).await?,
        _ = interrupt.recv() => original::stop(&mut original.child).await?,
    };
    server.abort();
    Ok(exit_code(status))
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = ProcessEnvironment;
    match config::launch_mode(&args, &root) {
        LaunchMode::Original => {
            let original_root = std::env::var("GARCON_RS_ORIGINAL_ROOT")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| std::env::current_dir().unwrap_or_default());
            match original::run_in_foreground(&original_root, &args).await {
                Ok(status) => exit_code(status),
                Err(error) => {
                    eprintln!("garcon-server: could not start the original: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        LaunchMode::FrontDoor(config) => match run_front_door(*config).await {
            Ok(code) => code,
            Err(error) => {
                eprintln!("garcon-server: {error}");
                ExitCode::FAILURE
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn accepted_connections_disable_nagle() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let _client = TcpStream::connect(address).await.unwrap();
        let (stream, _) = accept(&listener).await.unwrap();
        assert!(stream.nodelay().unwrap());
    }

    #[test]
    fn strips_base_paths_like_the_original() {
        assert_eq!(strip_base_path("/x", ""), Some("/x"));
        assert_eq!(strip_base_path("/tools/garcon", "/tools/garcon"), Some("/"));
        assert_eq!(
            strip_base_path("/tools/garcon/x", "/tools/garcon"),
            Some("/x")
        );
        assert_eq!(strip_base_path("/tools/garconx/x", "/tools/garcon"), None);
        assert_eq!(strip_base_path("/other", "/tools/garcon"), None);
    }
}
