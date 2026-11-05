use crate::deployment::Deployment;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::PathBuf};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedSelection {
    last_url: Option<String>,
    mounts: BTreeMap<String, String>,
    #[serde(default)]
    recents: Option<Vec<String>>,
    #[serde(default)]
    names: BTreeMap<String, String>,
}

#[derive(Serialize)]
pub struct SavedServer {
    pub url: String,
    pub name: Option<String>,
}

pub struct ServerSelection {
    _lock: fs::File,
    path: PathBuf,
    saved: SavedSelection,
}

impl ServerSelection {
    pub fn load(path: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(path.parent().ok_or("Invalid settings directory.")?)
            .map_err(|_| "Unable to create the app settings directory.")?;
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path.with_extension("lock"))
            .map_err(|_| "Unable to open server settings.")?;
        lock.try_lock()
            .map_err(|_| "Another Garcon native client is already open.")?;
        let saved = match fs::read(&path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|_| "Saved server settings are invalid.")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SavedSelection::default(),
            Err(_) => return Err("Unable to read saved server settings.".into()),
        };
        Ok(Self {
            _lock: lock,
            path,
            saved,
        })
    }

    pub fn last_url(&self) -> Option<String> {
        self.saved.last_url.clone()
    }

    pub fn recents(&self) -> Vec<String> {
        self.saved
            .recents
            .clone()
            .unwrap_or_else(|| self.saved.last_url.iter().cloned().collect())
    }

    pub fn saved_servers(&self) -> Vec<SavedServer> {
        self.recents()
            .into_iter()
            .map(|url| SavedServer {
                name: self.saved.names.get(&url).cloned(),
                url,
            })
            .collect()
    }

    pub fn remove_recent(&mut self, url: &str) -> Result<(), String> {
        let mut candidate = self.saved.clone();
        candidate.recents = Some(
            self.recents()
                .into_iter()
                .filter(|entry| entry != url)
                .collect(),
        );
        if candidate.last_url.as_deref() == Some(url) {
            candidate.last_url = candidate
                .recents
                .as_ref()
                .and_then(|entries| entries.first().cloned());
        }
        self.persist(candidate)
    }

    pub fn select_named(
        &mut self,
        deployment: &Deployment,
        name: Option<String>,
    ) -> Result<Option<String>, String> {
        let name = name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty());
        if name
            .as_ref()
            .is_some_and(|name| name.chars().count() > 120 || name.chars().any(char::is_control))
        {
            return Err(
                "Use a server name of at most 120 characters without control characters.".into(),
            );
        }
        let url = deployment.url();
        let origin = url.origin().ascii_serialization();
        if let Some(mount) = self.saved.mounts.get(&origin) {
            if mount != url.path() {
                return Err(format!(
                    "This origin was used with another mount: {origin}{mount}. Use that base URL or a different hostname to keep credentials and drafts separate."
                ));
            }
        } else if self.saved.mounts.len() >= 32 {
            return Err("The server-origin limit has been reached. Clear the app's data before adding another origin.".into());
        }
        let mut mounts = self.saved.mounts.clone();
        mounts.insert(origin, url.path().into());
        let mut recents = self.recents();
        recents.retain(|entry| entry != url.as_str());
        recents.insert(0, url.to_string());
        let mut names = self.saved.names.clone();
        if let Some(name) = &name {
            names.insert(url.to_string(), name.clone());
        } else {
            names.remove(url.as_str());
        }
        let candidate = SavedSelection {
            last_url: Some(url.to_string()),
            mounts,
            recents: Some(recents),
            names,
        };
        self.persist(candidate)?;
        Ok(name)
    }

    fn persist(&mut self, candidate: SavedSelection) -> Result<(), String> {
        let parent = self.path.parent().ok_or("Invalid settings directory.")?;
        fs::create_dir_all(parent).map_err(|_| "Unable to create the app settings directory.")?;
        let temporary = self.path.with_extension("json.new");
        let bytes =
            serde_json::to_vec(&candidate).map_err(|_| "Unable to encode server settings.")?;
        fs::write(&temporary, bytes).map_err(|_| "Unable to save server settings.")?;
        fs::rename(&temporary, &self.path).map_err(|_| "Unable to publish server settings.")?;
        self.saved = candidate;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_names_and_allows_clearing_them_without_forgetting_mounts() {
        let directory =
            std::env::temp_dir().join(format!("garcon-native-names-{}", std::process::id()));
        let path = directory.join("servers.json");
        let deployment = Deployment::parse("https://a.test/mount/", false).unwrap();
        let mut selection = ServerSelection::load(path.clone()).unwrap();
        assert_eq!(
            selection
                .select_named(&deployment, Some("  Work  ".into()))
                .unwrap()
                .as_deref(),
            Some("Work")
        );
        drop(selection);
        let mut selection = ServerSelection::load(path).unwrap();
        assert_eq!(selection.saved_servers()[0].name.as_deref(), Some("Work"));
        for invalid in ["x".repeat(121), "line\nbreak".into()] {
            assert!(selection.select_named(&deployment, Some(invalid)).is_err());
            assert_eq!(selection.saved_servers()[0].name.as_deref(), Some("Work"));
        }
        selection
            .select_named(&deployment, Some("  ".into()))
            .unwrap();
        assert!(selection.saved_servers()[0].name.is_none());
        assert!(
            selection
                .select_named(
                    &Deployment::parse("https://a.test/other/", false).unwrap(),
                    None
                )
                .is_err()
        );
        drop(selection);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn removing_a_recent_keeps_its_mount_reservation() {
        let directory =
            std::env::temp_dir().join(format!("garcon-native-recents-{}", std::process::id()));
        let path = directory.join("servers.json");
        let mut selection = ServerSelection::load(path.clone()).unwrap();
        for url in [
            "https://a.test/one/",
            "https://b.test/two/",
            "https://a.test/one/",
        ] {
            selection
                .select_named(&Deployment::parse(url, false).unwrap(), None)
                .unwrap();
        }
        assert_eq!(
            selection.recents(),
            ["https://a.test/one/", "https://b.test/two/"]
        );
        selection.remove_recent("https://a.test/one/").unwrap();
        drop(selection);
        let mut selection = ServerSelection::load(path).unwrap();
        assert_eq!(selection.recents(), ["https://b.test/two/"]);
        assert!(
            selection
                .select_named(
                    &Deployment::parse("https://a.test/other/", false).unwrap(),
                    None
                )
                .is_err()
        );
        drop(selection);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn upgrades_the_last_server_without_forgetting_old_mounts() {
        let directory =
            std::env::temp_dir().join(format!("garcon-native-upgrade-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("servers.json");
        fs::write(
            &path,
            r#"{"last_url":"https://a.test/one/","mounts":{"https://a.test":"/one/"}}"#,
        )
        .unwrap();
        let mut selection = ServerSelection::load(path).unwrap();
        assert_eq!(selection.recents(), ["https://a.test/one/"]);
        selection.remove_recent("https://a.test/one/").unwrap();
        assert!(selection.recents().is_empty());
        assert!(
            selection
                .select_named(
                    &Deployment::parse("https://a.test/two/", false).unwrap(),
                    None
                )
                .is_err()
        );
        drop(selection);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn remembers_mounts_across_servers_and_restarts() {
        let directory =
            std::env::temp_dir().join(format!("garcon-native-selection-{}", std::process::id()));
        let path = directory.join("servers.json");
        let mut selection = ServerSelection::load(path.clone()).unwrap();
        selection
            .select_named(
                &Deployment::parse("https://a.test/one", false).unwrap(),
                None,
            )
            .unwrap();
        selection
            .select_named(
                &Deployment::parse("https://b.test/two", false).unwrap(),
                None,
            )
            .unwrap();
        drop(selection);
        let mut reloaded = ServerSelection::load(path).unwrap();
        assert_eq!(reloaded.last_url().as_deref(), Some("https://b.test/two/"));
        assert!(
            reloaded
                .select_named(
                    &Deployment::parse("https://a.test/other", false).unwrap(),
                    None
                )
                .unwrap_err()
                .contains("https://a.test/one/")
        );
        assert!(
            reloaded
                .select_named(
                    &Deployment::parse("https://a.test/one", false).unwrap(),
                    None
                )
                .is_ok()
        );
        drop(reloaded);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_corrupt_settings_and_releases_the_lock() {
        let directory =
            std::env::temp_dir().join(format!("garcon-native-corrupt-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("servers.json");
        for contents in ["{", r#"{"last_url":null,"mounts":{},"unknown":true}"#] {
            fs::write(&path, contents).unwrap();
            assert_eq!(
                ServerSelection::load(path.clone()).err().as_deref(),
                Some("Saved server settings are invalid.")
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn holds_the_lock_until_the_selection_is_dropped() {
        let directory =
            std::env::temp_dir().join(format!("garcon-native-lock-{}", std::process::id()));
        let path = directory.join("servers.json");
        let selection = ServerSelection::load(path.clone()).unwrap();
        assert_eq!(
            ServerSelection::load(path.clone()).err().as_deref(),
            Some("Another Garcon native client is already open.")
        );
        drop(selection);
        drop(ServerSelection::load(path).unwrap());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn limits_new_origins_without_blocking_an_existing_selection() {
        let directory =
            std::env::temp_dir().join(format!("garcon-native-limit-{}", std::process::id()));
        let mut selection = ServerSelection::load(directory.join("servers.json")).unwrap();
        for index in 0..32 {
            selection
                .select_named(
                    &Deployment::parse(&format!("https://server-{index}.test/"), false).unwrap(),
                    None,
                )
                .unwrap();
        }
        assert!(
            selection
                .select_named(
                    &Deployment::parse("https://overflow.test/", false).unwrap(),
                    None
                )
                .is_err()
        );
        selection
            .select_named(
                &Deployment::parse("https://server-0.test/", false).unwrap(),
                None,
            )
            .unwrap();
        drop(selection);
        fs::remove_dir_all(directory).unwrap();
    }
}
