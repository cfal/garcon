use std::rc::Rc;

use garcon_base::server_runtime::{ServerRuntimeState, create_server_runtime_proof};
use garcon_contract::server_runtime::{CliContext, ServerRuntimeProbe};
use http::header::{CACHE_CONTROL, HeaderValue};
use http::{Method, StatusCode};
use serde_json::json;
use url::Url;

use super::super::compose_routes::RouteMap;
use super::super::http_route_types::{Route, RouteMetadata, RouteResponse};
use super::super::json_route::json_response;

fn no_store(mut response: RouteResponse) -> RouteResponse {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn runtime_proof(
    runtime: &ServerRuntimeState,
    url: &Url,
) -> Result<RouteResponse, serde_json::Error> {
    let challenge = url
        .query_pairs()
        .find(|(name, _)| name == "challenge")
        .map(|(_, value)| value);
    let Some(proof) = challenge.and_then(|value| create_server_runtime_proof(runtime, &value).ok())
    else {
        return json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "challenge must be 32-byte base64url data" }),
        )
        .map(no_store);
    };
    json_response(
        StatusCode::OK,
        &ServerRuntimeProbe {
            schema_version: runtime.identity.schema_version,
            instance_id: runtime.identity.instance_id.clone(),
            proof,
        },
    )
    .map(no_store)
}

pub fn create_runtime_routes(
    runtime: Rc<ServerRuntimeState>,
    workspace_name: Option<String>,
) -> RouteMap<Route> {
    let context = Rc::new(CliContext {
        server_instance_id: runtime.identity.instance_id.clone(),
        default_executor_id: "local".into(),
        workspace_name,
    });
    let context = Route::new(RouteMetadata::default(), move |_, _, _| {
        let context = Rc::clone(&context);
        async move { Ok(no_store(json_response(StatusCode::OK, &*context)?)) }
    });
    let proof = Route::new(
        RouteMetadata {
            no_auth: true,
            ..Default::default()
        },
        move |_, url, _| {
            let runtime = Rc::clone(&runtime);
            async move { Ok(runtime_proof(&runtime, &url)?) }
        },
    );
    RouteMap::from([
        (
            "/api/v1/cli/context".into(),
            [(Method::GET, context)].into(),
        ),
        ("/api/v1/runtime".into(), [(Method::GET, proof)].into()),
    ])
}
