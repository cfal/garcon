//! Disk-backed preamble catalog read from `server/controller/routes/preambles.ts`.

use std::rc::Rc;

use garcon_stores::preambles::store::PreambleStore;
use http::{Method, StatusCode};

use crate::{
    compose_routes::RouteMap,
    http_route_types::{Route, RouteMetadata},
    json_route::json_response,
};

pub fn create_preamble_routes(store: &Rc<PreambleStore>) -> RouteMap<Route> {
    let store = store.clone();
    let get = Route::new(RouteMetadata::default(), move |_, _, _| {
        let store = store.clone();
        async move { Ok(json_response(StatusCode::OK, &store.snapshot())?) }
    });
    RouteMap::from([("/api/v1/preambles".into(), [(Method::GET, get)].into())])
}
