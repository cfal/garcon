use std::cell::Cell;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::time::Duration;

use bytes::Bytes;
use garcon_base::http_body::get_token_from_request;
use garcon_base::http_error::json_error;
use garcon_base::server_runtime::ServerRuntimeState;
use garcon_contract::server_runtime::{CLI_SERVER_INSTANCE_HEADER, ServerRuntimeIdentity};
use garcon_http::compose_routes;
use garcon_http::http_route::{HttpRouteOptions, HttpRouter, cli_instance_mismatch};
use garcon_http::http_route_types::{
    AuthenticateHttpRequest, Route, RouteFuture, RouteMetadata, RouteResponse, ServerPrincipal,
};
use garcon_http::listener::{HttpRequest, Listener};
use garcon_http::{app_title, routes};
use http::{HeaderValue, Method, Request, Response};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::LocalSet;
use tokio_util::sync::CancellationToken;

struct FixtureAuth;

impl AuthenticateHttpRequest for FixtureAuth {
    fn authenticate<'a>(
        &'a self,
        request: &'a HttpRequest,
    ) -> RouteFuture<'a, Result<ServerPrincipal, Box<RouteResponse>>> {
        Box::pin(async move {
            if get_token_from_request(request).as_deref() == Some("fixture") {
                Ok(ServerPrincipal::Local)
            } else {
                Err(Box::new(
                    json_error(
                        "Invalid token",
                        401.0,
                        Some("AUTH_SESSION_INVALID"),
                        None,
                        None,
                    )
                    .unwrap()
                    .map(Some),
                ))
            }
        })
    }
}

async fn exchange(addr: SocketAddr, method: &str, path: &str, headers: &str) -> String {
    let mut socket = TcpStream::connect(addr).await.unwrap();
    socket
        .write_all(
            format!("{method} {path} HTTP/1.1\r\nConnection: close\r\n{headers}\r\n").as_bytes(),
        )
        .await
        .unwrap();
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(3), socket.read_to_string(&mut response))
        .await
        .unwrap()
        .unwrap();
    response
}

fn options(shutting_down: Rc<Cell<bool>>, auth_disabled: bool) -> HttpRouteOptions {
    HttpRouteOptions {
        base_path: "/tools".into(),
        auth_disabled,
        compression_enabled: true,
        server_instance_id: Some("fixture-instance".into()),
        shutting_down,
        unported_log: None,
    }
}

async fn start(router: HttpRouter) -> (SocketAddr, CancellationToken) {
    let listener = Listener::bind("0.0.0.0", 0, 1024, 0).await.unwrap();
    let addr = SocketAddr::from(([127, 0, 0, 1], listener.local_addr().unwrap().port()));
    let router = Rc::new(router);
    let shutdown = CancellationToken::new();
    tokio::task::spawn_local(listener.serve(
        move |request, peer| {
            let router = Rc::clone(&router);
            async move { router.handle(request, peer).await }
        },
        shutdown.clone(),
    ));
    (addr, shutdown)
}

const HOST: &str = "Host: localhost\r\n";
const AUTHORIZED: &str = "Host: localhost\r\nAuthorization: Bearer fixture\r\n";

#[tokio::test]
async fn unmatched_paths_and_methods_validate_host_unless_shutting_down() {
    LocalSet::new()
        .run_until(async {
            let closing = Rc::new(Cell::new(false));
            let router = HttpRouter::new(
                compose_routes::RouteMap::new(),
                options(closing.clone(), false),
                Rc::new(FixtureAuth),
            )
            .unwrap();
            let (addr, shutdown) = start(router).await;
            for (method, path) in [("GET", "/tools/unknown"), ("PUT", "/tools/api/v1/tickets")] {
                let result = exchange(addr, method, path, "Host: a b\r\n").await;
                assert!(result.starts_with("HTTP/1.1 500 "), "{result}");
                assert!(result.contains("INTERNAL_ERROR"), "{result}");
            }
            let mut socket = TcpStream::connect(addr).await.unwrap();
            socket
                .write_all(b"GET /tools/unknown HTTP/1.0\r\n\r\n")
                .await
                .unwrap();
            let mut result = String::new();
            tokio::time::timeout(Duration::from_secs(3), socket.read_to_string(&mut result))
                .await
                .unwrap()
                .unwrap();
            assert!(result.starts_with("HTTP/1.0 500 "), "{result}");
            assert!(result.contains("INTERNAL_ERROR"), "{result}");
            closing.set(true);
            for headers in [HOST, "Host: a b\r\n"] {
                let result = exchange(addr, "GET", "/tools/unknown", headers).await;
                assert!(result.starts_with("HTTP/1.1 503 "), "{result}");
                assert!(result.contains("SERVER_SHUTTING_DOWN"), "{result}");
            }
            shutdown.cancel();
        })
        .await;
}

#[tokio::test]
async fn only_recognized_unported_routes_return_the_marker_and_are_logged() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let log = root.path().join("unported.log");
            let mut config = options(Rc::new(Cell::new(false)), false);
            config.unported_log = Some(log.clone());
            let router = HttpRouter::new(
                compose_routes::RouteMap::new(),
                config,
                Rc::new(FixtureAuth),
            )
            .unwrap();
            let (addr, shutdown) = start(router).await;
            for (method, path) in [
                ("POST", "/wrong/api/v1/tickets/project-default"),
                ("PUT", "/tools/api/v1/tickets/project-default"),
                ("GET", "/tools/unknown"),
            ] {
                let result = exchange(addr, method, path, HOST).await;
                assert!(result.starts_with("HTTP/1.1 404 "), "{result}");
                assert!(result.ends_with("\r\n\r\nNot found"), "{result}");
                assert!(!result.contains("x-garcon-rs-unported:"), "{result}");
            }
            let result =
                exchange(addr, "POST", "/tools/api/v1/tickets/project-default", HOST).await;
            assert!(result.starts_with("HTTP/1.1 401 "), "{result}");
            assert!(result.contains("cache-control: no-store"), "{result}");
            let duplicate = format!("{AUTHORIZED}Authorization: Bearer surplus\r\n");
            let result = exchange(
                addr,
                "POST",
                "/tools/api/v1/tickets/project-default",
                &duplicate,
            )
            .await;
            assert!(result.starts_with("HTTP/1.1 401 "), "{result}");
            assert!(result.contains("AUTH_SESSION_INVALID"), "{result}");
            assert!(!log.exists());
            let result = exchange(
                addr,
                "POST",
                "/tools/api/v1/tickets/project-default?project=default",
                AUTHORIZED,
            )
            .await;
            assert!(result.starts_with("HTTP/1.1 501 "), "{result}");
            assert!(result.contains("x-garcon-rs-unported: 1"), "{result}");
            assert!(result.ends_with(r#"{"error":"not ported"}"#), "{result}");
            assert_eq!(
                tokio::fs::read_to_string(log).await.unwrap(),
                "POST /tools/api/v1/tickets/project-default\n"
            );
            shutdown.cancel();
        })
        .await;
}

#[tokio::test]
async fn wraps_the_handler_after_auth_and_preserves_route_headers_on_failure() {
    LocalSet::new()
        .run_until(async {
            let closing = Rc::new(Cell::new(false));
            let mut metadata = RouteMetadata {
                no_auth: true,
                ..Default::default()
            };
            metadata
                .response_headers
                .insert("x-fixture", HeaderValue::from_static("always"));
            let public = Route::new(metadata, |_request, url, context| async move {
                assert_eq!(url.path(), "/fixture");
                assert!(context.principal.is_none());
                Ok(Response::new(Some(Bytes::from_static(b"public"))))
            });
            let routes = compose_routes::RouteMap::from([(
                "/fixture".into(),
                [(Method::GET, public)].into(),
            )]);
            let router = HttpRouter::new(
                routes,
                options(closing.clone(), false),
                Rc::new(FixtureAuth),
            )
            .unwrap();
            let (addr, shutdown) = start(router).await;
            let result = exchange(addr, "GET", "/tools?next=%2Fchat", HOST).await;
            assert!(result.starts_with("HTTP/1.1 308 "), "{result}");
            assert!(
                result.contains("location: /tools/?next=%2Fchat"),
                "{result}"
            );
            let mismatched = format!("{HOST}{CLI_SERVER_INSTANCE_HEADER}: obsolete\r\n");
            let result = exchange(addr, "GET", "/tools/fixture", &mismatched).await;
            assert!(result.starts_with("HTTP/1.1 200 "), "{result}");
            let result = exchange(addr, "GET", "/tools/fixture", "Host: a b\r\n").await;
            assert!(result.starts_with("HTTP/1.1 500 "), "{result}");
            assert!(result.contains("x-fixture: always"), "{result}");
            assert!(result.contains("INTERNAL_ERROR"), "{result}");
            let result = exchange(
                addr,
                "POST",
                "/tools/api/v1/tickets/project-default",
                "Host: a b\r\n",
            )
            .await;
            assert!(result.starts_with("HTTP/1.1 401 "), "{result}");
            let result = exchange(
                addr,
                "POST",
                "/tools/api/v1/tickets/project-default",
                &format!("{AUTHORIZED}{CLI_SERVER_INSTANCE_HEADER}: obsolete\r\n"),
            )
            .await;
            assert!(result.starts_with("HTTP/1.1 409 "), "{result}");
            assert!(result.contains("CLI_CONTROLLER_CHANGED"), "{result}");
            closing.set(true);
            let result = exchange(addr, "GET", "/tools/fixture", HOST).await;
            assert!(result.starts_with("HTTP/1.1 503 "), "{result}");
            assert!(result.contains("x-fixture: always"), "{result}");
            assert!(result.contains("SERVER_SHUTTING_DOWN"), "{result}");
            shutdown.cancel();
        })
        .await;
}

#[tokio::test]
async fn disabled_auth_uses_the_local_principal_and_still_checks_cli_identity() {
    LocalSet::new()
        .run_until(async {
            let public = Route::new(
                RouteMetadata {
                    no_auth: true,
                    ..Default::default()
                },
                |_, _, context| async move {
                    assert_eq!(context.principal, Some(ServerPrincipal::Local));
                    Ok(Response::new(Some(Bytes::from_static(b"local"))))
                },
            );
            let routes = compose_routes::RouteMap::from([(
                "/fixture".into(),
                [(Method::GET, public)].into(),
            )]);
            let router = HttpRouter::new(
                routes,
                options(Rc::new(Cell::new(false)), true),
                Rc::new(FixtureAuth),
            )
            .unwrap();
            let (addr, shutdown) = start(router).await;
            let result = exchange(addr, "GET", "/tools/fixture", HOST).await;
            assert!(result.starts_with("HTTP/1.1 200 "), "{result}");
            let result = exchange(
                addr,
                "GET",
                "/tools/fixture",
                &format!("{HOST}{CLI_SERVER_INSTANCE_HEADER}: obsolete\r\n"),
            )
            .await;
            assert!(result.starts_with("HTTP/1.1 409 "), "{result}");
            shutdown.cancel();
        })
        .await;
}

#[test]
fn cli_instance_compares_the_complete_fetch_header() {
    let single = Request::builder()
        .header(CLI_SERVER_INSTANCE_HEADER, "current")
        .body(())
        .unwrap();
    assert!(cli_instance_mismatch(&single, Some("current")).is_none());
    let mut duplicate = single;
    duplicate.headers_mut().append(
        CLI_SERVER_INSTANCE_HEADER,
        HeaderValue::from_static("other"),
    );
    let reply = cli_instance_mismatch(&duplicate, Some("current")).unwrap();
    assert_eq!(reply.status(), 409);
}

#[test]
fn json_response_preserves_status_content_type_and_json_bytes() {
    let response = garcon_http::json_route::json_response(
        http::StatusCode::BAD_REQUEST,
        &serde_json::json!({"error": "fixture"}),
    )
    .unwrap();
    assert_eq!(response.status(), 400);
    assert_eq!(
        response.headers()["content-type"],
        "application/json;charset=utf-8"
    );
    assert_eq!(response.into_body().unwrap(), r#"{"error":"fixture"}"#);
}

async fn edge_routes(web_build_dir: PathBuf, config: &Path) -> compose_routes::RouteMap<Route> {
    use garcon_js::{Clock, SystemClock};
    use garcon_stores::auth::passwords::BunPasswords;
    use garcon_stores::auth::service::AuthService;
    use garcon_stores::auth::store::AuthAccountStore;
    use garcon_stores::auth::token::AuthTokens;

    let clock: Rc<dyn Clock> = Rc::new(SystemClock);
    let store = AuthAccountStore::open(config.to_str().unwrap(), clock.clone())
        .await
        .unwrap();
    let service = Rc::new(AuthService::new(
        store,
        AuthTokens::new("30d".into(), clock.clone()),
        Rc::new(BunPasswords),
        clock,
    ));
    let auth = routes::auth::AuthRoutes::new(service, false, false).unwrap();
    let runtime = Rc::new(ServerRuntimeState {
        identity: ServerRuntimeIdentity {
            schema_version: 1,
            instance_id: "fixture-instance".into(),
            workspace_dir: "/fixture/workspace".into(),
            started_at: "2026-01-01T00:00:00.000Z".into(),
        },
        local_capability: "garcon_local_fixture".into(),
    });
    routes::create_edge_routes(
        runtime,
        Some("fixture".into()),
        routes::r#static::StaticRoutes {
            web_build_dir,
            base_path: "/tools".into(),
            app_title: Rc::new(app_title::PublicAppTitle::default),
        },
        &auth,
    )
    .unwrap()
}

#[tokio::test]
async fn unported_inventory_matches_the_original_after_subtracting_registered_handlers() {
    let config = tempfile::tempdir().unwrap();
    let edge_routes = LocalSet::new()
        .run_until(edge_routes("/fixture/build".into(), config.path()))
        .await;
    use garcon_stores::tickets::{service::TicketServiceOptions, setup::initialize_tickets};
    let tickets = Rc::new(initialize_tickets(
        config.path(),
        TicketServiceOptions {
            chat_exists: None,
            commands_enabled: Rc::new(|| false),
            on_invalidated: None,
            clock: Rc::new(garcon_js::SystemClock),
        },
    ));
    let routes = compose_routes::compose_routes([
        &edge_routes,
        &routes::tickets::create_ticket_routes(&tickets),
    ])
    .unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("bun")
        .arg("rust/garcon-http/tests/oracles/unported-routes.ts")
        .args(routes.iter().flat_map(|(path, methods)| {
            methods.keys().map(move |method| format!("{method} {path}"))
        }))
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        include_str!("../src/unported-routes.json"),
        std::str::from_utf8(&output.stdout).unwrap(),
    );
}

#[tokio::test]
async fn native_routes_serve_the_shell_and_runtime_with_their_original_access_rules() {
    LocalSet::new().run_until(async {
        let build = tempfile::tempdir().unwrap();
        let config = tempfile::tempdir().unwrap();
        std::fs::write(
            build.path().join("index.html"),
            r#"<head><title>Before</title><link href="__GARCON_RUNTIME_BASE_PATH__/site.webmanifest" /></head>"#,
        ).unwrap();
        let router = HttpRouter::new(
            edge_routes(build.path().to_path_buf(), config.path()).await,
            options(Rc::new(Cell::new(false)), false),
            Rc::new(FixtureAuth),
        ).unwrap();
        let (addr, shutdown) = start(router).await;
        let shell = exchange(addr, "GET", "/tools/chat/fixture", HOST).await;
        assert!(shell.starts_with("HTTP/1.1 200 "), "{shell}");
        assert!(shell.contains(r#"href="/tools/site.webmanifest""#), "{shell}");
        assert!(shell.contains("<title>Garcon</title>"), "{shell}");
        let runtime = exchange(addr, "GET", "/tools/api/v1/runtime?challenge=invalid", HOST).await;
        assert!(runtime.starts_with("HTTP/1.1 400 "), "{runtime}");
        assert!(runtime.contains("cache-control: no-store"), "{runtime}");
        assert!(runtime.ends_with(r#"{"error":"challenge must be 32-byte base64url data"}"#), "{runtime}");
        let challenge = "A".repeat(43);
        let proof = exchange(addr, "GET", &format!("/tools/api/v1/runtime?challenge={challenge}"), HOST).await;
        assert!(proof.starts_with("HTTP/1.1 200 "), "{proof}");
        let (_, body) = proof.split_once("\r\n\r\n").unwrap();
        let json = garcon_js::json::parse(body).unwrap();
        assert_eq!(json["schemaVersion"], 1.0);
        assert_eq!(json["instanceId"], "fixture-instance");
        assert_eq!(json["proof"].as_str().unwrap().len(), 43);
        let context = exchange(addr, "GET", "/tools/api/v1/cli/context", HOST).await;
        assert!(context.starts_with("HTTP/1.1 401 "), "{context}");
        let context = exchange(addr, "GET", "/tools/api/v1/cli/context", AUTHORIZED).await;
        assert!(context.starts_with("HTTP/1.1 200 "), "{context}");
        assert!(context.contains("cache-control: no-store"), "{context}");
        assert!(context.ends_with(r#"{"serverInstanceId":"fixture-instance","defaultExecutorId":"local","workspaceName":"fixture"}"#), "{context}");
        shutdown.cancel();
    }).await;
}

#[tokio::test]
async fn native_head_preserves_buns_fallback_redirect_and_file_headers() {
    LocalSet::new()
        .run_until(async {
            let build = tempfile::tempdir().unwrap();
            let config = tempfile::tempdir().unwrap();
            std::fs::create_dir(build.path().join("_app")).unwrap();
            std::fs::write(build.path().join("_app/no-extension"), "payload").unwrap();
            let router = HttpRouter::new(
                edge_routes(build.path().to_path_buf(), config.path()).await,
                options(Rc::new(Cell::new(false)), false),
                Rc::new(FixtureAuth),
            )
            .unwrap();
            let (addr, shutdown) = start(router).await;
            for (path, status, length, omitted) in [
                ("/outside", "404", "9", "content-type:"),
                ("/tools", "308", "0", "content-type:"),
                (
                    "/tools/_app/no-extension",
                    "200",
                    "7",
                    "content-disposition:",
                ),
            ] {
                let response = exchange(addr, "HEAD", path, HOST).await;
                let (head, body) = response.split_once("\r\n\r\n").unwrap();
                assert!(
                    head.starts_with(&format!("HTTP/1.1 {status} ")),
                    "{response}"
                );
                assert!(
                    head.contains(&format!("\r\ncontent-length: {length}")),
                    "{head}"
                );
                assert!(!head.contains(omitted), "{head}");
                assert!(body.is_empty(), "{response}");
            }
            shutdown.cancel();
        })
        .await;
}
