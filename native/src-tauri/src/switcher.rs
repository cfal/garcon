use crate::{deployment::Deployment, selection::ServerSelection};
use serde::Serialize;

pub const CHOOSER_REQUEST: &str = "garcon-host://switch-server/";

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChooserAction {
    #[default]
    Switch,
    Reload,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerChoices {
    pub generation: u64,
    pub recents: Vec<String>,
    pub last_url: Option<String>,
    pub current_url: Option<String>,
    pub can_cancel: bool,
    pub pending: bool,
    pub action: ChooserAction,
}

pub struct Switcher {
    pub selection: Result<ServerSelection, String>,
    pub generation: u64,
    pub remote_label: Option<String>,
    pub pending: bool,
    pub chooser_open: bool,
    pub action: ChooserAction,
}

impl Switcher {
    pub fn new(selection: Result<ServerSelection, String>) -> Self {
        Self {
            selection,
            generation: 0,
            remote_label: None,
            pending: false,
            chooser_open: true,
            action: ChooserAction::Switch,
        }
    }

    pub fn choices(&self) -> Result<ServerChoices, String> {
        let selection = self.selection.as_ref().map_err(Clone::clone)?;
        Ok(ServerChoices {
            generation: self.generation,
            recents: selection.recents(),
            last_url: selection.last_url(),
            current_url: selection
                .active
                .as_ref()
                .map(|active| active.url().to_string()),
            can_cancel: self.remote_label.as_deref()
                == Some(&format!("server-{}", self.generation))
                && !self.pending,
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
        acknowledged: bool,
    ) -> Result<(u64, Option<String>), String> {
        self.check_generation(generation)?;
        let selection = self.selection.as_mut().map_err(|error| error.clone())?;
        if selection.active.is_some() && !acknowledged {
            return Err("Confirm that unsaved changes and attachments may be lost.".into());
        }
        selection.select(deployment)?;
        self.generation += 1;
        self.pending = true;
        Ok((self.generation, self.remote_label.clone()))
    }

    pub fn accepts(&self, generation: u64) -> bool {
        generation == self.generation
    }

    pub fn allows_navigation(&self, generation: u64, destination: &url::Url) -> bool {
        self.accepts(generation)
            && self
                .selection
                .as_ref()
                .ok()
                .and_then(|selection| selection.active.as_ref())
                .is_some_and(|active| active.allows(destination))
    }

    pub fn request_chooser(&mut self, generation: u64) -> bool {
        if !self.accepts(generation) || self.pending || self.chooser_open {
            return false;
        }
        self.chooser_open = true;
        self.action = ChooserAction::Switch;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transitions_fence_old_pages_and_preserve_cancel() {
        let directory =
            std::env::temp_dir().join(format!("garcon-native-switcher-{}", std::process::id()));
        let mut host = Switcher::new(ServerSelection::load(directory.join("servers.json")));
        assert_eq!(
            serde_json::to_value(host.choices().unwrap()).unwrap(),
            serde_json::json!({
                "generation": 0, "recents": [], "lastUrl": null, "currentUrl": null,
                "canCancel": false, "pending": false, "action": "switch"
            })
        );
        let a = Deployment::parse("https://a.test/mount/", false).unwrap();
        let b = Deployment::parse("https://b.test/", false).unwrap();
        assert_eq!(host.begin(0, a.clone(), false).unwrap().0, 1);
        assert!(host.begin(0, b.clone(), true).is_err());
        assert!(!host.request_chooser(1));
        host.pending = false;
        host.remote_label = Some("server-1".into());
        host.chooser_open = false;
        assert!(host.request_chooser(1));
        assert!(!host.request_chooser(1));
        assert!(host.allows_navigation(1, a.url()));
        assert!(!host.allows_navigation(1, b.url()));
        std::fs::create_dir(directory.join("servers.json.new")).unwrap();
        assert!(host.begin(1, b.clone(), true).is_err());
        assert_eq!(host.generation, 1);
        assert!(host.allows_navigation(1, a.url()));
        std::fs::remove_dir(directory.join("servers.json.new")).unwrap();
        assert!(host.begin(1, b.clone(), false).is_err());
        assert_eq!(host.generation, 1);
        assert_eq!(
            host.begin(1, b.clone(), true).unwrap(),
            (2, Some("server-1".into()))
        );
        assert!(!host.allows_navigation(1, a.url()));
        assert!(!host.allows_navigation(1, b.url()));
        assert!(!host.request_chooser(1));
        assert!(host.allows_navigation(2, b.url()));
        host.pending = false;
        assert_eq!(host.begin(2, a, true).unwrap().0, 3);
        assert!(!host.allows_navigation(2, b.url()));
        drop(host);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
