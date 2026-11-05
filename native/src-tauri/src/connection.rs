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
        ConnectionStatus {
            id: self.id,
            server: self.target.server.name.clone().unwrap_or_else(|| {
                self.target
                    .server
                    .deployment
                    .url()
                    .host_str()
                    .unwrap_or("Garcon")
                    .into()
            }),
            url: self.target.server.deployment.url().to_string(),
            message: self.failure.clone().or_else(|| {
                (self.timed_out && !self.can_reveal())
                    .then(|| "Garcon has not become ready.".into())
            }),
            ready: self.can_reveal(),
            can_retry: self.prepared || self.failure.is_some(),
            can_show: self.prepared && (self.ready || self.timed_out) && self.failure.is_none(),
        }
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
}
