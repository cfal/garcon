#[cfg(desktop)]
use tauri::WebviewWindow;

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
    #[cfg(target_os = "windows")]
    window.hide_menu()?;
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        use tauri::Manager;

        let handle = window.app_handle().clone();
        let window = window.clone();
        let dispatch = window.clone();
        dispatch.run_on_main_thread(move || {
            let Ok(gtk_window) = window.gtk_window() else {
                return;
            };
            let shortcut_handle = handle.clone();
            gtk_window.connect_key_press_event(move |_, event| {
                use crate::switcher::ChooserAction;
                use gtk::glib::Propagation;

                match recovery_shortcut(event.keyval(), event.state()) {
                    Some(RecoveryShortcut::Switch) => {
                        crate::host::request_host_chooser(&shortcut_handle, ChooserAction::Switch)
                    }
                    Some(RecoveryShortcut::Reload) => {
                        crate::host::request_host_chooser(&shortcut_handle, ChooserAction::Reload)
                    }
                    Some(RecoveryShortcut::Quit) => shortcut_handle.exit(0),
                    None => return Propagation::Proceed,
                }
                Propagation::Stop
            });
            let header = gtk::HeaderBar::new();
            header.set_title(Some("Garcon"));
            header.set_has_subtitle(false);
            header.set_show_close_button(true);
            header.style_context().add_class("garcon-titlebar");
            if window.label() != "main" {
                let chooser = gtk::Button::from_icon_name(
                    Some("network-server-symbolic"),
                    gtk::IconSize::Menu,
                );
                chooser.set_focus_on_click(false);
                chooser.set_tooltip_text(Some("Switch Server"));
                chooser.connect_clicked(move |_| {
                    crate::host::request_host_chooser(
                        &handle,
                        crate::switcher::ChooserAction::Switch,
                    );
                });
                header.pack_start(&chooser);
            }
            gtk_window.set_titlebar(Some(&header));
            header.show_all();
            if window.show().is_ok() {
                let _ = window.set_focus();
            }
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        window.show()?;
        window.set_focus()
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug, PartialEq, Eq)]
enum RecoveryShortcut {
    Switch,
    Reload,
    Quit,
}

#[cfg(target_os = "linux")]
fn recovery_shortcut(
    key: gtk::gdk::keys::Key,
    modifiers: gtk::gdk::ModifierType,
) -> Option<RecoveryShortcut> {
    use gtk::gdk::{ModifierType as M, keys::constants};

    let modifiers = modifiers
        & (M::CONTROL_MASK
            | M::SHIFT_MASK
            | M::MOD1_MASK
            | M::SUPER_MASK
            | M::HYPER_MASK
            | M::META_MASK);
    match key.to_lower() {
        constants::s if modifiers == M::CONTROL_MASK | M::SHIFT_MASK => {
            Some(RecoveryShortcut::Switch)
        }
        constants::r if modifiers == M::CONTROL_MASK => Some(RecoveryShortcut::Reload),
        constants::q if modifiers == M::CONTROL_MASK => Some(RecoveryShortcut::Quit),
        _ => None,
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use gtk::gdk::{ModifierType as M, keys::constants};

    #[test]
    fn preserves_only_the_existing_host_recovery_shortcuts() {
        assert_eq!(
            recovery_shortcut(constants::S, M::CONTROL_MASK | M::SHIFT_MASK),
            Some(RecoveryShortcut::Switch)
        );
        assert_eq!(
            recovery_shortcut(constants::r, M::CONTROL_MASK),
            Some(RecoveryShortcut::Reload)
        );
        assert_eq!(
            recovery_shortcut(constants::R, M::CONTROL_MASK | M::LOCK_MASK),
            Some(RecoveryShortcut::Reload)
        );
        assert_eq!(
            recovery_shortcut(constants::q, M::CONTROL_MASK),
            Some(RecoveryShortcut::Quit)
        );
        for (key, modifiers) in [
            (constants::s, M::CONTROL_MASK),
            (constants::r, M::CONTROL_MASK | M::MOD1_MASK),
            (constants::R, M::CONTROL_MASK | M::SHIFT_MASK),
            (constants::r, M::SUPER_MASK),
            (constants::q, M::empty()),
            (constants::z, M::CONTROL_MASK),
        ] {
            assert_eq!(recovery_shortcut(key, modifiers), None);
        }
    }
}
