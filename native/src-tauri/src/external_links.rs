#[cfg(any(target_os = "linux", test))]
use crate::deployment::Deployment;
#[cfg(any(target_os = "linux", test))]
use std::time::{Duration, Instant};
#[cfg(any(target_os = "linux", test))]
use url::Url;

#[cfg(any(target_os = "linux", test))]
fn destination(deployment: &Deployment, source: &str, target: &str) -> Option<Url> {
    let source = Url::parse(source).ok()?;
    if !deployment.allows(&source)
        || target.len() > 8192
        || target.contains('\\')
        || target.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let url = Url::parse(target).ok()?;
    // Requires the platform's canonical absolute URL, not a second interpretation of it.
    if url.as_str() != target
        || !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.origin() == deployment.url().origin()
        || url.path().contains('%')
        || url.path().contains("//")
        || is_auth_url(&url)
    {
        return None;
    }
    Some(url)
}

#[cfg(any(target_os = "linux", test))]
fn page_destination(
    host: &crate::switcher::Switcher,
    generation: u64,
    source: &str,
    target: &str,
) -> Option<Url> {
    let window = host.windows.get(&generation)?;
    destination(&window.deployment, source, target)
}

#[cfg(any(target_os = "linux", test))]
fn is_auth_url(url: &Url) -> bool {
    let auth_segment = |part: &str| {
        matches!(
            part.to_ascii_lowercase().as_str(),
            "auth"
                | "oauth"
                | "oauth2"
                | "authorize"
                | "authorization"
                | "login"
                | "signin"
                | "sign-in"
                | "callback"
                | "device"
                | "device-code"
        )
    };
    url.host_str().is_some_and(|host| {
        host.split('.')
            .any(|part| auth_segment(part) || part == "accounts")
    }) || url
        .path_segments()
        .is_some_and(|mut parts| parts.any(auth_segment))
        || url.query_pairs().any(|(key, _)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "client_id"
                    | "redirect_uri"
                    | "redirect_url"
                    | "response_type"
                    | "code"
                    | "state"
                    | "token"
                    | "access_token"
                    | "id_token"
                    | "device_code"
                    | "user_code"
                    | "code_challenge"
                    | "code_verifier"
            )
        })
        || url
            .fragment()
            .is_some_and(|fragment| fragment.contains('='))
}

#[cfg(any(target_os = "linux", test))]
#[derive(Default)]
struct LaunchGate(Option<Instant>);

#[cfg(any(target_os = "linux", test))]
impl LaunchGate {
    fn admit(&mut self, now: Instant) -> bool {
        if self
            .0
            .is_some_and(|previous| now.duration_since(previous) < Duration::from_secs(1))
        {
            return false;
        }
        self.0 = Some(now);
        true
    }
}

#[cfg(target_os = "linux")]
pub fn install(window: &tauri::WebviewWindow, generation: u64) -> tauri::Result<()> {
    use gtk::prelude::*;
    use std::cell::RefCell;
    use tauri::Manager;
    use webkit2gtk::{
        NavigationPolicyDecision, NavigationPolicyDecisionExt, NavigationType, PolicyDecisionExt,
        PolicyDecisionType, URIRequestExt, WebViewExt,
    };

    let handle = window.app_handle().clone();
    window.with_webview(move |platform| {
        let gate = RefCell::new(LaunchGate::default());
        platform.inner().connect_decide_policy(move |view, decision, kind| {
            if kind != PolicyDecisionType::NewWindowAction {
                return false;
            }
            // Leaves Wry's existing document-navigation guard and popup denial intact.
            decision.ignore();
            let Some(mut action) = decision
                .downcast_ref::<NavigationPolicyDecision>()
                .and_then(|policy| policy.navigation_action())
            else {
                return true;
            };
            if action.navigation_type() != NavigationType::LinkClicked
                || !action.is_user_gesture()
                || action.is_redirect()
            {
                return true;
            }
            let Some(request) = action.request() else { return true };
            if request.http_method().as_deref() != Some("GET") {
                return true;
            }
            let (Some(source), Some(target)) = (view.uri(), request.uri()) else { return true };
            let host = handle.state::<crate::host::Host>();
            let Ok(host) = host.lock() else { return true };
            let Some(url) = page_destination(&host, generation, &source, &target) else { return true };
            drop(host);
            if !gate.borrow_mut().admit(Instant::now()) {
                return true;
            }
            let parent = view.toplevel().and_then(|widget| widget.downcast::<gtk::Window>().ok());
            if gtk::show_uri_on_window(parent.as_ref(), url.as_str(), gtk::current_event_time()).is_err() {
                // Does not log potentially private URLs or retry an uncertain OS dispatch.
                let dialog = gtk::MessageDialog::new(
                    parent.as_ref(),
                    gtk::DialogFlags::DESTROY_WITH_PARENT,
                    gtk::MessageType::Error,
                    gtk::ButtonsType::Close,
                    "Unable to open the browser. Check the system's default HTTP/HTTPS application.",
                );
                dialog.set_title("Garcon");
                dialog.connect_response(|dialog, _| dialog.close());
                dialog.show();
            }
            true
        });
    })
}

// Tauri's portable callbacks do not attest a user gesture. Other hosts stay fail-closed.
#[cfg(not(target_os = "linux"))]
pub fn install(_window: &tauri::WebviewWindow, _generation: u64) -> tauri::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepts(source: &str, target: &str) -> bool {
        let deployment = Deployment::parse("https://selected.test/garcon/").unwrap();
        destination(&deployment, source, target).is_some()
    }

    const SOURCE: &str = "https://selected.test/garcon/chat/synthetic";

    #[test]
    fn fences_external_links_during_switches_and_from_replaced_pages() {
        let directory = std::env::temp_dir().join(format!(
            "garcon-native-link-generation-{}",
            std::process::id()
        ));
        let selection =
            crate::selection::ServerSelection::load(directory.join("servers.json")).unwrap();
        let mut host = crate::switcher::Switcher::new(Ok(selection));
        host.windows.insert(
            2,
            crate::switcher::ServerWindow {
                deployment: Deployment::parse("https://selected.test/garcon/").unwrap(),
                name: None,
                titlebar_hidden: false,
            },
        );
        let target = "https://external.example.test/guide";
        assert!(page_destination(&host, 2, SOURCE, target).is_some());
        assert!(page_destination(&host, 1, SOURCE, target).is_none());
        host.pending = true;
        assert!(page_destination(&host, 2, SOURCE, target).is_some());
        host.pending = false;
        let window = host.windows.remove(&2).unwrap();
        host.windows.insert(3, window);
        assert!(page_destination(&host, 2, SOURCE, target).is_none());
        assert!(page_destination(&host, 3, SOURCE, target).is_some());
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn accepts_canonical_http_links_without_changing_deployment_scope() {
        for target in [
            "https://docs.example.test/guide?q=hello%20world#section",
            "http://example.test:8080/guide",
            "https://github.com/example/project/pull/123",
        ] {
            assert!(accepts(SOURCE, target), "{target}");
        }
        for target in [
            "https://selected.test/garcon/",
            "https://selected.test/other/",
        ] {
            assert!(!accepts(SOURCE, target), "{target}");
        }
    }

    #[test]
    fn rejects_launcher_and_stale_or_out_of_mount_sources() {
        for source in [
            "tauri://localhost/",
            "https://previous.test/garcon/",
            "https://selected.test/other/",
            "https://user@selected.test/garcon/",
            "https://selected.test/garcon/%2fother",
            "invalid",
        ] {
            assert!(!accepts(source, "https://example.test/"), "{source}");
        }
    }

    #[test]
    fn rejects_unsafe_ambiguous_and_oversized_destinations() {
        for target in [
            "javascript:alert(1)",
            "data:text/html,test",
            "file:///etc/passwd",
            "mailto:user@example.test",
            "blob:https://example.test/id",
            "about:blank",
            "https://user:password@example.test/",
            "https://user@example.test/",
            "https://@example.test/",
            "https://example.test\\@other.test/",
            "https://example.test/a/../b",
            "https://example.test//path",
            "https://example.test/%2e%2e/",
            "https://example.test/%2fother",
            "https://exa\nmple.test/",
            " https://example.test/",
            "//example.test/",
            "https:example.test",
            "https://%65xample.test/",
            "https://example.test:443/",
        ] {
            assert!(!accepts(SOURCE, target), "{target}");
        }
        assert!(!accepts(
            SOURCE,
            &format!("https://example.test/{}", "a".repeat(8192))
        ));
    }

    #[test]
    fn excludes_authentication_and_callback_flows() {
        for target in [
            "https://auth.openai.com/codex/device",
            "https://claude.ai/oauth/authorize",
            "https://github.com/login/device",
            "https://accounts.example.test/",
            "https://example.test/OAuth2/start",
            "https://example.test/%6cogin",
            "https://example.test/?client_id=synthetic",
            "https://example.test/?redirect_uri=https%3A%2F%2Fselected.test",
            "https://example.test/?%63ode=synthetic",
            "https://example.test/?STATE=synthetic",
            "https://example.test/#access_token=synthetic",
            "https://example.test/callback",
        ] {
            assert!(!accepts(SOURCE, target), "{target}");
        }
    }

    #[test]
    fn bounds_repeated_launches_without_scheduling_retries() {
        let mut gate = LaunchGate::default();
        let now = Instant::now();
        assert!(gate.admit(now));
        assert!(!gate.admit(now));
        assert!(!gate.admit(now + Duration::from_millis(999)));
        assert!(gate.admit(now + Duration::from_secs(1)));
    }
}
