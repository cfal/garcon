use http::Method;

use crate::compose_routes::RouteMap;

pub struct RouteTable<H> {
    routes: RouteMap<H>,
    patterns: Vec<String>,
}

impl<H> RouteTable<H> {
    pub fn new(routes: RouteMap<H>) -> Self {
        let mut patterns: Vec<_> = routes
            .keys()
            .filter(|path| is_pattern(path))
            .cloned()
            .collect();
        patterns.sort_by_cached_key(|path| {
            path.split('/')
                .map(|part| {
                    if part == "*" {
                        2
                    } else if part.starts_with(':') {
                        1
                    } else {
                        0
                    }
                })
                .collect::<Vec<_>>()
        });
        Self { routes, patterns }
    }

    pub fn lookup(&self, method: &Method, path: &str) -> Option<(&str, &H)> {
        self.lookup_method(method, path).or_else(|| {
            if *method == Method::HEAD {
                self.lookup_method(&Method::GET, path)
            } else {
                None
            }
        })
    }

    fn lookup_method(&self, method: &Method, path: &str) -> Option<(&str, &H)> {
        if let Some((pattern, handler)) = self
            .routes
            .get_key_value(path)
            .filter(|(pattern, _)| !is_pattern(pattern))
            .and_then(|(pattern, methods)| Some((pattern.as_str(), methods.get(method)?)))
        {
            return Some((pattern, handler));
        }
        self.patterns.iter().find_map(|pattern| {
            if !matches_pattern(pattern, path) {
                return None;
            }
            let handler = self.routes.get(pattern)?.get(method)?;
            Some((pattern.as_str(), handler))
        })
    }
}

fn is_pattern(path: &str) -> bool {
    path.split('/')
        .any(|part| part == "*" || part.starts_with(':'))
}

fn matches_pattern(pattern: &str, path: &str) -> bool {
    let mut segments = path.split('/');
    for part in pattern.split('/') {
        let Some(segment) = segments.next() else {
            return false;
        };
        if part == "*" {
            return true;
        }
        if part.starts_with(':') {
            if segment.is_empty() {
                return false;
            }
        } else if segment != part {
            return false;
        }
    }
    segments.next().is_none()
}

#[cfg(test)]
mod tests {
    use indexmap::IndexMap;

    use super::*;

    fn table() -> RouteTable<&'static str> {
        RouteTable::new(RouteMap::from([
            ("/".into(), IndexMap::from([(Method::GET, "root")])),
            ("/one".into(), IndexMap::from([(Method::GET, "one")])),
            ("/p/*".into(), IndexMap::from([(Method::GET, "wildcard")])),
            (
                "/p/:id".into(),
                IndexMap::from([(Method::GET, "parameter")]),
            ),
            (
                "/p/literal".into(),
                IndexMap::from([(Method::POST, "post")]),
            ),
            ("/p/exact".into(), IndexMap::from([(Method::GET, "exact")])),
            (
                "/base/api/one".into(),
                IndexMap::from([(Method::GET, "mounted")]),
            ),
        ]))
    }

    #[test]
    fn matches_only_the_requested_method_or_the_get_handler_for_head() {
        let router = table();
        assert_eq!(router.lookup(&Method::HEAD, "/one"), Some(("/one", &"one")));
        assert_eq!(router.lookup(&Method::POST, "/one"), None);
        assert_eq!(
            router.lookup(&Method::POST, "/p/literal"),
            Some(("/p/literal", &"post"))
        );
        assert_eq!(
            router.lookup(&Method::GET, "/p/literal"),
            Some(("/p/:id", &"parameter"))
        );
        assert_eq!(
            router.lookup(&Method::HEAD, "/p/literal"),
            Some(("/p/:id", &"parameter"))
        );
    }

    #[test]
    fn prioritizes_literals_then_parameters_then_wildcards() {
        let router = table();
        assert_eq!(
            router.lookup(&Method::GET, "/p/exact"),
            Some(("/p/exact", &"exact"))
        );
        assert_eq!(
            router.lookup(&Method::GET, "/p/%2f"),
            Some(("/p/:id", &"parameter"))
        );
        assert_eq!(
            router.lookup(&Method::GET, "/p/*"),
            Some(("/p/:id", &"parameter"))
        );
        assert_eq!(
            router.lookup(&Method::GET, "/p/a/b"),
            Some(("/p/*", &"wildcard"))
        );
        assert_eq!(
            router.lookup(&Method::GET, "/p/"),
            Some(("/p/*", &"wildcard"))
        );
        assert_eq!(router.lookup(&Method::GET, "/p"), None);
    }

    #[test]
    fn does_not_normalize_the_wire_path_before_selecting_a_handler() {
        let router = table();
        for path in [
            "//",
            "//one",
            "/one/",
            "/a/../one",
            "/One",
            "/%6Fne",
            "/base//api/one",
        ] {
            assert_eq!(router.lookup(&Method::GET, path), None, "{path}");
        }
        assert_eq!(
            router.lookup(&Method::GET, "/base/api/one"),
            Some(("/base/api/one", &"mounted"))
        );
    }
}
