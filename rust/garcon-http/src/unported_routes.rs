use indexmap::IndexMap;
use serde::Deserialize;

const INVENTORY: &str = include_str!("unported-routes.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnportedRoute {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub no_auth: bool,
    #[serde(default)]
    pub no_store: bool,
    #[serde(default)]
    pub response_headers: IndexMap<String, String>,
}

pub fn unported_routes() -> Result<Vec<UnportedRoute>, serde_json::Error> {
    garcon_js::json::from_str(INVENTORY)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unported_routes_keep_auth_and_response_metadata() {
        let routes = unported_routes().unwrap();
        let routes: IndexMap<_, _> = routes
            .into_iter()
            .map(|route| {
                (
                    (route.method, route.path),
                    (route.no_auth, route.no_store, route.response_headers),
                )
            })
            .collect();
        assert!(!routes[&("GET".into(), "/api/v1/tickets".into())].0);
        assert!(routes[&("GET".into(), "/api/v1/tickets".into())].1);
        assert!(
            !routes[&("GET".into(), "/shared/:token".into())]
                .2
                .is_empty()
        );
    }
}
