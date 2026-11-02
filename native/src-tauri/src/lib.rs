mod deployment;
mod selection;

use deployment::Deployment;
use selection::ServerSelection;
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

type Selection = Mutex<Result<ServerSelection, String>>;

fn launcher_url_allowed(url: &url::Url, dev_url: Option<&url::Url>) -> bool {
    let local = matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.port().is_none();
    let dev = cfg!(debug_assertions) && dev_url.is_some_and(|dev| dev.origin() == url.origin());
    (local || dev)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "" | "/" | "/index.html")
}

#[tauri::command]
fn saved_server(selection: tauri::State<'_, Selection>) -> Result<Option<String>, String> {
    Ok(selection
        .lock()
        .map_err(|_| "Server settings are unavailable.")?
        .as_ref()
        .map_err(Clone::clone)?
        .last_url())
}

#[tauri::command]
fn connect_server(
    url: String,
    window: WebviewWindow,
    selection: tauri::State<'_, Selection>,
) -> Result<(), String> {
    let deployment = Deployment::parse(&url, cfg!(debug_assertions))?;
    let destination = deployment.url().clone();
    selection
        .lock()
        .map_err(|_| "Server settings are unavailable.")?
        .as_mut()
        .map_err(|error| error.clone())?
        .select(deployment)?;
    window
        .navigate(destination)
        .map_err(|_| "Unable to open the server.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![saved_server, connect_server])
        .setup(|app| {
            let selection = if cfg!(target_os = "android") {
                // Android's navigation callback excludes POST, including method-preserving redirects.
                Err(
                    "Server connections are unavailable in the Android build-only preview."
                        .to_string(),
                )
            } else {
                app.path()
                    .app_data_dir()
                    .map_err(|_| "Unable to locate the app settings directory.".to_string())
                    .and_then(|directory| ServerSelection::load(directory.join("servers.json")))
            };
            app.manage(Mutex::new(selection));
            let handle = app.handle().clone();
            let dev_url = app.config().build.dev_url.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Garcon")
                .inner_size(1200.0, 800.0)
                .on_navigation(move |url| {
                    let selection = handle.state::<Selection>();
                    let Ok(selection) = selection.lock() else {
                        return false;
                    };
                    match selection
                        .as_ref()
                        .ok()
                        .and_then(|saved| saved.active.as_ref())
                    {
                        Some(deployment) => deployment.allows(url),
                        None => launcher_url_allowed(url, dev_url.as_ref()),
                    }
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Garcon native client");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_tauri_launcher_urls_including_the_pathless_custom_origin() {
        for input in [
            "tauri://localhost",
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
        ] {
            assert!(
                launcher_url_allowed(&url::Url::parse(input).unwrap(), None),
                "{input}"
            );
        }
        for input in [
            "https://elsewhere.test/",
            "tauri://localhost/other",
            "http://tauri.localhost:8000/",
            "https://user@tauri.localhost/",
        ] {
            assert!(
                !launcher_url_allowed(&url::Url::parse(input).unwrap(), None),
                "{input}"
            );
        }
    }
}
