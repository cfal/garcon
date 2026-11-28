//! Native serving of the SPA's static assets: the `/_app/*`, `/icons/*`, and
//! `/service-worker.js` routes of `server/controller/routes/static.ts`.
//!
//! The front door offers this unit only canonical requests without a `Range`
//! header (`native.rs`, ADR-004, ADR-005). Of those it claims the routes above
//! for extensions in the table below; it proxies other extensions.

use std::path::{Path, PathBuf};

use bytes::Bytes;
use garcon_js::path::native;
use hyper::header::{
    CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_TYPE, HeaderMap, HeaderValue,
};
use hyper::{Method, StatusCode};

use crate::app_title::{PublicAppTitle, apply_manifest_title, inject_app_title_into_shell};
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
const RUNTIME_BASE_PATH_TOKEN: &str = "__GARCON_RUNTIME_BASE_PATH__";

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
pub(crate) fn cache_control(pathname: &str) -> Option<&'static str> {
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
    let pathname = pathname.strip_prefix('/').unwrap_or(pathname).to_owned();
    tokio::task::spawn_blocking(move || {
        let cwd = std::env::current_dir().ok()?;
        let build_dir = native::resolve(cwd.to_str()?, &[build_dir.to_str()?]);
        let candidate = native::resolve(&build_dir, &[&pathname]);
        if !Path::new(&candidate).starts_with(&build_dir) {
            return None;
        }
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
    let response = file_response(request.pathname, request.content_type, contents);
    (response, Some(version))
}

fn file_response(pathname: &str, content_type: &'static str, contents: Bytes) -> NativeResponse {
    let mut headers = HeaderMap::new();
    if let Some(cache_control) = cache_control(pathname) {
        headers.insert(CACHE_CONTROL, HeaderValue::from_static(cache_control));
    }
    headers.insert(CONTENT_LENGTH, HeaderValue::from(contents.len()));
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    NativeResponse {
        status: StatusCode::OK,
        headers,
        body: contents,
    }
}

pub(crate) async fn read_path(build_dir: &Path, pathname: &str) -> Option<(PathBuf, Bytes)> {
    let (path, _) = resolve(build_dir, pathname).await?;
    let contents = tokio::fs::read(&path).await.ok()?;
    Some((path, Bytes::from(contents)))
}

async fn read_text(build_dir: &Path, pathname: &str) -> Option<String> {
    let (_, bytes) = read_path(build_dir, pathname).await?;
    let text = String::from_utf8_lossy(&bytes);
    Some(match text.strip_prefix('\u{feff}') {
        Some(without_bom) => without_bom.to_owned(),
        None => text.into_owned(),
    })
}

#[derive(Debug, thiserror::Error)]
#[error("Web shell is not runtime-mountable; run bun run build")]
pub struct UnmountableShell;

/// Renders the SPA shell at a base path normalized by controller config.
pub async fn serve_shell(
    build_dir: &Path,
    base_path: &str,
    app_title: &PublicAppTitle,
) -> Result<NativeResponse, UnmountableShell> {
    let Some(template) = read_text(build_dir, "/index.html").await else {
        return Ok(not_found());
    };
    if !template.contains(RUNTIME_BASE_PATH_TOKEN) {
        return Err(UnmountableShell);
    }
    let shell = template.replace(RUNTIME_BASE_PATH_TOKEN, base_path);
    let shell = inject_app_title_into_shell(&shell, app_title);
    Ok(file_response(
        "/index.html",
        "text/html; charset=utf-8",
        Bytes::from(shell),
    ))
}

pub async fn serve_manifest(
    build_dir: &Path,
    app_title: &PublicAppTitle,
) -> Result<NativeResponse, serde_json::Error> {
    let Some(template) = read_text(build_dir, "/site.webmanifest")
        .await
        .filter(|text| !text.is_empty())
    else {
        return Ok(not_found());
    };
    let manifest = apply_manifest_title(&template, app_title)?;
    Ok(file_response(
        "/site.webmanifest",
        "application/manifest+json; charset=utf-8",
        Bytes::from(manifest),
    ))
}

/// Serves a path selected by the controller's static route table. Unlike the
/// front door, the controller has to answer files with unlisted extensions.
pub async fn serve_path(build_dir: &Path, pathname: &str) -> NativeResponse {
    let Some((path, contents)) = read_path(build_dir, pathname).await else {
        return not_found();
    };
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    if let Some(content_type) = content_type_for(filename) {
        return file_response(pathname, content_type, contents);
    }
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default();
    let content_type = match extension.to_ascii_lowercase().as_str() {
        "eot" => "application/vnd.ms-fontobject",
        "pdf" => "application/pdf",
        "webmanifest" => "application/manifest+json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    };
    let mut response = file_response(pathname, content_type, contents);
    if !filename.contains('"')
        && let Ok(disposition) = HeaderValue::try_from(format!("filename=\"{filename}\""))
    {
        response.headers.insert(CONTENT_DISPOSITION, disposition);
    }
    response
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

    #[tokio::test]
    async fn serves_native_files_with_the_same_path_resolution_as_the_original() {
        let root = tempfile::tempdir().unwrap();
        let assets = root.path().join("_app/immutable");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("no-extension"), "payload").unwrap();
        std::fs::write(assets.join("app.js"), "app()").unwrap();
        std::fs::write(assets.join("unicode-\u{fc}.txt"), "payload").unwrap();
        let response = serve_path(root.path(), "/_app/immutable/no-extension").await;
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            response.headers[CONTENT_DISPOSITION],
            "filename=\"no-extension\""
        );
        assert_eq!(response.headers[CONTENT_TYPE], "application/octet-stream");
        assert_eq!(response.headers[CONTENT_LENGTH], "7");
        assert_eq!(response.body, "payload");
        let response = serve_path(root.path(), "/_app//immutable/app.js/").await;
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(
            response.headers[CONTENT_TYPE],
            "text/javascript;charset=utf-8"
        );
        assert!(!response.headers.contains_key(CONTENT_DISPOSITION));
        for path in [
            "/_app/immutable/",
            "/_app/immutable/unicode-%C3%BC.txt",
            "//_app/immutable/app.js",
        ] {
            assert_eq!(
                serve_path(root.path(), path).await.status,
                StatusCode::NOT_FOUND
            );
        }
    }

    #[tokio::test]
    async fn renders_the_shell_and_manifest_with_the_current_app_title() {
        let root = tempfile::tempdir().unwrap();
        let title = PublicAppTitle {
            title: "Notes & Review".into(),
            version: 4,
        };
        let build = root.path();
        assert_eq!(
            serve_shell(build, "/tools", &title).await.unwrap().status,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve_manifest(build, &title).await.unwrap().status,
            StatusCode::NOT_FOUND
        );
        std::fs::write(build.join("index.html"), "<head><title>Old</title></head>").unwrap();
        assert_eq!(
            serve_shell(build, "/tools", &title)
                .await
                .err()
                .unwrap()
                .to_string(),
            "Web shell is not runtime-mountable; run bun run build"
        );
        std::fs::write(
            build.join("index.html"),
            r#"<head><title>Old</title><link href="__GARCON_RUNTIME_BASE_PATH__/site.webmanifest" /></head>"#,
        ).unwrap();
        let shell = serve_shell(build, "/tools", &title).await.unwrap();
        let html = std::str::from_utf8(&shell.body).unwrap();
        assert!(html.contains(r#"href="/tools/site.webmanifest""#));
        assert!(html.contains("<title>Notes &amp; Review</title>"));
        assert!(html.contains(r#"{"title":"Notes & Review","version":4}"#));
        assert_eq!(shell.headers[CONTENT_TYPE], "text/html; charset=utf-8");
        assert_eq!(shell.headers[CONTENT_LENGTH], html.len().to_string());
        std::fs::write(
            build.join("site.webmanifest"),
            r#"{"name":"Old","start_url":"."}"#,
        )
        .unwrap();
        let manifest = serve_manifest(build, &title).await.unwrap();
        assert_eq!(
            manifest.headers[CONTENT_TYPE],
            "application/manifest+json; charset=utf-8"
        );
        assert_eq!(
            manifest.headers[CACHE_CONTROL],
            "no-cache, no-store, must-revalidate"
        );
        let data: serde_json::Value = garcon_js::json::from_slice(&manifest.body).unwrap();
        assert_eq!(data["name"], title.title);
        assert_eq!(data["short_name"], title.title);
        assert_eq!(data["start_url"], ".");
    }

    #[tokio::test]
    async fn returns_not_found_for_an_empty_manifest() {
        let build = tempfile::tempdir().unwrap();
        std::fs::write(build.path().join("site.webmanifest"), "").unwrap();
        let response = serve_manifest(build.path(), &PublicAppTitle::default())
            .await
            .unwrap();
        assert_eq!(response.status, StatusCode::NOT_FOUND);
        assert_eq!(response.body, not_found().body);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn omits_content_disposition_when_the_filename_contains_a_quote() {
        let build = tempfile::tempdir().unwrap();
        std::fs::write(build.path().join("quoted\"filename.bin"), "fixture").unwrap();
        let response = serve_path(build.path(), "/quoted\"filename.bin").await;
        assert_eq!(response.status, StatusCode::OK);
        assert_eq!(response.headers[CONTENT_TYPE], "application/octet-stream");
        assert!(!response.headers.contains_key(CONTENT_DISPOSITION));
    }
}
