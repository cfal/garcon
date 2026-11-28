use std::cell::Cell;
use std::error::Error;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use bytes::Bytes;
use garcon_base::http_body::{MalformedJsonError, fetch_header_value};
use garcon_base::http_error::json_error;
use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_contract::base_path::strip_base_path;
use garcon_contract::server_runtime::CLI_SERVER_INSTANCE_HEADER;
use http::header::{CACHE_CONTROL, CONTENT_TYPE, HeaderName, HeaderValue, LOCATION};
use http::{Method, Response, StatusCode};
use http_body_util::Full;
use tokio::io::AsyncWriteExt;

use super::compose_routes::{DuplicateRoute, RouteMap, compose_routes};
use super::compression::finish_native;
use super::http_request::request_url;
use super::http_route_types::{
    AuthenticateHttpRequest, HttpRouteContext, Route, RouteMetadata, RouteResponse, RouteResult,
    ServerPrincipal,
};
use super::listener::{HttpRequest, HttpResponse};
use super::route_table::RouteTable;
use super::unported_routes::unported_routes;

pub struct HttpRouteOptions {
    pub base_path: String,
    pub auth_disabled: bool,
    pub compression_enabled: bool,
    pub server_instance_id: Option<String>,
    pub shutting_down: Rc<Cell<bool>>,
    pub unported_log: Option<PathBuf>,
}

#[derive(Debug, thiserror::Error)]
pub enum RouteInventoryError {
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    DuplicateRoute(#[from] DuplicateRoute),
    #[error(transparent)]
    Method(#[from] http::method::InvalidMethod),
    #[error(transparent)]
    HeaderName(#[from] http::header::InvalidHeaderName),
    #[error(transparent)]
    HeaderValue(#[from] http::header::InvalidHeaderValue),
}

pub struct HttpRouter {
    table: RouteTable<Route>,
    options: HttpRouteOptions,
    auth: Rc<dyn AuthenticateHttpRequest>,
    logger: ScopedLogger,
}

impl HttpRouter {
    pub fn new(
        routes: RouteMap<Route>,
        options: HttpRouteOptions,
        auth: Rc<dyn AuthenticateHttpRequest>,
    ) -> Result<Self, RouteInventoryError> {
        let original = unported_route_map()?;
        Ok(Self::from_routes(
            compose_routes([&routes, &original])?,
            options,
            auth,
        ))
    }

    fn from_routes(
        routes: RouteMap<Route>,
        options: HttpRouteOptions,
        auth: Rc<dyn AuthenticateHttpRequest>,
    ) -> Self {
        let mounted = routes
            .into_iter()
            .map(|(path, methods)| (format!("{}{path}", options.base_path), methods))
            .collect();
        Self {
            table: RouteTable::new(mounted),
            options,
            auth,
            logger: create_logger("lib:http-route"),
        }
    }

    pub async fn handle(&self, request: HttpRequest, peer: SocketAddr) -> HttpResponse {
        self.dispatch(request, peer)
            .await
            .map(|body| Full::new(body.unwrap_or_default()))
    }

    async fn dispatch(&self, request: HttpRequest, peer: SocketAddr) -> RouteResponse {
        let method = request.method();
        let pathname = request.uri().path();
        if !self.options.base_path.is_empty()
            && pathname == self.options.base_path
            && (*method == Method::GET || *method == Method::HEAD)
        {
            return self
                .redirect_at_mount(&request)
                .unwrap_or_else(|error| self.unhandled(&*error));
        }
        let Some((_, route)) = self.table.lookup(method, pathname) else {
            if self.options.shutting_down.get() {
                return shutting_down();
            }
            return request_url(&request)
                .map_or_else(|error| self.unhandled(&error), |_| not_found());
        };
        let metadata = match route {
            Route::Ported { metadata, .. } | Route::Unported(metadata) => metadata,
        };
        let mut response = self
            .wrap_route(route, metadata, request, peer)
            .await
            .unwrap_or_else(|error| self.unhandled(&*error));
        for (name, value) in &metadata.response_headers {
            response.headers_mut().insert(name.clone(), value.clone());
        }
        response
    }

    fn redirect_at_mount(&self, request: &HttpRequest) -> RouteResult {
        if self.options.shutting_down.get() {
            return Ok(shutting_down());
        }
        let url = request_url(request)?;
        let mut target = format!("{}/", self.options.base_path);
        if let Some(query) = url.query().filter(|query| !query.is_empty()) {
            target.push('?');
            target.push_str(query);
        }
        let mut redirect = response(StatusCode::PERMANENT_REDIRECT, None);
        redirect
            .headers_mut()
            .insert(LOCATION, HeaderValue::from_str(&target)?);
        Ok(redirect)
    }

    async fn wrap_route(
        &self,
        route: &Route,
        metadata: &RouteMetadata,
        request: HttpRequest,
        peer: SocketAddr,
    ) -> RouteResult {
        if self.options.shutting_down.get() {
            return Ok(shutting_down());
        }
        let principal = if self.options.auth_disabled {
            Some(ServerPrincipal::Local)
        } else if metadata.no_auth {
            None
        } else {
            let result = self.auth.authenticate(&request).await;
            if self.options.shutting_down.get() {
                return Ok(shutting_down());
            }
            match result {
                Ok(principal) => Some(principal),
                Err(mut rejection) => {
                    if metadata.no_store {
                        rejection
                            .headers_mut()
                            .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
                    }
                    return Ok(finish_native(
                        request.method(),
                        request.headers(),
                        *rejection,
                        self.options.compression_enabled,
                    )
                    .await?);
                }
            }
        };
        if principal.is_some()
            && let Some(mismatch) =
                cli_instance_mismatch(&request, self.options.server_instance_id.as_deref())
        {
            return Ok(mismatch);
        }
        let mut url = request_url(&request)?;
        let Some(pathname) = strip_base_path(url.path(), &self.options.base_path) else {
            return Ok(finish_native(
                request.method(),
                request.headers(),
                not_found(),
                self.options.compression_enabled,
            )
            .await?);
        };
        let pathname = pathname.to_owned();
        url.set_path(&pathname);
        let method = request.method().clone();
        let headers = request.headers().clone();
        let reply = match route {
            Route::Ported { handler, .. } => {
                match handler(request, url, HttpRouteContext { principal, peer }).await {
                    Ok(reply) => reply,
                    Err(error) if error.is::<MalformedJsonError>() => malformed_json_response(),
                    Err(error) => return Err(error),
                }
            }
            Route::Unported(_) => {
                if let Some(log) = &self.options.unported_log
                    && let Err(error) = log_unported(log, &method, request.uri().path()).await
                {
                    self.logger
                        .error(&format!("Could not write the unported route log: {error}"));
                }
                unported_response()
            }
        };
        Ok(finish_native(&method, &headers, reply, self.options.compression_enabled).await?)
    }

    fn unhandled(&self, error: &dyn Error) -> RouteResponse {
        self.logger
            .error(&format!("Unhandled route error: {error}"));
        route_error("Internal server error", 500.0, None, None)
    }
}

pub fn cli_instance_mismatch<B>(
    request: &http::Request<B>,
    expected: Option<&str>,
) -> Option<RouteResponse> {
    let header = HeaderName::try_from(CLI_SERVER_INSTANCE_HEADER).ok()?;
    let supplied = fetch_header_value(request.headers(), &header)?;
    (Some(supplied.as_ref()) != expected).then(|| {
        route_error(
            "Garcon restarted; start a new CLI invocation",
            409.0,
            Some("CLI_CONTROLLER_CHANGED"),
            Some(false),
        )
    })
}

pub fn shutting_down() -> RouteResponse {
    route_error(
        "The server is shutting down",
        503.0,
        Some("SERVER_SHUTTING_DOWN"),
        Some(true),
    )
}

pub fn malformed_json_response() -> RouteResponse {
    route_error("Malformed JSON", 400.0, None, None)
}

pub(crate) fn route_error(
    message: &'static str,
    status: f64,
    code: Option<&str>,
    retryable: Option<bool>,
) -> RouteResponse {
    // INFALLIBLE: these call sites use fixed valid statuses and serialize a string error envelope.
    json_error(message, status, code, retryable, None)
        .expect("fixed HTTP error envelope")
        .map(Some)
}

fn response(status: StatusCode, body: Option<Bytes>) -> RouteResponse {
    let mut response = Response::new(body);
    *response.status_mut() = status;
    response
}

fn not_found() -> RouteResponse {
    let mut reply = response(
        StatusCode::NOT_FOUND,
        Some(Bytes::from_static(b"Not found")),
    );
    reply.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/plain;charset=utf-8"),
    );
    reply
}

fn unported_response() -> RouteResponse {
    let mut reply = response(
        StatusCode::NOT_IMPLEMENTED,
        Some(Bytes::from_static(br#"{"error":"not ported"}"#)),
    );
    reply.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json;charset=utf-8"),
    );
    reply
        .headers_mut()
        .insert("x-garcon-rs-unported", HeaderValue::from_static("1"));
    reply
}

async fn log_unported(path: &Path, method: &Method, request_path: &str) -> std::io::Result<()> {
    let entry = format!("{method} {request_path}\n");
    let mut log = tokio::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
        .await?;
    log.write_all(entry.as_bytes()).await?;
    log.flush().await
}

fn unported_route_map() -> Result<RouteMap<Route>, RouteInventoryError> {
    let mut routes = RouteMap::new();
    for route in unported_routes()? {
        let method = Method::from_bytes(route.method.as_bytes())?;
        let mut metadata = RouteMetadata {
            no_auth: route.no_auth,
            no_store: route.no_store,
            ..Default::default()
        };
        for (name, value) in route.response_headers {
            metadata.response_headers.insert(
                HeaderName::from_bytes(name.as_bytes())?,
                HeaderValue::from_str(&value)?,
            );
        }
        if routes
            .entry(route.path.clone())
            .or_default()
            .insert(method.clone(), Route::Unported(metadata))
            .is_some()
        {
            return Err(DuplicateRoute {
                method,
                path: route.path,
            }
            .into());
        }
    }
    Ok(routes)
}
