use crate::{
    connection::{ConnectionAttempt, ConnectionStatus, ConnectionTarget},
    deployment::Deployment,
    selection::{SavedServer, ServerSelection},
};
use serde::Serialize;
use std::collections::BTreeMap;

pub const CHOOSER_REQUEST: &str = "garcon-host://switch-server/";
pub const RELOAD_REQUEST: &str = "garcon-host://reload-server/";
pub const READY_REQUEST: &str = "garcon-host://page-ready/";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChoices {
    pub generation: u64,
    pub recents: Vec<SavedServer>,
    pub last_url: Option<String>,
    pub current_url: Option<String>,
    pub can_cancel: bool,
    pub connection: Option<ConnectionStatus>,
}

#[derive(Clone)]
pub struct ServerWindow {
    pub deployment: Deployment,
    pub name: Option<String>,
    pub titlebar_hidden: bool,
}

impl ServerWindow {
    pub fn display_name(&self) -> &str {
        self.name
            .as_deref()
            .unwrap_or_else(|| self.deployment.url().host_str().unwrap_or("Garcon"))
    }

    pub fn title(&self) -> String {
        format!("{} \u{2014} Garcon", self.display_name())
    }
}

pub fn window_label(id: u64) -> String {
    format!("server-{id}")
}

#[cfg(target_os = "linux")]
pub fn window_id(label: &str) -> Option<u64> {
    label.strip_prefix("server-")?.parse().ok()
}

pub struct Switcher {
    pub selection: Result<ServerSelection, String>,
    pub generation: u64,
    next_window_id: u64,
    pub windows: BTreeMap<u64, ServerWindow>,
    pub chooser_source: Option<u64>,
    pub focused_window: Option<u64>,
    pub attempt: Option<ConnectionAttempt>,
    pub chooser_open: bool,
    pub chooser_focused: bool,
}

impl Switcher {
    pub fn new(selection: Result<ServerSelection, String>) -> Self {
        Self {
            selection,
            generation: 0,
            next_window_id: 0,
            windows: BTreeMap::new(),
            chooser_source: None,
            focused_window: None,
            attempt: None,
            chooser_open: true,
            chooser_focused: false,
        }
    }

    pub fn choices(&self) -> Result<ServerChoices, String> {
        let selection = self.selection.as_ref().map_err(Clone::clone)?;
        let current = self.chooser_source.and_then(|id| self.windows.get(&id));
        Ok(ServerChoices {
            generation: self.generation,
            recents: selection.saved_servers(),
            last_url: selection.last_url(),
            current_url: current.map(|window| window.deployment.url().to_string()),
            can_cancel: self.cancel_target().is_some(),
            connection: self.attempt.as_ref().map(ConnectionAttempt::status),
        })
    }

    pub fn check_generation(&self, generation: u64) -> Result<(), String> {
        if generation != self.generation || self.attempt.is_some() {
            return Err("The server selection changed. Reopen the chooser and try again.".into());
        }
        Ok(())
    }

    pub fn begin(
        &mut self,
        generation: u64,
        deployment: Deployment,
        name: Option<String>,
    ) -> Result<u64, String> {
        self.check_generation(generation)?;
        let selection = self.selection.as_mut().map_err(|error| error.clone())?;
        let name = selection.select_named(&deployment, name)?;
        let url = deployment.url().clone();
        Ok(self.start_attempt(
            ConnectionTarget {
                server: ServerWindow {
                    deployment,
                    name,
                    titlebar_hidden: false,
                },
                url,
                placement: None,
            },
            None,
        ))
    }

    pub fn begin_reload(&mut self, source: u64, target: ConnectionTarget) -> Result<u64, String> {
        if self.attempt.is_some() || self.chooser_open {
            return Err("Another server action is open.".into());
        }
        let server = self
            .windows
            .get(&source)
            .ok_or("The server window was closed.")?;
        if !server.deployment.allows(&target.url) {
            return Err("The current page is outside this server.".into());
        }
        self.chooser_source = Some(source);
        Ok(self.start_attempt(target, Some(source)))
    }

    fn start_attempt(&mut self, target: ConnectionTarget, source: Option<u64>) -> u64 {
        self.next_window_id += 1;
        let id = self.next_window_id;
        self.windows.insert(id, target.server.clone());
        self.attempt = Some(ConnectionAttempt::new(id, target, source));
        self.generation += 1;
        self.chooser_open = true;
        id
    }

    pub fn attempt(&self, id: u64) -> Result<&ConnectionAttempt, String> {
        self.attempt
            .as_ref()
            .filter(|attempt| attempt.id == id)
            .ok_or_else(|| "The connection attempt changed.".into())
    }

    pub fn attempt_mut(&mut self, id: u64) -> Option<&mut ConnectionAttempt> {
        self.attempt.as_mut().filter(|attempt| attempt.id == id)
    }

    pub fn cancel_attempt(&mut self, id: u64) -> Result<(), String> {
        self.attempt(id)?;
        self.attempt = None;
        self.windows.remove(&id);
        self.generation += 1;
        self.chooser_open = true;
        Ok(())
    }

    pub fn retry_attempt(&mut self, id: u64) -> Result<u64, String> {
        let attempt = self.attempt(id)?;
        if !attempt.can_retry() {
            return Err("The native window is still opening.".into());
        }
        let target = attempt.target.clone();
        let source = attempt.source;
        self.cancel_attempt(id)?;
        Ok(self.start_attempt(target, source))
    }

    pub fn complete_attempt(&mut self, id: u64) -> Result<Option<u64>, String> {
        let source = self.attempt(id)?.source;
        self.attempt = None;
        self.chooser_open = false;
        self.generation += 1;
        Ok(source)
    }

    pub fn allows_navigation(&self, id: u64, destination: &url::Url) -> bool {
        self.windows
            .get(&id)
            .is_some_and(|window| window.deployment.allows(destination))
    }

    pub fn request_chooser(&mut self, source: Option<u64>) -> bool {
        if self.attempt.is_some()
            || self.chooser_open
            || source.is_some_and(|id| !self.windows.contains_key(&id))
        {
            return false;
        }
        self.generation += 1;
        self.chooser_source = source;
        self.chooser_open = true;
        true
    }

    pub fn cancel_chooser(&mut self, generation: u64) -> Result<u64, String> {
        self.check_generation(generation)?;
        self.selection.as_ref().map_err(Clone::clone)?;
        let target = self.cancel_target().ok_or("No server page is open.")?;
        self.generation += 1;
        self.chooser_open = false;
        Ok(target)
    }

    pub fn cancel_target(&self) -> Option<u64> {
        [self.chooser_source, self.focused_window]
            .into_iter()
            .flatten()
            .chain(self.windows.keys().rev().copied())
            .find(|id| {
                self.windows.contains_key(id)
                    && self
                        .attempt
                        .as_ref()
                        .is_none_or(|attempt| attempt.id != *id)
            })
    }

    pub fn retire(&mut self, id: u64) -> bool {
        if self.windows.remove(&id).is_none() {
            return false;
        }
        if let Some(attempt) = self.attempt_mut(id) {
            attempt.failure = Some("The server window closed before it was ready.".into());
        }
        if self.focused_window == Some(id) {
            self.focused_window = None;
        }
        let source_closed = self.chooser_source == Some(id);
        if source_closed {
            self.chooser_source = None;
        }
        if self.attempt.is_none()
            && (self.windows.is_empty() || (self.chooser_open && source_closed))
        {
            self.generation += 1;
            self.chooser_open = true;
            return true;
        }
        false
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> (Switcher, std::path::PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("garcon-native-{name}-{}", std::process::id()));
        (
            Switcher::new(ServerSelection::load(directory.join("servers.json"))),
            directory,
        )
    }

    fn open(host: &mut Switcher, url: &str, name: Option<&str>) -> u64 {
        let id = host
            .begin(
                host.generation,
                Deployment::parse(url).unwrap(),
                name.map(str::to_string),
            )
            .unwrap();
        host.complete_attempt(id).unwrap();
        id
    }

    #[test]
    fn opens_independent_windows_including_duplicate_servers() {
        let (mut host, directory) = fixture("windows");
        let a = open(&mut host, "https://a.test/mount/", Some("Work"));
        let b = open(&mut host, "https://b.test/", None);
        let duplicate = open(&mut host, "https://a.test/mount/", None);
        assert_ne!(a, duplicate);
        assert_eq!(host.windows.len(), 3);
        for id in [a, duplicate] {
            assert!(
                host.allows_navigation(id, &url::Url::parse("https://a.test/mount/chat").unwrap())
            );
            assert!(!host.allows_navigation(id, &url::Url::parse("https://b.test/").unwrap()));
        }
        assert!(host.allows_navigation(b, &url::Url::parse("https://b.test/").unwrap()));
        assert_eq!(host.windows[&a].title(), "Work \u{2014} Garcon");
        assert_eq!(host.windows[&duplicate].title(), "a.test \u{2014} Garcon");
        assert!(host.request_chooser(Some(a)));
        assert!(!host.request_chooser(Some(b)));
        assert_eq!(host.cancel_target(), Some(a));
        let revision = host.generation;
        assert!(host.check_generation(revision - 1).is_err());
        host.chooser_open = false;
        assert!(!host.retire(a));
        assert!(!host.allows_navigation(a, &url::Url::parse("https://a.test/mount/").unwrap()));
        assert!(!host.request_chooser(Some(a)));
        assert_eq!(host.windows.len(), 2);
        assert!(!host.retire(b));
        assert!(host.retire(duplicate));
        assert!(host.chooser_open);
        assert!(host.cancel_target().is_none());
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn opening_duplicate_servers_preserves_existing_window_names() {
        for (index, (old_name, saved_name)) in [
            (Some("Old"), Some("New")),
            (None, Some("New")),
            (Some("Old"), None),
        ]
        .into_iter()
        .enumerate()
        {
            let (mut host, directory) = fixture(&format!("window-name-{index}"));
            let old = open(&mut host, "https://a.test/", old_name);
            host.windows.get_mut(&old).unwrap().titlebar_hidden = true;
            let newer = open(&mut host, "https://a.test/", saved_name);
            assert_eq!(host.windows[&old].name.as_deref(), old_name);
            assert_eq!(host.windows[&newer].name.as_deref(), saved_name);
            assert!(host.windows[&old].titlebar_hidden);
            assert!(!host.windows[&newer].titlebar_hidden);
            drop(host);
            let selection = ServerSelection::load(directory.join("servers.json")).unwrap();
            assert_eq!(selection.saved_servers()[0].name.as_deref(), saved_name);
            drop(selection);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn closing_the_chooser_source_fences_its_snapshot_and_preserves_cancel() {
        let (mut host, directory) = fixture("source-close");
        let a = open(&mut host, "https://a.test/", None);
        let b = open(&mut host, "https://b.test/", None);
        assert!(host.request_chooser(Some(a)));
        let revision = host.generation;
        assert!(host.retire(a));
        assert!(host.check_generation(revision).is_err());
        assert!(host.choices().unwrap().current_url.is_none());
        assert_eq!(host.cancel_target(), Some(b));
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancelling_the_chooser_fences_queued_admission_before_persistence() {
        let (mut host, directory) = fixture("cancel-chooser");
        assert!(host.cancel_chooser(host.generation).is_err());
        assert_eq!(host.generation, 0);
        let source = open(&mut host, "https://source.test/", None);
        assert!(host.request_chooser(Some(source)));
        let generation = host.generation;
        let saved = std::fs::read(directory.join("servers.json")).unwrap();
        assert_eq!(host.cancel_chooser(generation).unwrap(), source);
        assert!(
            host.begin(
                generation,
                Deployment::parse("https://queued.test/abandoned/").unwrap(),
                Some("Abandoned".into()),
            )
            .is_err()
        );
        assert!(!host.chooser_open);
        assert!(host.attempt.is_none());
        assert_eq!(host.windows.keys().copied().collect::<Vec<_>>(), [source]);
        assert_eq!(
            std::fs::read(directory.join("servers.json")).unwrap(),
            saved
        );
        assert!(host.cancel_chooser(generation).is_err());
        assert!(host.request_chooser(Some(source)));
        assert!(
            host.begin(
                host.generation,
                Deployment::parse("https://queued.test/accepted/").unwrap(),
                None,
            )
            .is_ok()
        );
        let generation = host.generation;
        assert!(host.cancel_chooser(generation).is_err());
        assert_eq!(host.generation, generation);
        assert!(host.attempt.is_some());
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn title_uses_only_the_hostname_unless_named() {
        let window = ServerWindow {
            deployment: Deployment::parse("https://a.example.com:8443/tools/garcon/").unwrap(),
            name: None,
            titlebar_hidden: false,
        };
        assert_eq!(window.title(), "a.example.com \u{2014} Garcon");
    }

    #[test]
    fn cancellation_prefers_source_then_focus_then_latest_non_candidate_window() {
        let server = ServerWindow {
            deployment: Deployment::parse("https://synthetic.test/").unwrap(),
            name: None,
            titlebar_hidden: false,
        };
        let mut host = Switcher::new(Err("Synthetic settings".into()));
        for id in 1..=3 {
            host.windows.insert(id, server.clone());
        }
        host.attempt = Some(ConnectionAttempt::new(
            3,
            ConnectionTarget {
                url: server.deployment.url().clone(),
                server,
                placement: None,
            },
            None,
        ));
        for (source, focused, expected) in [
            (Some(1), Some(2), Some(1)),
            (None, Some(1), Some(1)),
            (Some(99), Some(1), Some(1)),
            (Some(3), Some(1), Some(1)),
            (None, Some(3), Some(2)),
            (Some(99), Some(99), Some(2)),
            (None, None, Some(2)),
        ] {
            host.chooser_source = source;
            host.focused_window = focused;
            assert_eq!(host.cancel_target(), expected);
        }
        host.windows.remove(&1);
        host.windows.remove(&2);
        assert_eq!(host.cancel_target(), None);
        host.attempt = None;
        assert_eq!(host.cancel_target(), Some(3));
    }

    #[test]
    fn reload_retry_preserves_captured_page_and_never_rewrites_saved_names() {
        for (index, (old_name, saved_name)) in [
            (Some("Old"), Some("New")),
            (None, Some("New")),
            (Some("Old"), None),
        ]
        .into_iter()
        .enumerate()
        {
            let (mut host, directory) = fixture(&format!("managed-reload-{index}"));
            let source = open(&mut host, "https://a.test/mount/", old_name);
            host.windows.get_mut(&source).unwrap().titlebar_hidden = true;
            let sibling = open(&mut host, "https://a.test/mount/", saved_name);
            let target = ConnectionTarget {
                server: host.windows[&source].clone(),
                url: url::Url::parse("https://a.test/mount/chat/example?q=1#latest").unwrap(),
                placement: None,
            };
            let candidate = host.begin_reload(source, target.clone()).unwrap();
            assert!(host.windows.contains_key(&source));
            assert!(host.begin_reload(sibling, target).is_err());
            assert!(!host.request_chooser(Some(sibling)));
            assert!(host.retry_attempt(candidate).is_err());
            host.attempt_mut(candidate).unwrap().prepared = true;
            let retry = host.retry_attempt(candidate).unwrap();
            assert_ne!(retry, candidate);
            assert!(host.attempt_mut(candidate).is_none());
            assert!(host.complete_attempt(candidate).is_err());
            assert!(!host.retire(candidate));
            assert_eq!(
                host.attempt(retry).unwrap().target.url.as_str(),
                "https://a.test/mount/chat/example?q=1#latest"
            );
            assert!(host.windows[&retry].titlebar_hidden);
            assert_eq!(host.windows[&retry].name.as_deref(), old_name);
            assert_eq!(host.complete_attempt(retry).unwrap(), Some(source));
            assert!(!host.retire(source));
            assert!(host.windows.contains_key(&sibling));
            drop(host);
            let selection = ServerSelection::load(directory.join("servers.json")).unwrap();
            assert_eq!(selection.saved_servers()[0].name.as_deref(), saved_name);
            drop(selection);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn cancellation_fences_late_events_even_when_source_was_closed() {
        let (mut host, directory) = fixture("cancel-attempt");
        let source = open(&mut host, "https://a.test/", None);
        let target = ConnectionTarget {
            server: host.windows[&source].clone(),
            url: url::Url::parse("https://a.test/chat").unwrap(),
            placement: None,
        };
        let mut escaped = target.clone();
        escaped.url = url::Url::parse("https://other.test/").unwrap();
        assert!(host.begin_reload(source, escaped).is_err());
        let candidate = host.begin_reload(source, target).unwrap();
        assert_eq!(host.cancel_target(), Some(source));
        assert!(!host.retire(source));
        assert_eq!(host.cancel_target(), None);
        host.cancel_attempt(candidate).unwrap();
        assert!(host.attempt_mut(candidate).is_none());
        assert!(host.retry_attempt(candidate).is_err());
        assert!(host.complete_attempt(candidate).is_err());
        assert!(!host.retire(candidate));
        assert!(host.chooser_open);
        assert!(host.windows.is_empty());
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_window_retirement_preserves_siblings_and_allows_retry() {
        let (mut host, directory) = fixture("window-creation-failure");
        let sibling = open(&mut host, "https://a.test/", None);
        assert!(host.request_chooser(Some(sibling)));
        let deployment = Deployment::parse("https://b.test/").unwrap();
        let failed = host
            .begin(host.generation, deployment.clone(), None)
            .unwrap();
        let revision = host.generation;
        assert!(!host.retire(failed));
        assert!(host.attempt(failed).unwrap().failure.is_some());
        assert_eq!(host.generation, revision);
        assert!(!host.allows_navigation(failed, deployment.url()));
        assert!(host.windows.contains_key(&sibling));
        let retry = host.retry_attempt(failed).unwrap();
        assert_ne!(retry, failed);
        assert!(!host.request_chooser(Some(sibling)));
        assert!(
            host.begin(
                revision,
                Deployment::parse("https://b.test/").unwrap(),
                None
            )
            .is_err()
        );
        assert!(host.windows.contains_key(&sibling));
        assert!(host.windows.contains_key(&retry));
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_persistence_does_not_admit_or_retire_windows() {
        let (mut host, directory) = fixture("failed-open");
        let a = open(&mut host, "https://a.test/", None);
        let revision = host.generation;
        std::fs::create_dir(directory.join("servers.json.new")).unwrap();
        assert!(
            host.begin(
                revision,
                Deployment::parse("https://b.test/").unwrap(),
                None
            )
            .is_err()
        );
        assert_eq!(host.generation, revision);
        assert_eq!(host.windows.len(), 1);
        assert!(host.windows.contains_key(&a));
        assert!(host.attempt.is_none());
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
