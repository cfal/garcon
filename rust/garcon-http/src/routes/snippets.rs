//! Disk-backed snippet catalog read from `server/controller/routes/snippets.ts`.

use std::rc::Rc;

use garcon_stores::snippets::store::SnippetStore;
use http::{Method, StatusCode};

use crate::{
    compose_routes::RouteMap,
    http_route_types::{Route, RouteMetadata},
    json_route::json_response,
};

pub fn create_snippet_routes(store: &Rc<SnippetStore>) -> RouteMap<Route> {
    let store = store.clone();
    let get = Route::new(RouteMetadata::default(), move |_, _, _| {
        let store = store.clone();
        async move { Ok(json_response(StatusCode::OK, &store.snapshot())?) }
    });
    RouteMap::from([("/api/v1/snippets".into(), [(Method::GET, get)].into())])
}
