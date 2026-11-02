use crate::deployment::Deployment;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::PathBuf};

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SavedSelection {
    last_url: Option<String>,
    mounts: BTreeMap<String, String>,
}

pub struct ServerSelection {
    _lock: fs::File,
    path: PathBuf,
    saved: SavedSelection,
    pub active: Option<Deployment>,
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
            active: None,
        })
    }

    pub fn last_url(&self) -> Option<String> {
        self.saved.last_url.clone()
    }

    pub fn select(&mut self, deployment: Deployment) -> Result<(), String> {
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
        let candidate = SavedSelection {
            last_url: Some(url.to_string()),
            mounts,
        };
        let parent = self.path.parent().ok_or("Invalid settings directory.")?;
        fs::create_dir_all(parent).map_err(|_| "Unable to create the app settings directory.")?;
        let temporary = self.path.with_extension("json.new");
        let bytes =
            serde_json::to_vec(&candidate).map_err(|_| "Unable to encode server settings.")?;
        fs::write(&temporary, bytes).map_err(|_| "Unable to save server settings.")?;
        fs::rename(&temporary, &self.path).map_err(|_| "Unable to publish server settings.")?;
        self.saved = candidate;
        self.active = Some(deployment);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembers_mounts_across_servers_and_restarts() {
        let directory =
            std::env::temp_dir().join(format!("garcon-native-selection-{}", std::process::id()));
        let path = directory.join("servers.json");
        let mut selection = ServerSelection::load(path.clone()).unwrap();
        selection
            .select(Deployment::parse("https://a.test/one", false).unwrap())
            .unwrap();
        selection
            .select(Deployment::parse("https://b.test/two", false).unwrap())
            .unwrap();
        drop(selection);
        let mut reloaded = ServerSelection::load(path).unwrap();
        assert!(reloaded.active.is_none());
        assert_eq!(reloaded.last_url().as_deref(), Some("https://b.test/two/"));
        assert!(
            reloaded
                .select(Deployment::parse("https://a.test/other", false).unwrap())
                .unwrap_err()
                .contains("https://a.test/one/")
        );
        assert!(
            reloaded
                .select(Deployment::parse("https://a.test/one", false).unwrap())
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
                .select(Deployment::parse(&format!("https://server-{index}.test/"), false).unwrap())
                .unwrap();
        }
        assert!(
            selection
                .select(Deployment::parse("https://overflow.test/", false).unwrap())
                .is_err()
        );
        selection
            .select(Deployment::parse("https://server-0.test/", false).unwrap())
            .unwrap();
        drop(selection);
        fs::remove_dir_all(directory).unwrap();
    }
}
