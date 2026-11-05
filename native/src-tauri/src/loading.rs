use crate::{
    host::{Host, locked},
    switcher::window_label,
};
use std::time::Duration;
use tauri::Manager;

pub fn refresh(app: &tauri::AppHandle) {
    if let Some(chooser) = app.get_webview_window("main") {
        let _ = chooser.eval("window.dispatchEvent(new Event('garcon-chooser-open'))");
    }
}

fn destroy(app: &tauri::AppHandle, id: u64) {
    if let Some(window) = app.get_webview_window(&window_label(id)) {
        #[cfg(not(target_os = "macos"))]
        let _ = window.remove_menu();
        let _ = window.destroy();
    }
}

pub fn start(app: &tauri::AppHandle, id: u64) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(message) = crate::host::open_remote(&handle, id) {
            let app = handle.clone();
            let _ = handle.run_on_main_thread(move || fail(&app, id, message));
        }
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            {
                let binding = app.state::<Host>();
                let Ok(mut host) = binding.lock() else { return };
                let Some(attempt) = host.attempt_mut(id) else {
                    return;
                };
                attempt.timed_out = true;
            }
            refresh(&app);
        });
    });
}

fn fail(app: &tauri::AppHandle, id: u64, message: String) {
    {
        let binding = app.state::<Host>();
        let Ok(mut host) = binding.lock() else { return };
        let Some(attempt) = host.attempt_mut(id) else {
            return;
        };
        attempt.failure = Some(message);
        host.windows.remove(&id);
    }
    destroy(app, id);
    refresh(app);
}

pub fn prepared(app: &tauri::AppHandle, id: u64, result: tauri::Result<()>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let preparation = (|| -> Result<(), String> {
            result.map_err(|_| "Unable to prepare the server window.")?;
            let placement = locked(handle.state::<Host>().inner())?
                .attempt(id)?
                .target
                .placement
                .clone();
            let window = handle
                .get_webview_window(&window_label(id))
                .ok_or("The server window was closed.")?;
            if let Some(placement) = placement {
                window
                    .set_size(placement.size)
                    .map_err(|_| "Unable to restore window size.")?;
                if let Some(position) = placement.position {
                    // Compositors such as Wayland may not permit restoring position.
                    let _ = window.set_position(position);
                }
                if placement.maximized {
                    window
                        .maximize()
                        .map_err(|_| "Unable to restore maximized window.")?;
                }
            }
            Ok(())
        })();
        if let Err(message) = preparation {
            fail(&handle, id, message);
            return;
        }
        if let Ok(mut host) = handle.state::<Host>().lock()
            && let Some(attempt) = host.attempt_mut(id)
        {
            attempt.prepared = true;
        }
        refresh(&handle);
        reveal_when_ready(&handle, id);
    });
}

pub fn document_started(app: &tauri::AppHandle, id: u64) {
    if let Ok(mut host) = app.state::<Host>().lock()
        && let Some(attempt) = host.attempt_mut(id)
    {
        attempt.document_started();
    }
}

pub fn ready(app: &tauri::AppHandle, id: u64) {
    if let Ok(mut host) = app.state::<Host>().lock()
        && let Some(attempt) = host.attempt_mut(id)
    {
        attempt.ready = true;
    }
    reveal_when_ready(app, id);
}

fn reveal_when_ready(app: &tauri::AppHandle, id: u64) {
    let document = app.state::<Host>().lock().ok().and_then(|host| {
        let attempt = host.attempt(id).ok()?;
        attempt.can_reveal().then_some(attempt.document)
    });
    if let Some(document) = document {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let current = handle.state::<Host>().lock().is_ok_and(|host| {
                host.attempt(id)
                    .is_ok_and(|attempt| attempt.document == document && attempt.can_reveal())
            });
            if current && let Err(message) = reveal(&handle, id) {
                fail(&handle, id, message);
            }
        });
    }
}

fn reveal(app: &tauri::AppHandle, id: u64) -> Result<(), String> {
    let window = app
        .get_webview_window(&window_label(id))
        .ok_or("The server window was closed.")?;
    let url = window
        .url()
        .map_err(|_| "Unable to read the server page URL.")?;
    {
        let binding = app.state::<Host>();
        let host = locked(binding.inner())?;
        host.attempt(id)?;
        if !host.allows_navigation(id, &url) {
            return Err("The loaded page is outside this server.".into());
        }
    }
    let chooser = app
        .get_webview_window("main")
        .ok_or("The server chooser was closed.")?;
    let focus = chooser.is_focused().unwrap_or(false);
    window
        .show()
        .map_err(|_| "Unable to show the server window.")?;
    let source = locked(app.state::<Host>().inner())?.complete_attempt(id)?;
    if let Some(source) = source {
        locked(app.state::<Host>().inner())?.retire(source);
        destroy(app, source);
    }
    let _ = chooser.hide();
    refresh(app);
    if focus {
        let _ = window.set_focus();
    }
    Ok(())
}

pub fn show(app: &tauri::AppHandle, id: u64) -> Result<(), String> {
    if !locked(app.state::<Host>().inner())?
        .attempt(id)?
        .status()
        .can_show
    {
        return Err("The server page is not available to show yet.".into());
    }
    reveal(app, id)
}

pub fn retry(app: &tauri::AppHandle, id: u64) -> Result<(), String> {
    let next = locked(app.state::<Host>().inner())?.retry_attempt(id)?;
    destroy(app, id);
    refresh(app);
    start(app, next);
    Ok(())
}

pub fn cancel(app: &tauri::AppHandle, id: u64) -> Result<(), String> {
    let target = {
        let binding = app.state::<Host>();
        let mut host = locked(binding.inner())?;
        host.cancel_attempt(id)?;
        let target = host.cancel_target();
        host.chooser_open = target.is_none();
        target
    };
    destroy(app, id);
    refresh(app);
    if let Some(target) = target
        && let Some(window) = app.get_webview_window(&window_label(target))
    {
        if let Some(chooser) = app.get_webview_window("main") {
            let _ = chooser.hide();
        }
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}
