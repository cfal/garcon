use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use garcon_base::path_boundary::realpath;
use garcon_base::workspace_lease::{
    ReleaseWorkspaceLeaseError, WorkspaceLease, WorkspaceLeaseCompromised, WorkspaceLeaseOptions,
    acquire_workspace_lease,
};
use garcon_contract::cli_runtime_paths::executor_data_directory;
use tokio::fs;

#[derive(Debug, thiserror::Error)]
#[error(
    "The executor directory is reserved for worker storage; choose a different controller workspace"
)]
struct ReservedExecutorDirectory;

pub struct ControllerLease {
    config: WorkspaceLease,
    workspace: Option<WorkspaceLease>,
}

impl ControllerLease {
    pub fn workspace_dir(&self) -> &Path {
        &self
            .workspace
            .as_ref()
            .unwrap_or(&self.config)
            .workspace_dir
    }

    pub async fn release(&self) -> Result<(), ReleaseWorkspaceLeaseError> {
        let workspace = match &self.workspace {
            Some(lease) => lease.release().await,
            None => Ok(()),
        };
        self.config.release().await?;
        workspace
    }
}

pub async fn acquire_controller_lease(
    config_dir: &Path,
    workspace_dir: &Path,
    on_compromised: Rc<dyn Fn(WorkspaceLeaseCompromised)>,
) -> Result<ControllerLease, Box<dyn Error>> {
    let options = || {
        let on_compromised = Rc::clone(&on_compromised);
        WorkspaceLeaseOptions {
            on_compromised: Some(Box::new(move |error| on_compromised(error))),
            ..Default::default()
        }
    };
    let config = acquire_workspace_lease(config_dir, options()).await?;
    let result = async {
        fs::create_dir_all(workspace_dir).await?;
        let canonical = realpath(workspace_dir).await?;
        let executor = PathBuf::from(executor_data_directory(
            &config.workspace_dir.to_string_lossy(),
        ));
        let executor = match realpath(&executor).await {
            Ok(path) => path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => executor,
            Err(error) => return Err(error.into()),
        };
        if canonical.starts_with(&executor) {
            return Err(Box::new(ReservedExecutorDirectory) as Box<dyn Error>);
        }
        if canonical == config.workspace_dir {
            return Ok(None);
        }
        Ok(Some(
            acquire_workspace_lease(workspace_dir, options()).await?,
        ))
    }
    .await;
    match result {
        Ok(workspace) => Ok(ControllerLease { config, workspace }),
        Err(error) => {
            config.release().await?;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_base::workspace_lease::WORKSPACE_LOCK_NAME;
    use tokio::task::LocalSet;

    #[tokio::test]
    async fn holds_config_then_workspace_and_releases_both() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let config = root.path().join("config");
                let workspace = root.path().join("workspace");
                let lease = acquire_controller_lease(&config, &workspace, Rc::new(|_| {}))
                    .await
                    .unwrap();
                assert_eq!(lease.workspace_dir(), realpath(&workspace).await.unwrap());
                assert!(config.join(WORKSPACE_LOCK_NAME).is_dir());
                assert!(workspace.join(WORKSPACE_LOCK_NAME).is_dir());
                lease.release().await.unwrap();
                assert!(!config.join(WORKSPACE_LOCK_NAME).exists());
                assert!(!workspace.join(WORKSPACE_LOCK_NAME).exists());
            })
            .await;
    }

    #[tokio::test]
    async fn locks_the_same_config_and_workspace_once() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let lease = acquire_controller_lease(root.path(), root.path(), Rc::new(|_| {}))
                    .await
                    .unwrap();
                assert!(lease.workspace.is_none());
                assert_eq!(lease.workspace_dir(), realpath(root.path()).await.unwrap());
                lease.release().await.unwrap();
            })
            .await;
    }

    #[tokio::test]
    async fn refuses_the_executor_directory_and_releases_the_config_lock() {
        LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let workspace = root.path().join("executor/other");
                let error = acquire_controller_lease(root.path(), &workspace, Rc::new(|_| {}))
                    .await
                    .err()
                    .unwrap();
                assert!(error.is::<ReservedExecutorDirectory>());
                assert!(!root.path().join(WORKSPACE_LOCK_NAME).exists());
                assert!(!workspace.join(WORKSPACE_LOCK_NAME).exists());
            })
            .await;
    }
}
