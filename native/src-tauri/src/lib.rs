mod chrome;
mod deployment;
mod external_links;
mod host;
mod platform;
mod selection;
mod switcher;

use selection::ServerSelection;
use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            host::server_choices,
            host::connect_server,
            host::cancel_chooser,
            host::remove_recent
        ])
        .setup(|app| {
            #[cfg(target_os = "linux")]
            chrome::setup()?;
            let mode = platform::connection_mode(std::env::consts::OS);
            let selection = if mode == platform::ConnectionMode::Disabled {
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
            app.manage(Mutex::new(switcher::Switcher::new(selection)));
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            host::install_menu(app.handle())?;
            let dev_url = app.config().build.dev_url.clone();
            let navigation_app = app.handle().clone();
            let chooser =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Garcon")
                    .inner_size(520.0, 720.0)
                    .visible(cfg!(mobile))
                    .disable_drag_drop_handler()
                    .on_navigation(move |url| {
                        let host = navigation_app.state::<host::Host>();
                        let Ok(host) = host.lock() else {
                            return false;
                        };
                        let active = host
                            .selection
                            .as_ref()
                            .ok()
                            .and_then(|selection| selection.active.as_ref());
                        platform::main_navigation_allowed(mode, active, url, dev_url.as_ref())
                    })
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                    .build()?;
            let handle = app.handle().clone();
            chooser.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let host = handle.state::<host::Host>();
                    let Ok(host) = host.lock() else {
                        return;
                    };
                    if host.pending {
                        api.prevent_close();
                        return;
                    }
                    if host.remote_label.is_some() {
                        api.prevent_close();
                        let generation = host.generation;
                        drop(host);
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = host::cancel_chooser(generation, window, handle.state());
                        }
                    } else {
                        handle.exit(0);
                    }
                }
            });
            #[cfg(desktop)]
            chrome::show_initial(&chooser)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Garcon native client");
}
