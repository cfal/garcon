//! Connection export uses the durable configuration, not executor readiness.

use std::rc::Rc;

use garcon_base::{
    domain_error::DomainError, errors::ErrorInput, http_body::fetch_header_value,
    http_error::json_error_from_unknown,
};
use garcon_stores::executors::{
    config_store::{ExecutorConfigStore, RemoteExecutorConnection},
    public_url::request_public_url,
};
use http::{
    HeaderValue, Method, StatusCode,
    header::{CACHE_CONTROL, HOST},
};
use url::Url;

use crate::{
    compose_routes::RouteMap,
    http_route_types::{HttpRouteContext, Route, RouteMetadata, RouteResult, ServerPrincipal},
    json_route::json_response,
    listener::HttpRequest,
};

pub fn create_executor_connection_routes(
    config: &Rc<ExecutorConfigStore>,
    public_url: Option<String>,
    base_path: String,
) -> RouteMap<Route> {
    let config = config.clone();
    let public_url = Rc::new(public_url);
    let base_path = Rc::new(base_path);
    let connection = Route::new(RouteMetadata::default(), move |request, url, context| {
        let (config, public_url, base_path) =
            (config.clone(), public_url.clone(), base_path.clone());
        async move {
            let result = export_connection(
                &config,
                &request,
                &url,
                &context,
                public_url.as_deref(),
                &base_path,
            );
            let mut reply = match result {
                Ok(reply) => reply,
                Err(error) => {
                    json_error_from_unknown(ErrorInput::Error(error.as_ref()), None, None, None)?
                        .map(Some)
                }
            };
            reply
                .headers_mut()
                .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
            Ok(reply)
        }
    });
    RouteMap::from([(
        "/api/v1/executors/:executorId/connection".into(),
        [(Method::GET, connection)].into(),
    )])
}

fn export_connection(
    config: &ExecutorConfigStore,
    request: &HttpRequest,
    url: &Url,
    context: &HttpRouteContext,
    public_url: Option<&str>,
    base_path: &str,
) -> RouteResult {
    let id = url.path().split('/').nth(4).unwrap_or_default();
    let stored = config.require(id)?;
    let public_base = if matches!(
        stored.connection,
        RemoteExecutorConnection::ExecutorConnects {
            advertised_url: None
        }
    ) {
        if public_url.is_none()
            && matches!(context.principal, Some(ServerPrincipal::Executor { .. }))
        {
            return Err(DomainError::new_validation("Executor CLI requests have no public Host; configure GARCON_PUBLIC_URL / --public-url on the controller or set an explicit executor advertised URL").into());
        }
        let host = fetch_header_value(request.headers(), &HOST);
        Some(request_public_url(
            url,
            host.as_deref(),
            public_url,
            base_path,
        )?)
    } else {
        None
    };
    Ok(json_response(
        StatusCode::OK,
        &config.connection(id, public_base.as_ref().map(Url::as_str))?,
    )?)
}
