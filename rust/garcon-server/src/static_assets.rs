//! Native serving of the SPA's static assets: the `/_app/*`, `/icons/*`, and
//! `/service-worker.js` routes of `server/controller/routes/static.ts`.
//!
//! The front door offers this unit only canonical requests without a `Range`
//! header (`native.rs`, ADR-004, ADR-005). Of those it claims the routes above
//! for extensions in the table below; other extensions go to the original.

use std::path::{Path, PathBuf};

use bytes::Bytes;
use hyper::header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, HeaderMap, HeaderValue};
use hyper::{Method, StatusCode};

use crate::asset_cache::{AssetCache, FileVersion};
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

fn content_type_for(pathname: &str) -> Option<&'static str> {
    let file_name = pathname.rsplit('/').next()?;
    let (_, extension) = file_name.rsplit_once('.')?;
    CONTENT_TYPES
        .iter()
        .find(|(candidate, _)| extension.eq_ignore_ascii_case(candidate))
        .map(|(_, content_type)| *content_type)
}

/// Returns the asset request when this unit serves `pathname`, a canonical
/// request path with the base path already removed.
pub fn claim<'a>(method: &Method, pathname: &'a str) -> Option<AssetRequest<'a>> {
    if method != Method::GET && method != Method::HEAD {
        return None;
    }
    let routed = pathname == SERVICE_WORKER
        || STATIC_PREFIXES
            .iter()
            .any(|prefix| pathname.len() > prefix.len() && pathname.starts_with(prefix));
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
///
/// The three lookups run in one blocking task rather than three round trips
/// to the blocking pool.
async fn resolve(build_dir: &Path, pathname: &str) -> Option<(PathBuf, std::fs::Metadata)> {
    let build_dir = build_dir.to_path_buf();
    let candidate = build_dir.join(pathname.trim_start_matches('/'));
    tokio::task::spawn_blocking(move || {
        let real_build = std::fs::canonicalize(&build_dir).ok()?;
        let real_candidate = std::fs::canonicalize(&candidate).ok()?;
        if !real_candidate.starts_with(&real_build) {
            return None;
        }
        let metadata = std::fs::metadata(&real_candidate)
            .ok()
            .filter(|metadata| metadata.is_file())?;
        Some((real_candidate, metadata))
    })
    .await
    .ok()
    .flatten()
}

/// Serves the asset, from `cache` when this version of the file is cached.
/// Returns the file version alongside the response so its encodings can be
/// cached too.
pub async fn serve(
    build_dir: &Path,
    request: &AssetRequest<'_>,
    cache: &AssetCache,
) -> (NativeResponse, Option<FileVersion>) {
    let Some((path, metadata)) = resolve(build_dir, request.pathname).await else {
        return (not_found(), None);
    };
    let version = FileVersion::of(path, &metadata);
    let contents = match cache.contents(&version) {
        Some(contents) => contents,
        None => {
            let Ok(contents) = tokio::fs::read(&version.path).await else {
                return (not_found(), None);
            };
            let contents = Bytes::from(contents);
            cache.store_contents(&version, &contents);
            contents
        }
    };
    let mut headers = HeaderMap::new();
    if let Some(cache_control) = cache_control(request.pathname) {
        headers.insert(CACHE_CONTROL, HeaderValue::from_static(cache_control));
    }
    headers.insert(CONTENT_LENGTH, HeaderValue::from(contents.len()));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(request.content_type));
    let response = NativeResponse {
        status: StatusCode::OK,
        headers,
        body: contents,
    };
    (response, Some(version))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_its_routes_for_known_extensions() {
        let claimed = |path| claim(&Method::GET, path).is_some();
        assert!(claimed("/_app/immutable/entry/start.js"));
        assert!(claimed("/_app/version.json"));
        assert!(claimed("/icons/icon.SVG"));
        assert!(claimed("/service-worker.js"));
        assert!(claim(&Method::HEAD, "/icons/icon.svg").is_some());
        assert!(claim(&Method::POST, "/icons/icon.svg").is_none());
        for fallback in [
            "/_app/",
            "/_app",
            "/_app/immutable/assets/no-extension",
            "/_app/immutable/assets/file.bin",
            "/index.html",
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
        let request = claim(&Method::GET, "/_app/leak.json").unwrap();
        assert_eq!(
            serve(&build, &request, &AssetCache::new(1 << 20))
                .await
                .0
                .status,
            StatusCode::NOT_FOUND
        );
    }
}
