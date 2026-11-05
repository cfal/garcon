use crate::{
    deployment::Deployment,
    selection::{SavedServer, ServerSelection},
};
use serde::Serialize;
use std::collections::BTreeMap;

pub const CHOOSER_REQUEST: &str = "garcon-host://switch-server/";

#[derive(Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChooserAction {
    #[default]
    Open,
    Reload,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChoices {
    pub generation: u64,
    pub recents: Vec<SavedServer>,
    pub last_url: Option<String>,
    pub current_url: Option<String>,
    pub current_name: Option<String>,
    pub can_cancel: bool,
    pub pending: bool,
    pub action: ChooserAction,
}

#[derive(Clone)]
pub struct ServerWindow {
    pub deployment: Deployment,
    pub name: Option<String>,
}

impl ServerWindow {
    pub fn title(&self) -> String {
        let name = self
            .name
            .as_deref()
            .unwrap_or_else(|| self.deployment.url().host_str().unwrap_or("Garcon"));
        format!("{name} \u{2014} Garcon")
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
    pub pending: bool,
    pub chooser_open: bool,
    pub action: ChooserAction,
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
            pending: false,
            chooser_open: true,
            action: ChooserAction::Open,
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
            current_name: current.and_then(|window| window.name.clone()),
            can_cancel: self.cancel_target().is_some() && !self.pending,
            pending: self.pending,
            action: self.action,
        })
    }

    pub fn check_generation(&self, generation: u64) -> Result<(), String> {
        if generation != self.generation || self.pending {
            return Err("The server selection changed. Reopen the chooser and try again.".into());
        }
        Ok(())
    }

    pub fn begin(
        &mut self,
        generation: u64,
        deployment: Deployment,
        name: Option<String>,
        acknowledged: bool,
    ) -> Result<(u64, Option<u64>), String> {
        self.check_generation(generation)?;
        let (previous, name) = if self.action == ChooserAction::Reload {
            let id = self.chooser_source.ok_or("No server page is open.")?;
            let window = self.windows.get(&id).ok_or("No server page is open.")?;
            if deployment.url() != window.deployment.url() {
                return Err("Reload must use the current server URL.".into());
            }
            if !acknowledged {
                return Err("Confirm that unsaved changes and attachments may be lost.".into());
            }
            // Reload preserves this window's title, not its stale copy of a saved name.
            (Some(id), window.name.clone())
        } else {
            let selection = self.selection.as_mut().map_err(|error| error.clone())?;
            (None, selection.select_named(&deployment, name)?)
        };
        self.next_window_id += 1;
        let id = self.next_window_id;
        if let Some(previous) = previous {
            self.windows.remove(&previous);
        }
        self.windows.insert(id, ServerWindow { deployment, name });
        self.generation += 1;
        self.pending = true;
        Ok((id, previous))
    }

    pub fn allows_navigation(&self, id: u64, destination: &url::Url) -> bool {
        self.windows
            .get(&id)
            .is_some_and(|window| window.deployment.allows(destination))
    }

    pub fn request_chooser(&mut self, source: Option<u64>, action: ChooserAction) -> bool {
        if self.pending
            || self.chooser_open
            || source.is_some_and(|id| !self.windows.contains_key(&id))
            || (action == ChooserAction::Reload && source.is_none())
        {
            return false;
        }
        self.generation += 1;
        self.chooser_source = source;
        self.action = action;
        self.chooser_open = true;
        true
    }

    pub fn cancel_target(&self) -> Option<u64> {
        [self.chooser_source, self.focused_window]
            .into_iter()
            .flatten()
            .find(|id| self.windows.contains_key(id))
            .or_else(|| self.windows.keys().next_back().copied())
    }

    pub fn retire(&mut self, id: u64) -> bool {
        self.windows.remove(&id);
        if self.focused_window == Some(id) {
            self.focused_window = None;
        }
        let source_closed = self.chooser_source == Some(id);
        if source_closed {
            self.chooser_source = None;
            self.action = ChooserAction::Open;
        }
        if !self.pending && (self.windows.is_empty() || (self.chooser_open && source_closed)) {
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
        let (id, previous) = host
            .begin(
                host.generation,
                Deployment::parse(url).unwrap(),
                name.map(str::to_string),
                false,
            )
            .unwrap();
        assert!(previous.is_none());
        host.pending = false;
        host.chooser_open = false;
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
        assert!(host.request_chooser(Some(a), ChooserAction::Open));
        assert!(!host.request_chooser(Some(b), ChooserAction::Open));
        assert_eq!(host.cancel_target(), Some(a));
        let revision = host.generation;
        assert!(host.check_generation(revision - 1).is_err());
        host.chooser_open = false;
        assert!(!host.retire(a));
        assert!(!host.allows_navigation(a, &url::Url::parse("https://a.test/mount/").unwrap()));
        assert!(!host.request_chooser(Some(a), ChooserAction::Open));
        assert_eq!(host.windows.len(), 2);
        assert!(!host.retire(b));
        assert!(host.retire(duplicate));
        assert!(host.chooser_open);
        assert!(host.cancel_target().is_none());
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reload_replaces_only_the_requesting_window_after_acknowledgement() {
        let (mut host, directory) = fixture("window-reload");
        let a = open(&mut host, "https://a.test/", None);
        let b = open(&mut host, "https://b.test/", None);
        assert!(host.request_chooser(Some(a), ChooserAction::Reload));
        let revision = host.generation;
        let a_url = Deployment::parse("https://a.test/").unwrap();
        assert!(host.begin(revision, a_url.clone(), None, false).is_err());
        assert!(
            host.begin(
                revision,
                Deployment::parse("https://b.test/").unwrap(),
                None,
                true
            )
            .is_err()
        );
        assert_eq!(host.windows.len(), 2);
        let (replacement, previous) = host.begin(revision, a_url.clone(), None, true).unwrap();
        assert_eq!(previous, Some(a));
        assert!(host.windows.contains_key(&b));
        assert!(!host.windows.contains_key(&a));
        assert!(host.allows_navigation(replacement, a_url.url()));
        assert!(!host.request_chooser(Some(b), ChooserAction::Open));
        assert!(host.begin(revision, a_url, None, true).is_err());
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reloading_an_older_window_never_changes_a_newer_saved_name() {
        for (index, (old_name, saved_name)) in [
            (Some("Old"), Some("New")),
            (None, Some("New")),
            (Some("Old"), None),
        ]
        .into_iter()
        .enumerate()
        {
            let (mut host, directory) = fixture(&format!("reload-name-{index}"));
            let old = open(&mut host, "https://a.test/", old_name);
            let newer = open(&mut host, "https://a.test/", saved_name);
            assert!(host.request_chooser(Some(old), ChooserAction::Reload));
            let (replacement, _) = host
                .begin(
                    host.generation,
                    Deployment::parse("https://a.test/").unwrap(),
                    old_name.map(str::to_string),
                    true,
                )
                .unwrap();
            assert_eq!(host.windows[&replacement].name.as_deref(), old_name);
            assert!(host.windows.contains_key(&newer));
            drop(host);
            let selection = ServerSelection::load(directory.join("servers.json")).unwrap();
            assert_eq!(selection.saved_servers()[0].name.as_deref(), saved_name);
            drop(selection);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn closing_the_chooser_source_fences_its_snapshot_without_retargeting_reload() {
        let (mut host, directory) = fixture("source-close");
        let a = open(&mut host, "https://a.test/", None);
        let b = open(&mut host, "https://b.test/", None);
        assert!(host.request_chooser(Some(a), ChooserAction::Reload));
        let revision = host.generation;
        assert!(host.retire(a));
        assert!(host.check_generation(revision).is_err());
        assert!(host.action == ChooserAction::Open);
        assert_eq!(host.cancel_target(), Some(b));
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn title_uses_only_the_hostname_unless_named() {
        let window = ServerWindow {
            deployment: Deployment::parse("https://a.example.com:8443/tools/garcon/").unwrap(),
            name: None,
        };
        assert_eq!(window.title(), "a.example.com \u{2014} Garcon");
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
                None,
                false
            )
            .is_err()
        );
        assert_eq!(host.generation, revision);
        assert_eq!(host.windows.len(), 1);
        assert!(host.windows.contains_key(&a));
        assert!(!host.pending);
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
