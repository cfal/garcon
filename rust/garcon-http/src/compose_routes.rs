//! Ports `server/controller/lib/compose-routes.ts`.

use http::Method;
use indexmap::{IndexMap, map::Entry};

pub type RouteMap<H> = IndexMap<String, IndexMap<Method, H>>;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("Duplicate route: {method} {path}")]
pub struct DuplicateRoute {
    pub method: Method,
    pub path: String,
}

pub fn compose_routes<'a, H: Clone + 'a>(
    groups: impl IntoIterator<Item = &'a RouteMap<H>>,
) -> Result<RouteMap<H>, DuplicateRoute> {
    let mut routes = RouteMap::new();
    for group in groups {
        for (path, methods) in group {
            let combined = routes.entry(path.clone()).or_default();
            for (method, handler) in methods {
                match combined.entry(method.clone()) {
                    Entry::Occupied(_) => {
                        return Err(DuplicateRoute {
                            method: method.clone(),
                            path: path.clone(),
                        });
                    }
                    Entry::Vacant(entry) => {
                        entry.insert(handler.clone());
                    }
                }
            }
        }
    }
    Ok(routes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn routes(path: &str, method: Method, handler: &str) -> RouteMap<String> {
        RouteMap::from([(path.into(), IndexMap::from([(method, handler.into())]))])
    }

    #[test]
    fn combines_disjoint_methods_without_replacing_handlers_or_mutating_source_maps() {
        let original = routes("/shared", Method::GET, "read");
        let added = routes("/shared", Method::POST, "write");
        let combined = compose_routes([&original, &added]).unwrap();
        assert_eq!(
            combined["/shared"]
                .iter()
                .map(|(method, handler)| (method, handler.as_str()))
                .collect::<Vec<_>>(),
            [(&Method::GET, "read"), (&Method::POST, "write")]
        );
        assert_eq!(original, routes("/shared", Method::GET, "read"));
    }

    #[test]
    fn rejects_duplicate_path_method_registrations_even_for_an_identical_handler() {
        let original = routes("/duplicate", Method::GET, "read");
        assert_eq!(
            compose_routes([&original, &original])
                .unwrap_err()
                .to_string(),
            "Duplicate route: GET /duplicate"
        );
        let distinct = routes("/distinct", Method::GET, "read");
        let combined = compose_routes([&original, &distinct]).unwrap();
        assert_eq!(
            combined.keys().map(String::as_str).collect::<Vec<_>>(),
            ["/duplicate", "/distinct"]
        );
    }
}
