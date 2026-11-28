//! Garcon's Rust front door. It accepts the controller's arguments, starts the
//! TypeScript original behind it, serves the routes that have been ported, and
//! proxies everything else. See rust/README.md and rust/DECISIONS.md.

mod config;
mod line_log;
mod native;
mod original;
mod proxy;
mod relay;
mod shadow;

use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;

use garcon_http::asset_cache::{AssetCache, compress_off_runtime};
use garcon_http::compression::{self, NativeResponse};
use garcon_http::static_assets;
use hyper::body::Incoming;
use hyper::header::HeaderValue;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio::signal::unix::{SignalKind, signal};

use crate::config::{FrontDoorConfig, LaunchMode, ProcessEnvironment};
use crate::line_log::LineLog;
use crate::proxy::{
    BrowserSocket, Proxy, ResponseBody, forwarded_for, full_body, origin_authority,
};
use crate::shadow::Shadow;

/// Memory for cached web build files and their encodings. A production build is
/// about 30 MB uncompressed; files beyond the budget are served uncached.
const ASSET_CACHE_BUDGET: usize = 128 * 1024 * 1024;

struct FrontDoor {
    config: FrontDoorConfig,
    proxy: Proxy,
    /// Compares every native response with the original's answer before
    /// returning it (`GARCON_RS_SHADOW_LOG`).
    shadow: Option<Shadow>,
    assets: AssetCache,
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

/// Sends a framed native response; HEAD keeps the GET representation's
/// headers, as Bun does for GET routes.
fn into_response(method: &Method, response: NativeResponse) -> Response<ResponseBody> {
    let NativeResponse {
        status,
        headers,
        body,
    } = response;
    let body = if method == Method::HEAD {
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
    /// `peer` is the client connection's `X-Forwarded-For` value.
    async fn handle(
        &self,
        request: Request<Incoming>,
        peer: &HeaderValue,
    ) -> Response<ResponseBody> {
        if self.config.static_assets_native
            && let Some(pathname) = strip_base_path(request.uri().path(), &self.config.base_path)
            && native::eligible(request.headers(), pathname)
            && let Some(asset) = static_assets::claim(request.method(), pathname)
        {
            let (response, version) =
                static_assets::serve(&self.config.web_build_dir, &asset, &self.assets).await;
            let response = compression::finish(
                request.method(),
                request.headers(),
                response,
                self.config.http_compression,
                |encoding, body| match &version {
                    Some(version) => self.assets.encode(version, encoding, body),
                    None => compress_off_runtime(encoding, body),
                },
            )
            .framed();
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

/// Pause after a failed accept. Errors such as running out of file descriptors
/// persist until connections close, so retrying at once would spin.
const ACCEPT_ERROR_BACKOFF: std::time::Duration = std::time::Duration::from_millis(100);

async fn accept_loop(listener: TcpListener, front_door: Arc<FrontDoor>) {
    loop {
        let Ok((stream, peer)) = accept(&listener).await else {
            tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
            continue;
        };
        let front_door = front_door.clone();
        let peer = forwarded_for(peer);
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let front_door = front_door.clone();
                let peer = peer.clone();
                async move { Ok::<_, std::convert::Infallible>(front_door.handle(request, &peer).await) }
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
    // Installed before the original starts, so a stop request during its
    // startup waits for it and then shuts it down gracefully instead of
    // killing the front door and, through its death signal, the original.
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let listener = TcpListener::bind((config.bind_address.as_str(), config.port)).await?;
    let port = listener.local_addr()?.port();
    let public_url = config::listening_server_url(&config.bind_address, port);
    let mut original = original::start(
        &config.original,
        &config.original_args,
        public_url,
        &config::advertised_server_url(&config.bind_address, port),
    )
    .await?;
    let authority = origin_authority(&original.origin)?;
    let fallback_log = config
        .fallback_log
        .as_deref()
        .map(LineLog::open)
        .transpose()?;
    let shadow = match &config.shadow_log {
        Some(path) => Some(Shadow::open(path, authority.clone())?),
        None => None,
    };
    let front_door = Arc::new(FrontDoor {
        proxy: Proxy::new(
            authority,
            config.trust_proxy,
            fallback_log,
            BrowserSocket {
                path: format!("{}/ws", config.base_path),
                budget: config.ws_backpressure_limit,
            },
        ),
        config,
        shadow,
        assets: AssetCache::new(ASSET_CACHE_BUDGET),
    });
    let server = tokio::spawn(accept_loop(listener, front_door));

    let status = tokio::select! {
        status = original.child.wait() => status?,
        _ = terminate.recv() => original::stop(&mut original.child).await?,
        _ = interrupt.recv() => original::stop(&mut original.child).await?,
    };
    server.abort();
    Ok(exit_code(status))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if std::env::var_os("GARCON_RS_CONTROLLER").is_some_and(|mode| mode == "native") {
        // SAFETY: native dispatch runs before either mode starts a runtime or any threads.
        return unsafe {
            garcon_controller::server::run_native(
                &args,
                std::rc::Rc::new(garcon_controller::server::UnavailableLocalExecutor),
            )
        };
    }
    run_front_door_entry(args)
}

#[tokio::main]
async fn run_front_door_entry(args: Vec<String>) -> ExitCode {
    let root = ProcessEnvironment;
    match config::launch_mode(&args, &root) {
        LaunchMode::Original(original) => {
            match original::run_in_foreground(&original, &args).await {
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
