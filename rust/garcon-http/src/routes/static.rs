use std::path::PathBuf;
use std::rc::Rc;

use http::header::CONTENT_DISPOSITION;
use http::{Method, Response};

use super::super::app_title::PublicAppTitle;
use super::super::compose_routes::RouteMap;
use super::super::compression::NativeResponse;
use super::super::http_route_types::{Route, RouteMetadata, RouteResponse};
use super::super::static_assets::{serve_manifest, serve_path, serve_shell};

pub struct StaticRoutes {
    pub web_build_dir: PathBuf,
    pub base_path: String,
    pub app_title: Rc<dyn Fn() -> PublicAppTitle>,
}

fn as_route_response(native: NativeResponse) -> RouteResponse {
    let mut response = Response::new(Some(native.body));
    *response.status_mut() = native.status;
    *response.headers_mut() = native.headers;
    response
}

pub fn create_static_routes(options: StaticRoutes) -> RouteMap<Route> {
    let options = Rc::new(options);
    let public = RouteMetadata {
        no_auth: true,
        ..Default::default()
    };
    let shell_options = Rc::clone(&options);
    let shell = Route::new(public.clone(), move |_, _, _| {
        let options = Rc::clone(&shell_options);
        async move {
            let title = (options.app_title)();
            Ok(as_route_response(
                serve_shell(&options.web_build_dir, &options.base_path, &title).await?,
            ))
        }
    });
    let manifest_options = Rc::clone(&options);
    let manifest = Route::new(public.clone(), move |_, _, _| {
        let options = Rc::clone(&manifest_options);
        async move {
            let title = (options.app_title)();
            Ok(as_route_response(
                serve_manifest(&options.web_build_dir, &title).await?,
            ))
        }
    });
    let file_options = Rc::clone(&options);
    let file = Route::new(public.clone(), move |request, url, _| {
        let options = Rc::clone(&file_options);
        let head = request.method() == Method::HEAD;
        async move {
            let mut file = serve_path(&options.web_build_dir, url.path()).await;
            if head {
                // Bun adds this implicit header only when sending the file body.
                file.headers.remove(CONTENT_DISPOSITION);
            }
            Ok(as_route_response(file))
        }
    });
    let worker = Route::new(public, move |_, _, _| {
        let options = Rc::clone(&options);
        async move {
            Ok(as_route_response(
                serve_path(&options.web_build_dir, "/service-worker.js").await,
            ))
        }
    });
    let get = |route| [(Method::GET, route)].into();
    RouteMap::from([
        ("/".into(), get(shell.clone())),
        ("/index.html".into(), get(shell.clone())),
        ("/icons/*".into(), get(file.clone())),
        ("/site.webmanifest".into(), get(manifest)),
        ("/service-worker.js".into(), get(worker)),
        ("/_app/*".into(), get(file)),
        ("/chat".into(), get(shell.clone())),
        ("/chat/".into(), get(shell.clone())),
        ("/chat/:id".into(), get(shell.clone())),
        ("/setup".into(), get(shell.clone())),
        ("/login".into(), get(shell)),
    ])
}
