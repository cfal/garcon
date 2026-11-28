use std::error::Error;

use garcon_http::{
    compose_routes::{RouteMap, compose_routes},
    http_route_types::Route,
    routes::{preambles::create_preamble_routes, snippets::create_snippet_routes},
};
use garcon_js::Clock;
use garcon_stores::snippets::setup::initialize_snippet_and_preamble_stores;

pub(super) async fn initialize_catalog_routes(
    workspace_dir: &str,
    clock: &dyn Clock,
) -> Result<RouteMap<Route>, Box<dyn Error>> {
    // Bundles introduce no executor references, and startup precedes executor mutations.
    let catalogs = initialize_snippet_and_preamble_stores(workspace_dir, clock, None).await?;
    Ok(compose_routes([
        &create_snippet_routes(&catalogs.snippets),
        &create_preamble_routes(&catalogs.preambles),
    ])?)
}
