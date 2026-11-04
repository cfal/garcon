use crate::{
    deployment::Deployment,
    platform::{ConnectionMode, connection_mode},
    switcher::{CHOOSER_REQUEST, ChooserAction, ServerChoices, Switcher},
};
use std::sync::Mutex;
use tauri::{Manager, WebviewWindow};

pub type Host = Mutex<Switcher>;

fn dispatch_chooser_request(host: &Host, generation: u64, dispatch: impl FnOnce()) {
    let requested = host
        .lock()
        .is_ok_and(|mut host| host.request_chooser(generation));
    // Tauri may execute a main-thread dispatch synchronously.
    if requested {
        dispatch();
    }
}

fn launcher(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the host chooser can change servers.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn server_choices(
    window: WebviewWindow,
    host: tauri::State<'_, Host>,
) -> Result<ServerChoices, String> {
    launcher(&window)?;
    host.lock()
        .map_err(|_| "Server settings are unavailable.")?
        .choices()
}

#[tauri::command]
pub fn remove_recent(
    url: String,
    generation: u64,
    window: WebviewWindow,
    host: tauri::State<'_, Host>,
) -> Result<(), String> {
    launcher(&window)?;
    let mut host = host
        .lock()
        .map_err(|_| "Server settings are unavailable.")?;
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
    let label = {
        let mut host = host
            .lock()
            .map_err(|_| "Server settings are unavailable.")?;
        host.check_generation(generation)?;
        if !host.choices()?.can_cancel {
            return Err("No current server page is open.".into());
        }
        let label = host.remote_label.clone().ok_or("No server page is open.")?;
        host.chooser_open = false;
        label
    };
    window.hide().map_err(|_| "Unable to close the chooser.")?;
    if let Some(remote) = window.app_handle().get_webview_window(&label) {
        let _ = remote.unminimize();
        let _ = remote.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn connect_server(
    url: String,
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
    let deployment = Deployment::parse(&url, cfg!(debug_assertions))?;
    if mode == ConnectionMode::SingleWebview {
        let destination = deployment.url().clone();
        app.state::<Host>()
            .lock()
            .map_err(|_| "Server settings are unavailable.")?
            .begin(generation, deployment, acknowledged)?;
        let result = window
            .navigate(destination)
            .map_err(|_| "Unable to open the server.".to_string());
        app.state::<Host>()
            .lock()
            .map_err(|_| "Server settings are unavailable.")?
            .pending = false;
        return result;
    }
    #[cfg(desktop)]
    {
        let (generation, previous) = app
            .state::<Host>()
            .lock()
            .map_err(|_| "Server settings are unavailable.")?
            .begin(generation, deployment.clone(), acknowledged)?;
        let mut result = replace_remote(&app, generation, previous, deployment).await;
        if result.is_ok() {
            result = window
                .hide()
                .map_err(|_| "Unable to close the chooser.".to_string());
        }
        {
            let host = app.state::<Host>();
            let mut host = host
                .lock()
                .map_err(|_| "Server settings are unavailable.")?;
            host.pending = false;
            host.chooser_open = result.is_err();
        }
        result
    }
    #[cfg(mobile)]
    Err("The desktop server switcher is unavailable on this platform.".into())
}

#[cfg(desktop)]
async fn replace_remote(
    app: &tauri::AppHandle,
    generation: u64,
    previous: Option<String>,
    deployment: Deployment,
) -> Result<(), String> {
    if let Some(previous) = previous.and_then(|label| app.get_webview_window(&label)) {
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        previous.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = sender.try_send(());
            }
        });
        previous
            .destroy()
            .map_err(|_| "Unable to close the previous server page. Restart the app to retry.")?;
        receiver
            .recv()
            .await
            .ok_or("Unable to confirm the previous page closed.")?;
        app.state::<Host>()
            .lock()
            .map_err(|_| "Server settings are unavailable.")?
            .remote_label = None;
    }
    let label = format!("server-{generation}");
    let navigation_app = app.clone();
    let window = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::External(deployment.url().clone()),
    )
    .title("Garcon")
    .inner_size(1200.0, 800.0)
    .initialization_script(include_str!("../bridge.js"))
    .on_navigation(move |destination| {
        let host = navigation_app.state::<Host>();
        if destination.as_str() == CHOOSER_REQUEST {
            dispatch_chooser_request(&host, generation, || {
                let handle = navigation_app.clone();
                let _ = navigation_app.run_on_main_thread(move || {
                    let current = handle.state::<Host>().lock().is_ok_and(|host| {
                        host.accepts(generation) && host.chooser_open && !host.pending
                    });
                    if !current {
                        return;
                    }
                    let _ = present_chooser(&handle);
                });
            });
            return false;
        }
        host.lock()
            .is_ok_and(|host| host.allows_navigation(generation, destination))
    })
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .build()
    .map_err(|_| "Unable to open the server page. Choose another server or retry.".to_string())?;
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. })
            && handle
                .state::<Host>()
                .lock()
                .is_ok_and(|host| host.accepts(generation))
        {
            handle.exit(0);
        }
    });
    app.state::<Host>()
        .lock()
        .map_err(|_| "Server settings are unavailable.")?
        .remote_label = Some(label);
    crate::external_links::install(&window, generation)
        .map_err(|_| "Unable to install native link handling. Choose another server or retry.")?;
    Ok(())
}

pub fn present_chooser(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        window.eval("window.dispatchEvent(new Event('garcon-chooser-open'))")?;
    }
    Ok(())
}

#[cfg(desktop)]
pub fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    let switch = MenuItem::with_id(
        app,
        "switch-server",
        "Switch Server...",
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
    let server = Submenu::with_items(app, "Server", true, &[&switch, &reload, &quit])?;
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
            "switch-server" => ChooserAction::Switch,
            "reload-server" => ChooserAction::Reload,
            _ => return,
        };
        {
            let host = app.state::<Host>();
            let Ok(mut host) = host.lock() else {
                return;
            };
            if host.pending {
                return;
            }
            if host.chooser_open {
                drop(host);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                return;
            }
            host.action = action;
            host.chooser_open = true;
        }
        let _ = present_chooser(app);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chooser_dispatch_releases_its_lock_before_synchronous_presentation() {
        let mut switcher = Switcher::new(Err("Synthetic settings".into()));
        switcher.chooser_open = false;
        switcher.generation = 3;
        let host = Mutex::new(switcher);
        let mut presented = 0;
        dispatch_chooser_request(&host, 3, || {
            let current = host.try_lock().expect("presentation must not deadlock");
            assert!(current.accepts(3) && current.chooser_open);
            presented += 1;
        });
        dispatch_chooser_request(&host, 3, || panic!("duplicate presentation"));
        dispatch_chooser_request(&host, 2, || panic!("stale presentation"));
        assert_eq!(presented, 1);
    }
}
