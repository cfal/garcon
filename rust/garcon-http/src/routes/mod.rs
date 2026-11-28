pub mod api_providers;
pub mod auth;
pub mod executors;
pub mod runtime;
pub mod r#static;
pub mod tickets;

use std::rc::Rc;

use garcon_base::server_runtime::ServerRuntimeState;

use super::compose_routes::{DuplicateRoute, RouteMap, compose_routes};
use super::http_route_types::Route;

pub fn create_edge_routes(
    runtime: Rc<ServerRuntimeState>,
    workspace_name: Option<String>,
    static_routes: r#static::StaticRoutes,
    auth_routes: &Rc<auth::AuthRoutes>,
) -> Result<RouteMap<Route>, DuplicateRoute> {
    compose_routes([
        &auth::create_auth_routes(auth_routes),
        &runtime::create_runtime_routes(runtime, workspace_name),
        &r#static::create_static_routes(static_routes),
    ])
}
