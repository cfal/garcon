pub mod runtime;
pub mod r#static;

use std::rc::Rc;

use garcon_base::server_runtime::ServerRuntimeState;

use super::compose_routes::{DuplicateRoute, RouteMap, compose_routes};
use super::http_route_types::Route;

pub fn create_edge_routes(
    runtime: Rc<ServerRuntimeState>,
    workspace_name: Option<String>,
    static_routes: r#static::StaticRoutes,
) -> Result<RouteMap<Route>, DuplicateRoute> {
    compose_routes([
        &runtime::create_runtime_routes(runtime, workspace_name),
        &r#static::create_static_routes(static_routes),
    ])
}
