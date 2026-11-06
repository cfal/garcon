use crate::switcher::ServerWindow;
use serde::Serialize;
use url::Url;

#[derive(Clone)]
pub struct WindowPlacement {
    pub size: tauri::PhysicalSize<u32>,
    pub position: Option<tauri::PhysicalPosition<i32>>,
    pub maximized: bool,
}

#[derive(Clone)]
pub struct ConnectionTarget {
    pub server: ServerWindow,
    pub url: Url,
    pub placement: Option<WindowPlacement>,
}

pub struct ConnectionAttempt {
    pub id: u64,
    pub target: ConnectionTarget,
    pub source: Option<u64>,
    pub prepared: bool,
    pub ready: bool,
    pub document: u64,
    pub failure: Option<String>,
    pub timed_out: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    pub id: u64,
    pub server: String,
    pub url: String,
    pub message: Option<String>,
    pub ready: bool,
    pub can_retry: bool,
    pub can_show: bool,
}

impl ConnectionAttempt {
    pub fn new(id: u64, target: ConnectionTarget, source: Option<u64>) -> Self {
        Self {
            id,
            target,
            source,
            prepared: false,
            ready: false,
            document: 0,
            failure: None,
            timed_out: false,
        }
    }

    pub fn status(&self) -> ConnectionStatus {
        let ready = self.can_reveal();
        ConnectionStatus {
            id: self.id,
            server: self.target.server.display_name().to_string(),
            url: self.target.server.deployment.url().to_string(),
            message: self.failure.clone().or_else(|| {
                (self.timed_out && !ready).then(|| "Garcon has not become ready.".into())
            }),
            ready,
            can_retry: self.can_retry(),
            can_show: self.can_show(),
        }
    }

    pub fn can_retry(&self) -> bool {
        self.prepared || self.failure.is_some()
    }

    pub fn can_show(&self) -> bool {
        self.prepared && (self.ready || self.timed_out) && self.failure.is_none()
    }

    pub fn can_reveal(&self) -> bool {
        self.prepared && self.ready && self.failure.is_none()
    }

    pub fn document_started(&mut self) {
        self.document += 1;
        self.ready = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployment::Deployment;

    fn attempt() -> ConnectionAttempt {
        let deployment = Deployment::parse("https://synthetic.test/mount/").unwrap();
        let url = deployment
            .url()
            .join("chat/example?mode=review#latest")
            .unwrap();
        ConnectionAttempt::new(
            1,
            ConnectionTarget {
                server: ServerWindow {
                    deployment,
                    name: Some("Work".into()),
                    titlebar_hidden: true,
                },
                url,
                placement: None,
            },
            Some(0),
        )
    }

    #[test]
    fn readiness_and_native_preparation_are_both_required() {
        let mut attempt = attempt();
        attempt.ready = true;
        assert!(!attempt.can_reveal());
        attempt.prepared = true;
        assert!(attempt.can_reveal());
        attempt.document_started();
        assert!(!attempt.can_reveal());
        assert_eq!(attempt.document, 1);
        attempt.ready = true;
        assert!(attempt.can_reveal());
        attempt.failure = Some("Synthetic preparation failure".into());
        assert!(!attempt.can_reveal());
    }

    #[test]
    fn unverified_pages_require_an_explicit_action_after_the_deadline() {
        let mut attempt = attempt();
        assert!(!attempt.status().can_retry);
        assert!(!attempt.status().can_show);
        attempt.prepared = true;
        assert!(attempt.status().can_retry);
        assert!(!attempt.status().can_show);
        attempt.timed_out = true;
        assert!(attempt.status().can_show);
        assert!(!attempt.can_reveal());
        assert_eq!(attempt.status().url, "https://synthetic.test/mount/");
        assert_eq!(
            attempt.target.url.as_str(),
            "https://synthetic.test/mount/chat/example?mode=review#latest"
        );
        attempt.failure = Some("Synthetic failure".into());
        assert!(!attempt.status().can_show);
    }

    #[test]
    fn background_ready_status_does_not_claim_a_readiness_timeout() {
        let mut attempt = attempt();
        attempt.prepared = true;
        attempt.ready = true;
        attempt.timed_out = true;
        assert!(attempt.status().ready);
        assert!(attempt.status().can_show);
        assert!(attempt.status().message.is_none());
        attempt.document_started();
        assert!(!attempt.status().ready);
        assert!(attempt.status().message.is_some());
    }

    #[test]
    fn connection_controls_preserve_preparation_readiness_and_failure_precedence() {
        for (prepared, ready, timed_out, failure, can_retry, can_show, expected_ready) in [
            (false, false, false, None, false, false, false),
            (false, true, true, None, false, false, false),
            (
                false,
                true,
                true,
                Some("Synthetic failure"),
                true,
                false,
                false,
            ),
            (true, false, false, None, true, false, false),
            (true, false, true, None, true, true, false),
            (true, true, false, None, true, true, true),
            (true, true, true, None, true, true, true),
            (
                true,
                true,
                true,
                Some("Synthetic failure"),
                true,
                false,
                false,
            ),
        ] {
            let mut attempt = attempt();
            attempt.prepared = prepared;
            attempt.ready = ready;
            attempt.timed_out = timed_out;
            attempt.failure = failure.map(str::to_string);
            let status = attempt.status();
            assert_eq!(attempt.can_retry(), can_retry);
            assert_eq!(attempt.can_show(), can_show);
            assert_eq!(status.can_retry, can_retry);
            assert_eq!(status.can_show, can_show);
            assert_eq!(attempt.can_reveal(), expected_ready);
            assert_eq!(status.ready, expected_ready);
            if let Some(failure) = failure {
                assert_eq!(status.message.as_deref(), Some(failure));
            }
        }
    }

    #[test]
    fn loading_identity_matches_the_window_title_without_port_or_mount() {
        for (url, name, label) in [
            ("https://server.test:8443/mount/", None, "server.test"),
            ("http://[fd00::2]:3001/mount/", None, "[fd00::2]"),
            ("https://server.test/", Some("Work"), "Work"),
            ("https://server.test/", Some(""), ""),
        ] {
            let mut attempt = attempt();
            attempt.target.server.deployment = Deployment::parse(url).unwrap();
            attempt.target.server.name = name.map(str::to_string);
            assert_eq!(attempt.status().server, label);
            assert_eq!(
                attempt.target.server.title(),
                format!("{label} \u{2014} Garcon")
            );
        }
    }
}
