#[cfg(desktop)]
use crate::switcher::{CHOOSER_REQUEST, ChooserAction, window_label};
use crate::{
    deployment::Deployment,
    platform::{ConnectionMode, connection_mode},
    switcher::{ServerChoices, Switcher},
};
use std::sync::{Mutex, MutexGuard};
use tauri::{Manager, WebviewWindow};

pub type Host = Mutex<Switcher>;

fn locked(host: &Host) -> Result<MutexGuard<'_, Switcher>, String> {
    host.lock()
        .map_err(|_| "Server settings are unavailable.".into())
}

#[cfg(any(desktop, test))]
fn dispatch_chooser_request(host: &Host, id: u64, dispatch: impl FnOnce(u64)) {
    let revision = host.lock().ok().and_then(|mut host| {
        host.request_chooser(Some(id), crate::switcher::ChooserAction::Open)
            .then_some(host.generation)
    });
    // Tauri may execute a main-thread dispatch synchronously.
    if let Some(revision) = revision {
        dispatch(revision);
    }
}

fn launcher(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the host chooser can open servers.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn server_choices(
    window: WebviewWindow,
    host: tauri::State<'_, Host>,
) -> Result<ServerChoices, String> {
    launcher(&window)?;
    locked(host.inner())?.choices()
}

#[tauri::command]
pub fn remove_recent(
    url: String,
    generation: u64,
    window: WebviewWindow,
    host: tauri::State<'_, Host>,
) -> Result<(), String> {
    launcher(&window)?;
    let mut host = locked(host.inner())?;
    host.check_generation(generation)?;
    host.selection
        .as_mut()
        .map_err(|error| error.clone())?
        .remove_recent(&url)
}

#[tauri::command]
pub fn cancel_chooser(
    generation: u64,
    window: WebviewWindow,
    host: tauri::State<'_, Host>,
) -> Result<(), String> {
    launcher(&window)?;
    let target = {
        let mut host = locked(host.inner())?;
        host.check_generation(generation)?;
        host.selection.as_ref().map_err(Clone::clone)?;
        let target = host.cancel_target().ok_or("No server page is open.")?;
        host.chooser_open = false;
        target
    };
    window.hide().map_err(|_| "Unable to close the chooser.")?;
    if let Some(remote) = window
        .app_handle()
        .get_webview_window(&crate::switcher::window_label(target))
    {
        #[cfg(desktop)]
        let _ = remote.unminimize();
        let _ = remote.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn connect_server(
    url: String,
    name: Option<String>,
    generation: u64,
    acknowledged: bool,
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<(), String> {
    launcher(&window)?;
    let mode = connection_mode(std::env::consts::OS);
    if mode == ConnectionMode::Disabled {
        return Err("Server connections are unavailable in the Android build-only preview.".into());
    }
    let deployment = Deployment::parse(&url)?;
    let (id, previous) = locked(app.state::<Host>().inner())?.begin(
        generation,
        deployment.clone(),
        name,
        acknowledged,
    )?;
    if mode == ConnectionMode::SingleWebview {
        let result = window
            .navigate(deployment.url().clone())
            .map_err(|_| "Unable to open the server.".to_string());
        locked(app.state::<Host>().inner())?.pending = false;
        return result;
    }
    #[cfg(desktop)]
    {
        let mut result = open_remote(&app, id, previous).await;
        if result.is_err() {
            locked(app.state::<Host>().inner())?.retire(id);
            if let Some(failed) = app.get_webview_window(&window_label(id)) {
                #[cfg(not(target_os = "macos"))]
                let _ = failed.remove_menu();
                let _ = failed.destroy();
            }
        }
        if result.is_ok() {
            result = window
                .hide()
                .map_err(|_| "Unable to close the chooser.".to_string());
        }
        let show_chooser = {
            let mut host = locked(app.state::<Host>().inner())?;
            host.pending = false;
            host.chooser_open = result.is_err() || host.windows.is_empty();
            host.chooser_open
        };
        if show_chooser {
            // Refreshes the snapshot after failed creation or a close during startup.
            let _ = present_chooser(&app);
        }
        result
    }
    #[cfg(mobile)]
    {
        let _ = (id, previous);
        Err("The desktop server chooser is unavailable on this platform.".into())
    }
}

#[cfg(desktop)]
async fn open_remote(app: &tauri::AppHandle, id: u64, previous: Option<u64>) -> Result<(), String> {
    if let Some(previous) = previous.and_then(|id| app.get_webview_window(&window_label(id))) {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        previous.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = sender.try_send(());
            }
        });
        #[cfg(not(target_os = "macos"))]
        previous
            .remove_menu()
            .map_err(|_| "Unable to detach the previous server menu. Restart the app to retry.")?;
        previous
            .destroy()
            .map_err(|_| "Unable to close the previous server page. Restart the app to retry.")?;
        receiver
            .recv()
            .await
            .ok_or("Unable to confirm the previous page closed.")?;
    }
    let server = locked(app.state::<Host>().inner())?
        .windows
        .get(&id)
        .cloned()
        .ok_or("The server window was closed.")?;
    let title = server.title();
    let navigation_app = app.clone();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        window_label(id),
        tauri::WebviewUrl::External(server.deployment.url().clone()),
    )
    .title(&title)
    .inner_size(1200.0, 800.0)
    .visible(false)
    .decorations(!server.titlebar_hidden)
    .disable_drag_drop_handler()
    .initialization_script(format!(
        "{}({});",
        include_str!("../bridge.js"),
        server.titlebar_hidden
    ))
    .on_navigation(move |destination| {
        if let Some(hidden) = crate::chrome::requested_titlebar_hidden(destination) {
            request_titlebar_visibility(&navigation_app, id, hidden);
            return false;
        }
        let host = navigation_app.state::<Host>();
        if destination.as_str() == CHOOSER_REQUEST {
            dispatch_chooser_request(&host, id, |revision| {
                let handle = navigation_app.clone();
                let _ = navigation_app.run_on_main_thread(move || {
                    let current = handle.state::<Host>().lock().is_ok_and(|host| {
                        host.generation == revision
                            && host.windows.contains_key(&id)
                            && host.chooser_open
                            && !host.pending
                    });
                    if current {
                        let _ = present_chooser(&handle);
                    }
                });
            });
            return false;
        }
        host.lock()
            .is_ok_and(|host| host.allows_navigation(id, destination))
    })
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_page_load(move |window, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished {
            return;
        }
        let snapshot = window
            .app_handle()
            .state::<Host>()
            .lock()
            .ok()
            .and_then(|host| {
                host.windows
                    .get(&id)
                    .map(|server| crate::chrome::TitlebarSnapshot {
                        hidden: server.titlebar_hidden,
                        failed: false,
                    })
            });
        if let Some(snapshot) = snapshot {
            let _ = crate::chrome::publish_titlebar_snapshot(&window, snapshot);
        }
    })
    .build()
    .map_err(|_| "Unable to open the server page. Choose another server or retry.")?;
    let handle = app.clone();
    #[cfg(not(target_os = "macos"))]
    let closing_window = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Focused(true) => {
            if let Ok(mut host) = handle.state::<Host>().lock()
                && host.windows.contains_key(&id)
            {
                host.focused_window = Some(id);
            }
        }
        tauri::WindowEvent::CloseRequested { .. } => {
            #[cfg(not(target_os = "macos"))]
            let _ = closing_window.remove_menu();
        }
        tauri::WindowEvent::Destroyed => {
            let show = handle
                .state::<Host>()
                .lock()
                .is_ok_and(|mut host| host.retire(id));
            if show {
                let _ = present_chooser(&handle);
            }
        }
        _ => {}
    });
    crate::external_links::install(&window, id)
        .map_err(|_| "Unable to install native link handling. Choose another server or retry.")?;
    crate::chrome::show_initial(&window)
        .map_err(|_| "Unable to show the server page. Choose another server or retry.")?;
    Ok(())
}

#[cfg(desktop)]
fn request_titlebar_visibility(app: &tauri::AppHandle, id: u64, hidden: bool) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let current = handle
            .state::<Host>()
            .lock()
            .is_ok_and(|host| host.windows.contains_key(&id));
        if !current {
            return;
        }
        let Some(window) = handle.get_webview_window(&window_label(id)) else {
            return;
        };
        let failed = window.set_decorations(!hidden).is_err();
        let snapshot = {
            let host = handle.state::<Host>();
            let Ok(mut host) = host.lock() else { return };
            let Some(server) = host.windows.get_mut(&id) else {
                return;
            };
            if !failed {
                server.titlebar_hidden = hidden;
            }
            crate::chrome::TitlebarSnapshot {
                hidden: server.titlebar_hidden,
                failed,
            }
        };
        let _ = crate::chrome::publish_titlebar_snapshot(&window, snapshot);
    });
}

#[cfg(desktop)]
fn present_chooser(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        window.eval("window.dispatchEvent(new Event('garcon-chooser-open'))")?;
    }
    Ok(())
}

#[cfg(desktop)]
pub fn request_host_chooser(app: &tauri::AppHandle, source: Option<u64>, action: ChooserAction) {
    let refresh = {
        let Ok(mut host) = app.state::<Host>().inner().lock() else {
            return;
        };
        if host.pending || source.is_some_and(|id| !host.windows.contains_key(&id)) {
            return;
        }
        if host.chooser_open {
            false
        } else {
            if !host.request_chooser(source, action) {
                return;
            }
            true
        }
    };
    if refresh {
        let _ = present_chooser(app);
    } else if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    let switch = MenuItem::with_id(
        app,
        "switch-server",
        "Open server...",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let reload = MenuItem::with_id(
        app,
        "reload-server",
        "Reload Server...",
        true,
        Some("CmdOrCtrl+R"),
    )?;
    let quit = PredefinedMenuItem::quit(app, None)?;
    let server = Submenu::with_items(
        app,
        if cfg!(target_os = "macos") {
            "Garcon"
        } else {
            "Server"
        },
        true,
        &[&switch, &reload, &quit],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(app, &[&server, &edit])?)?;
    app.on_menu_event(|app, event| {
        let action = match event.id().as_ref() {
            "switch-server" => ChooserAction::Open,
            "reload-server" => ChooserAction::Reload,
            _ => return,
        };
        let source = app
            .state::<Host>()
            .lock()
            .ok()
            .and_then(|host| host.focused_window);
        request_host_chooser(app, source, action);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::switcher::ServerWindow;

    #[test]
    fn chooser_dispatch_releases_its_lock_before_synchronous_presentation() {
        let mut switcher = Switcher::new(Err("Synthetic settings".into()));
        switcher.chooser_open = false;
        switcher.windows.insert(
            3,
            ServerWindow {
                deployment: Deployment::parse("https://synthetic.test/").unwrap(),
                name: None,
                titlebar_hidden: false,
            },
        );
        let host = Mutex::new(switcher);
        let mut presented = 0;
        dispatch_chooser_request(&host, 3, |revision| {
            let current = host.try_lock().expect("presentation must not deadlock");
            assert_eq!(current.generation, revision);
            assert!(current.chooser_open);
            presented += 1;
        });
        dispatch_chooser_request(&host, 3, |_| panic!("duplicate presentation"));
        dispatch_chooser_request(&host, 2, |_| panic!("unknown page"));
        assert_eq!(presented, 1);
    }
}
