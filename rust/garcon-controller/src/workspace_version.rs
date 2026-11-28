use std::error::Error;
use std::io;
use std::path::Path;

use garcon_base::json_file_store::{JsonFileStore, JsonWriteOptions};
use garcon_base::stored_json::parse_stored_json;
use garcon_base::workspace_lease::WORKSPACE_LOCK_NAME;
use garcon_js::{is_safe_integer, json::as_number};
use garcon_stores::api_providers::assignments::ApiProviderAssignmentStore;
use serde_json::{Value, json};
use tokio::fs;

const VERSION_FILE: &str = "workspace-version.json";
const CURRENT_WORKSPACE_VERSION: u64 = 10;
const LAST_TYPESCRIPT_RELEASE: &str = "0.4.2";

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceVersionError {
    #[error("Could not read workspace-version.json")]
    Read(#[source] Box<dyn Error>),
    #[error("workspace-version.json must contain a nonnegative integer version")]
    InvalidVersion,
    #[error("workspace-version.json checkpoint must be true when present")]
    InvalidCheckpoint,
    #[error("Workspace version {0} is newer than supported version {CURRENT_WORKSPACE_VERSION}")]
    Newer(u64),
    #[error(
        "Workspace version {0} is older than supported version {CURRENT_WORKSPACE_VERSION}; open it with Garcon {LAST_TYPESCRIPT_RELEASE} to upgrade it first"
    )]
    Older(u64),
}

struct VersionStamp {
    version: u64,
    checkpoint: bool,
}

async fn read_version(workspace_dir: &Path) -> Result<Option<VersionStamp>, WorkspaceVersionError> {
    let bytes = match fs::read(workspace_dir.join(VERSION_FILE)).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(WorkspaceVersionError::Read(error.into())),
    };
    let data = parse_stored_json(&String::from_utf8_lossy(&bytes), VERSION_FILE)
        .map_err(|error| WorkspaceVersionError::Read(error.into()))?;
    let version = data
        .get("version")
        .and_then(as_number)
        .filter(|number| is_safe_integer(*number) && *number >= 0.0)
        .ok_or(WorkspaceVersionError::InvalidVersion)? as u64;
    let checkpoint = match data.get("checkpoint") {
        None => false,
        Some(Value::Bool(true)) => true,
        _ => return Err(WorkspaceVersionError::InvalidCheckpoint),
    };
    Ok(Some(VersionStamp {
        version,
        checkpoint,
    }))
}

/// Opens current workspaces and initializes an empty directory without running
/// the old migration ladder. A directory with unversioned data is not fresh.
pub async fn open_workspace(workspace_dir: &Path) -> Result<(), Box<dyn Error>> {
    if let Some(stamp) = read_version(workspace_dir).await? {
        match stamp.version.cmp(&CURRENT_WORKSPACE_VERSION) {
            std::cmp::Ordering::Greater => {
                return Err(WorkspaceVersionError::Newer(stamp.version).into());
            }
            std::cmp::Ordering::Less => {
                return Err(WorkspaceVersionError::Older(stamp.version).into());
            }
            std::cmp::Ordering::Equal if !stamp.checkpoint => return Ok(()),
            std::cmp::Ordering::Equal => {}
        }
    } else {
        let mut entries = fs::read_dir(workspace_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            if entry.file_name() != WORKSPACE_LOCK_NAME {
                return Err(WorkspaceVersionError::Older(0).into());
            }
        }
        ApiProviderAssignmentStore::initialize_fresh_workspace(workspace_dir).await?;
    }
    let path = workspace_dir.join(VERSION_FILE);
    JsonFileStore::default()
        .write_json_file_atomic(
            &path.to_string_lossy(),
            &json!({ "version": CURRENT_WORKSPACE_VERSION }),
            JsonWriteOptions::default(),
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn initializes_only_empty_workspaces_and_can_reopen_them() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(WORKSPACE_LOCK_NAME))
            .await
            .unwrap();
        open_workspace(root.path()).await.unwrap();
        let stamp = read_version(root.path()).await.unwrap().unwrap();
        assert_eq!(stamp.version, CURRENT_WORKSPACE_VERSION);
        assert!(!stamp.checkpoint);
        let assignments = fs::read(root.path().join("api-provider-assignments.json"))
            .await
            .unwrap();
        assert_eq!(
            assignments,
            br#"{"version":1,"revision":0,"assignments":{}}"#
        );
        open_workspace(root.path()).await.unwrap();
    }

    #[tokio::test]
    async fn refuses_old_new_and_corrupt_workspaces_without_rewriting_them() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(VERSION_FILE);
        for (text, expected) in [
            ("{\"version\":9}", "Workspace version 9 is older"),
            ("{\"version\":11}", "Workspace version 11 is newer"),
            (
                "{\"version\":1.5}",
                "workspace-version.json must contain a nonnegative integer version",
            ),
            (
                "{\"version\":10,\"checkpoint\":false}",
                "workspace-version.json checkpoint must be true when present",
            ),
            ("{", "Could not read workspace-version.json"),
        ] {
            fs::write(&path, text).await.unwrap();
            let error = open_workspace(root.path()).await.unwrap_err();
            assert!(error.to_string().starts_with(expected));
            assert_eq!(fs::read_to_string(&path).await.unwrap(), text);
        }
        fs::remove_file(&path).await.unwrap();
        fs::write(root.path().join("legacy.json"), "{}")
            .await
            .unwrap();
        let error = open_workspace(root.path()).await.unwrap_err();
        assert!(
            error
                .to_string()
                .starts_with("Workspace version 0 is older")
        );
        assert!(!path.exists());
    }
}
