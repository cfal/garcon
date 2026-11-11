#[cfg(desktop)]
use tauri::WebviewWindow;

#[cfg(desktop)]
#[derive(serde::Serialize)]
pub struct TitlebarSnapshot {
    pub hidden: bool,
    pub failed: bool,
}

#[cfg(any(desktop, test))]
pub fn requested_titlebar_hidden(destination: &url::Url) -> Option<bool> {
    match destination.as_str() {
        "garcon-host://hide-titlebar/" => Some(true),
        "garcon-host://show-titlebar/" => Some(false),
        _ => None,
    }
}

#[cfg(desktop)]
pub fn publish_titlebar_snapshot(
    window: &WebviewWindow,
    snapshot: TitlebarSnapshot,
) -> tauri::Result<()> {
    window.eval(format!(
        "window.dispatchEvent(new CustomEvent('garcon-titlebar-state', {{ detail: {} }}))",
        serde_json::to_string(&snapshot)?
    ))
}

#[cfg(target_os = "linux")]
pub fn setup() -> Result<(), Box<dyn std::error::Error>> {
    use gtk::prelude::CssProviderExt;

    let provider = gtk::CssProvider::new();
    provider.load_from_data(include_bytes!("../titlebar.css"))?;
    if let Some(screen) = gtk::gdk::Screen::default() {
        gtk::StyleContext::add_provider_for_screen(
            &screen,
            &provider,
            gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
        );
    }
    Ok(())
}

#[cfg(desktop)]
pub fn show_initial(window: &WebviewWindow) -> tauri::Result<()> {
    let shown = window.clone();
    prepare(window, move |result| {
        if result.is_ok() {
            let _ = present(&shown);
        }
    })
}

#[cfg(desktop)]
pub fn present(window: &WebviewWindow) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        // Mapping synchronously lets GTK accept focus before presentation.
        let native = window.gtk_window()?;
        native.show_all();
        native.present();
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        window.show()?;
        window.set_focus()?;
        window.as_ref().set_focus()
    }
}

#[cfg(desktop)]
pub fn prepare(
    window: &WebviewWindow,
    complete: impl FnOnce(tauri::Result<()>) + Send + 'static,
) -> tauri::Result<()> {
    #[cfg(target_os = "windows")]
    window.hide_menu()?;
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        use tauri::Manager;

        let handle = window.app_handle().clone();
        let source = crate::switcher::window_id(window.label());
        let title = window.title()?;
        let window = window.clone();
        let dispatch = window.clone();
        dispatch.run_on_main_thread(move || {
            let gtk_window = match window.gtk_window() {
                Ok(window) => window,
                Err(error) => return complete(Err(error)),
            };
            let header = gtk::HeaderBar::new();
            header.set_title(Some(&title));
            header.set_has_subtitle(false);
            header.set_show_close_button(true);
            header.style_context().add_class("garcon-titlebar");
            if window.label() != "main" {
                let chooser = gtk::Button::from_icon_name(
                    Some("network-server-symbolic"),
                    gtk::IconSize::Menu,
                );
                chooser.set_focus_on_click(false);
                chooser.set_tooltip_text(Some("Open server"));
                chooser.connect_clicked(move |_| {
                    crate::host::request_host_chooser(&handle, source);
                });
                header.pack_start(&chooser);
            }
            gtk_window.set_titlebar(Some(&header));
            header.show_all();
            complete(Ok(()));
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        complete(Ok(()));
        Ok(())
    }
}

#[cfg(test)]
mod titlebar_tests {
    use super::requested_titlebar_hidden;

    #[test]
    fn titlebar_requests_require_exact_host_owned_urls() {
        for (url, hidden) in [
            ("garcon-host://hide-titlebar/", true),
            ("garcon-host://show-titlebar/", false),
        ] {
            assert_eq!(
                requested_titlebar_hidden(&url::Url::parse(url).unwrap()),
                Some(hidden)
            );
        }
        for url in [
            "https://hide-titlebar/",
            "garcon-host://hide-titlebar/?hidden=true",
            "garcon-host://hide-titlebar/#fragment",
            "garcon-host://user@hide-titlebar/",
            "garcon-host://hide-titlebar:123/",
            "garcon-host://hide-titlebar/extra",
            "garcon-host://switch-server/",
            "garcon-host://show-titlebar//",
        ] {
            assert_eq!(
                requested_titlebar_hidden(&url::Url::parse(url).unwrap()),
                None,
                "{url}"
            );
        }
    }
}
