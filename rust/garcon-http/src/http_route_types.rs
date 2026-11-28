//! Native routes currently return buffered bodies. The first streaming route
//! must port the ReadableStream behavior pinned by
//! `server/controller/lib/__tests__/http-compression.test.js`: "slices Range
//! responses without reading past the requested span", "pulls only on demand
//! and forwards consumer cancellation", and "releases the source when the
//! requested range finishes".

use std::error::Error;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::rc::Rc;

use bytes::Bytes;
use http::{HeaderMap, Response};
use url::Url;

use crate::listener::HttpRequest;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerPrincipal {
    Local,
    Authenticated {
        owner_key: String,
        username: String,
        expires_at_ms: u64,
        credential_revision: u64,
        session_id: String,
    },
    Executor {
        key: String,
        executor_id: String,
    },
}

pub struct HttpRouteContext {
    pub principal: Option<ServerPrincipal>,
    pub peer: SocketAddr,
}

pub type RouteResponse = Response<Option<Bytes>>;
pub type RouteResult = Result<RouteResponse, Box<dyn Error>>;
pub type RouteFuture<'a, Output> = Pin<Box<dyn Future<Output = Output> + 'a>>;
pub type RouteHandler =
    Rc<dyn Fn(HttpRequest, Url, HttpRouteContext) -> RouteFuture<'static, RouteResult>>;

#[derive(Debug, thiserror::Error)]
#[error("not ported")]
pub(crate) struct UnportedRequest;

#[derive(Default, Clone)]
pub struct RouteMetadata {
    pub no_auth: bool,
    pub no_store: bool,
    pub response_headers: HeaderMap,
}

#[derive(Clone)]
pub enum Route {
    Ported {
        metadata: RouteMetadata,
        handler: RouteHandler,
    },
    Unported(RouteMetadata),
}

impl Route {
    pub fn new<F, R>(metadata: RouteMetadata, handler: F) -> Self
    where
        F: Fn(HttpRequest, Url, HttpRouteContext) -> R + 'static,
        R: Future<Output = RouteResult> + 'static,
    {
        Self::Ported {
            metadata,
            handler: Rc::new(move |request, url, context| Box::pin(handler(request, url, context))),
        }
    }
}

pub trait AuthenticateHttpRequest {
    fn authenticate<'a>(
        &'a self,
        request: &'a HttpRequest,
    ) -> RouteFuture<'a, Result<ServerPrincipal, Box<RouteResponse>>>;
}
