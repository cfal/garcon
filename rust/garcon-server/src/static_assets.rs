//! Native serving of the SPA's static assets: the `/_app/*`, `/icons/*`, and
//! `/service-worker.js` routes of `server/controller/routes/static.ts`.
//!
//! Only canonical requests are claimed. Paths with dot or empty segments,
//! percent escapes, a trailing slash, or an extension outside the table below
//! go to the original, whose router and `path.resolve` semantics define their
//! behavior (ADR-004), and so do requests with a `Range` header, whose framing
//! depends on Bun's stream handling (ADR-005).

use std::path::{Path, PathBuf};

use bytes::Bytes;
use hyper::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, HeaderMap, HeaderValue, RANGE};
use hyper::{Method, StatusCode};

use crate::compression::NativeResponse;

/// Content types Bun assigns to file responses, for the extensions a web build
/// contains. Bun adds `Content-Disposition` to some other types, so unlisted
/// extensions fall back rather than guessing.
const CONTENT_TYPES: [(&str, &str); 21] = [
    ("avif", "image/avif"),
    ("css", "text/css;charset=utf-8"),
    ("gif", "image/gif"),
    ("htm", "text/html;charset=utf-8"),
    ("html", "text/html;charset=utf-8"),
    ("ico", "image/x-icon"),
    ("jpeg", "image/jpeg"),
    ("jpg", "image/jpeg"),
    ("js", "text/javascript;charset=utf-8"),
    ("json", "application/json;charset=utf-8"),
    ("map", "application/json;charset=utf-8"),
    ("mjs", "text/javascript;charset=utf-8"),
    ("otf", "font/otf"),
    ("png", "image/png"),
    ("svg", "image/svg+xml"),
    ("ttf", "font/ttf"),
    ("txt", "text/plain;charset=utf-8"),
    ("wasm", "application/wasm"),
    ("webp", "image/webp"),
    ("woff", "font/woff"),
    ("woff2", "font/woff2"),
];

const STATIC_PREFIXES: [&str; 2] = ["/_app/", "/icons/"];
const SERVICE_WORKER: &str = "/service-worker.js";

/// A request path this unit serves, relative to the web build.
#[derive(Debug, PartialEq, Eq)]
pub struct AssetRequest<'a> {
    pathname: &'a str,
    content_type: &'static str,
}

fn is_canonical_segment(segment: &str) -> bool {
    !matches!(segment, "" | "." | "..")
        && segment
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@".contains(&byte))
}

fn content_type_for(pathname: &str) -> Option<&'static str> {
    let file_name = pathname.rsplit('/').next()?;
    let (_, extension) = file_name.rsplit_once('.')?;
    let extension = extension.to_ascii_lowercase();
    CONTENT_TYPES
        .iter()
        .find(|(candidate, _)| *candidate == extension)
        .map(|(_, content_type)| *content_type)
}

/// Returns the asset request when this unit serves `pathname`, which is the
/// request path with the base path already removed.
pub fn claim<'a>(
    method: &Method,
    headers: &HeaderMap,
    pathname: &'a str,
) -> Option<AssetRequest<'a>> {
    if method != Method::GET && method != Method::HEAD || headers.contains_key(RANGE) {
        return None;
    }
    let routed = pathname == SERVICE_WORKER
        || STATIC_PREFIXES.iter().any(|prefix| {
            pathname
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.split('/').all(is_canonical_segment))
        });
    if !routed {
        return None;
    }
    Some(AssetRequest {
        pathname,
        content_type: content_type_for(pathname)?,
    })
}

/// Mirrors `cacheHeaders`, including its case-sensitive extension match.
fn cache_control(pathname: &str) -> Option<&'static str> {
    const NO_STORE: &str = "no-cache, no-store, must-revalidate";
    const IMMUTABLE: &str = "public, max-age=31536000, immutable";
    const REVALIDATE: &str = "public, max-age=3600, must-revalidate";
    const REVALIDATED_EXTENSIONS: [&str; 15] = [
        "js",
        "css",
        "woff",
        "woff2",
        "ttf",
        "eot",
        "svg",
        "png",
        "jpg",
        "jpeg",
        "gif",
        "ico",
        "map",
        "json",
        "webmanifest",
    ];
    if pathname.ends_with(".html") || pathname == "/site.webmanifest" || pathname == SERVICE_WORKER
    {
        return Some(NO_STORE);
    }
    if pathname.starts_with("/_app/immutable/") || pathname.starts_with("/icons/") {
        return Some(IMMUTABLE);
    }
    let extension = pathname.rsplit_once('.').map(|(_, extension)| extension)?;
    REVALIDATED_EXTENSIONS
        .contains(&extension)
        .then_some(REVALIDATE)
}

/// The original's `jsonError('Not found', 404)`.
pub fn not_found() -> NativeResponse {
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json;charset=utf-8"),
    );
    NativeResponse {
        status: StatusCode::NOT_FOUND,
        headers,
        body: Bytes::from_static(
            br#"{"success":false,"error":"Not found","errorCode":"VALIDATION_FAILED","retryable":false}"#,
        ),
    }
}

/// Mirrors `resolveStaticFilePath`: the file must be inside the build both
/// lexically and after resolving symlinks.
async fn resolve(build_dir: &Path, pathname: &str) -> Option<PathBuf> {
    let candidate = build_dir.join(pathname.trim_start_matches('/'));
    let real_build = tokio::fs::canonicalize(build_dir).await.ok()?;
    let real_candidate = tokio::fs::canonicalize(&candidate).await.ok()?;
    if !real_candidate.starts_with(&real_build) {
        return None;
    }
    tokio::fs::metadata(&real_candidate)
        .await
        .ok()
        .filter(|metadata| metadata.is_file())
        .map(|_| real_candidate)
}

pub async fn serve(build_dir: &Path, request: &AssetRequest<'_>) -> NativeResponse {
    let Some(path) = resolve(build_dir, request.pathname).await else {
        return not_found();
    };
    let Ok(contents) = tokio::fs::read(&path).await else {
        return not_found();
    };
    let mut headers = HeaderMap::new();
    if let Some(cache_control) = cache_control(request.pathname) {
        headers.insert(CACHE_CONTROL, HeaderValue::from_static(cache_control));
    }
    headers.insert(CONTENT_LENGTH, HeaderValue::from(contents.len()));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(request.content_type));
    NativeResponse {
        status: StatusCode::OK,
        headers,
        body: Bytes::from(contents),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_only_canonical_asset_paths() {
        let headers = HeaderMap::new();
        let claimed = |path| claim(&Method::GET, &headers, path).is_some();
        assert!(claimed("/_app/immutable/entry/start.js"));
        assert!(claimed("/_app/version.json"));
        assert!(claimed("/icons/icon.SVG"));
        assert!(claimed("/service-worker.js"));
        assert!(claim(&Method::HEAD, &headers, "/icons/icon.svg").is_some());
        assert!(claim(&Method::POST, &headers, "/icons/icon.svg").is_none());
        let mut ranged = HeaderMap::new();
        ranged.insert(RANGE, HeaderValue::from_static("bytes=0-9"));
        assert!(claim(&Method::GET, &ranged, "/icons/icon.svg").is_none());
        for fallback in [
            "/_app/",
            "/_app",
            "/_app/immutable/entry/start.js/",
            "/_app//start.js",
            "/_app/./start.js",
            "/_app/../auth.json",
            "/_app/%2e%2e%2fauth.json",
            "/_app/unicode-%C3%BC.txt",
            "/_app/immutable/assets/no-extension",
            "/_app/immutable/assets/file.bin",
            "/index.html",
            "/service-worker.js/",
        ] {
            assert!(!claimed(fallback), "{fallback} should fall back");
        }
    }

    #[test]
    fn cache_headers_match_the_original() {
        assert_eq!(
            cache_control("/_app/immutable/x.js"),
            Some("public, max-age=31536000, immutable")
        );
        assert_eq!(
            cache_control("/icons/x.png"),
            Some("public, max-age=31536000, immutable")
        );
        assert_eq!(
            cache_control("/service-worker.js"),
            Some("no-cache, no-store, must-revalidate")
        );
        assert_eq!(
            cache_control("/_app/env.js"),
            Some("public, max-age=3600, must-revalidate")
        );
        assert_eq!(cache_control("/_app/env.JS"), None);
        assert_eq!(cache_control("/_app/data.wasm"), None);
    }

    #[tokio::test]
    async fn refuses_symlinks_that_leave_the_build() {
        let root = tempfile::tempdir().unwrap();
        let build = root.path().join("build");
        std::fs::create_dir_all(build.join("_app")).unwrap();
        std::fs::write(root.path().join("secret.json"), "{}").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            root.path().join("secret.json"),
            build.join("_app/leak.json"),
        )
        .unwrap();
        let request = claim(&Method::GET, &HeaderMap::new(), "/_app/leak.json").unwrap();
        assert_eq!(serve(&build, &request).await.status, StatusCode::NOT_FOUND);
    }
}
