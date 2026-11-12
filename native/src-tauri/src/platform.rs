use crate::deployment::Deployment;
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionMode {
    Disabled,
    SingleWebview,
    Switcher,
}

pub fn connection_mode(target_os: &str) -> ConnectionMode {
    match target_os {
        "ios" => ConnectionMode::SingleWebview,
        "linux" | "windows" | "macos" => ConnectionMode::Switcher,
        _ => ConnectionMode::Disabled,
    }
}

pub fn main_navigation_allowed(
    mode: ConnectionMode,
    active: Option<&Deployment>,
    url: &Url,
    dev_url: Option<&Url>,
) -> bool {
    if mode == ConnectionMode::SingleWebview
        && let Some(active) = active
    {
        return active.allows(url);
    }
    launcher_url_allowed(url, dev_url)
}

fn launcher_url_allowed(url: &Url, dev_url: Option<&Url>) -> bool {
    let local = matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
    ) && url.port().is_none();
    // Tauri development mode also supports release-profile Rust builds.
    let dev = tauri::is_dev() && dev_url.is_some_and(|dev| dev.origin() == url.origin());
    (local || dev)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "" | "/" | "/index.html")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_ios_connections_without_enabling_android_or_mobile_switching() {
        assert_eq!(connection_mode("ios"), ConnectionMode::SingleWebview);
        assert_eq!(connection_mode("android"), ConnectionMode::Disabled);
        assert_eq!(connection_mode("unknown"), ConnectionMode::Disabled);
        for platform in ["linux", "windows", "macos"] {
            assert_eq!(connection_mode(platform), ConnectionMode::Switcher);
        }
    }

    #[test]
    fn ios_main_changes_from_local_launcher_to_the_confined_deployment() {
        let mode = connection_mode("ios");
        let deployment = Deployment::parse("https://synthetic.test/mount/").unwrap();
        let launcher = Url::parse("tauri://localhost/").unwrap();
        assert!(main_navigation_allowed(mode, None, &launcher, None));
        assert!(!main_navigation_allowed(mode, None, deployment.url(), None));
        assert!(main_navigation_allowed(
            mode,
            Some(&deployment),
            deployment.url(),
            None
        ));
        for destination in [
            "tauri://localhost/",
            "https://synthetic.test/other/",
            "https://other.test/mount/",
        ] {
            assert!(!main_navigation_allowed(
                mode,
                Some(&deployment),
                &Url::parse(destination).unwrap(),
                None
            ));
        }
    }

    #[test]
    fn desktop_and_disabled_main_never_admit_remote_content() {
        let deployment = Deployment::parse("https://synthetic.test/mount/").unwrap();
        for mode in [ConnectionMode::Switcher, ConnectionMode::Disabled] {
            assert!(!main_navigation_allowed(
                mode,
                Some(&deployment),
                deployment.url(),
                None
            ));
            assert!(main_navigation_allowed(
                mode,
                Some(&deployment),
                &Url::parse("tauri://localhost/").unwrap(),
                None
            ));
        }
    }

    #[test]
    fn accepts_only_the_local_launcher_routes() {
        for input in [
            "tauri://localhost",
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
        ] {
            assert!(
                launcher_url_allowed(&Url::parse(input).unwrap(), None),
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
                !launcher_url_allowed(&Url::parse(input).unwrap(), None),
                "{input}"
            );
        }
    }

    #[test]
    fn configured_dev_origin_follows_tauri_mode_not_rust_profile() {
        let dev_url = Url::parse("http://127.0.0.1:1430/").unwrap();
        for mode in [
            ConnectionMode::Switcher,
            ConnectionMode::SingleWebview,
            ConnectionMode::Disabled,
        ] {
            for path in ["/", "/index.html"] {
                let url = dev_url.join(path).unwrap();
                assert_eq!(
                    main_navigation_allowed(mode, None, &url, Some(&dev_url)),
                    tauri::is_dev(),
                    "{mode:?}: {url}"
                );
                assert!(!main_navigation_allowed(mode, None, &url, None));
            }
        }
    }

    #[test]
    fn configured_dev_origin_keeps_launcher_and_ios_navigation_confined() {
        let dev_url = Url::parse("http://127.0.0.1:1430/").unwrap();
        for input in [
            "http://127.0.0.1:1431/",
            "https://127.0.0.1:1430/",
            "http://localhost:1430/",
            "http://other.test:1430/",
            "http://127.0.0.1:1430/other",
            "http://user@127.0.0.1:1430/",
            "http://user:password@127.0.0.1:1430/",
        ] {
            assert!(
                !launcher_url_allowed(&Url::parse(input).unwrap(), Some(&dev_url)),
                "{input}"
            );
        }
        let deployment = Deployment::parse("https://synthetic.test/mount/").unwrap();
        assert!(!main_navigation_allowed(
            ConnectionMode::SingleWebview,
            Some(&deployment),
            &dev_url,
            Some(&dev_url)
        ));
        assert!(main_navigation_allowed(
            ConnectionMode::SingleWebview,
            Some(&deployment),
            deployment.url(),
            Some(&dev_url)
        ));
    }
}
