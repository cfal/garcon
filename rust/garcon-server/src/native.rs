//! Which requests the front door may serve natively at all, before any unit
//! claims them.
//!
//! The original's routing gives some request shapes behavior that follows from
//! Bun's router and Node's `path.resolve` rather than from design (ADR-004),
//! and frames byte-range responses by how Bun consumes a stream (ADR-005).
//! Native units therefore see only canonical paths without a `Range` header;
//! everything else goes to the original, which defines its behavior.

use hyper::header::{HeaderMap, RANGE};

fn is_canonical_segment(segment: &str) -> bool {
    !matches!(segment, "" | "." | "..")
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@".contains(&byte))
}

/// `pathname` is the request path with the base path removed. A canonical path
/// is `/` or has no empty, `.` or `..` segments, no percent escapes, and no
/// trailing slash.
pub fn eligible(headers: &HeaderMap, pathname: &str) -> bool {
    if headers.contains_key(RANGE) {
        return false;
    }
    pathname == "/"
        || pathname
            .strip_prefix('/')
            .is_some_and(|rest| rest.split('/').all(is_canonical_segment))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::header::HeaderValue;

    #[test]
    fn offers_only_canonical_paths_without_ranges() {
        let headers = HeaderMap::new();
        for canonical in ["/", "/_app/immutable/entry/start.js", "/service-worker.js"] {
            assert!(eligible(&headers, canonical), "{canonical} is canonical");
        }
        for other in [
            "/_app/",
            "/_app/immutable/entry/start.js/",
            "/_app//start.js",
            "//_app/start.js",
            "/_app/./start.js",
            "/_app/../auth.json",
            "/_app/%2e%2e%2fauth.json",
            "/_app/unicode-%C3%BC.txt",
            "/service-worker.js/",
        ] {
            assert!(!eligible(&headers, other), "{other} goes to the original");
        }
        let mut ranged = HeaderMap::new();
        ranged.insert(RANGE, HeaderValue::from_static("bytes=0-9"));
        assert!(!eligible(&ranged, "/icons/icon.svg"));
    }
}
