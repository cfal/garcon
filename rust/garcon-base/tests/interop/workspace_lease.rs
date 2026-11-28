use std::path::Path;

use garcon_base::workspace_lease::{
    AcquireWorkspaceLeaseError, WORKSPACE_LOCK_NAME, WorkspaceLeaseOptions, acquire_workspace_lease,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::task::LocalSet;

fn original(mode: &str, path: &Path) -> Command {
    let mut command = Command::new("bun");
    command
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/workspace_lease_oracle.ts"
        ))
        .arg(mode)
        .arg(path)
        .kill_on_drop(true);
    command
}

fn options() -> WorkspaceLeaseOptions {
    WorkspaceLeaseOptions {
        retries: Some(0),
        stale_ms: Some(2_000),
        update_ms: Some(1_000),
        ..Default::default()
    }
}

#[tokio::test]
async fn the_original_lease_excludes_rust_until_released() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().join("workspace");
            let mut child = original("hold", &workspace)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let mut stdout = BufReader::new(child.stdout.take().unwrap());
            let mut ready = String::new();
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                stdout.read_line(&mut ready),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(ready.trim_end(), "acquired");
            let lock = workspace.join(WORKSPACE_LOCK_NAME);
            assert!(lock.is_dir());
            assert_eq!(std::fs::read_dir(&lock).unwrap().count(), 0);
            let Err(AcquireWorkspaceLeaseError::InUse(error)) =
                acquire_workspace_lease(&workspace, options()).await
            else {
                panic!("Original lease did not exclude Rust");
            };
            assert_eq!(error.workspace_dir, workspace.canonicalize().unwrap());
            assert!(
                error
                    .to_string()
                    .ends_with("Lock file is already being held")
            );
            let mut stdin = child.stdin.take().unwrap();
            stdin.write_all(b"release\n").await.unwrap();
            drop(stdin);
            assert!(child.wait().await.unwrap().success());
            assert!(!lock.exists());
            let acquired = acquire_workspace_lease(&workspace, options())
                .await
                .unwrap();
            acquired.release().await.unwrap();
            acquired.release().await.unwrap();
        })
        .await;
}

#[tokio::test]
async fn the_rust_lease_excludes_the_original_until_released_even_through_an_alias() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().join("workspace");
            let lease = acquire_workspace_lease(&workspace, options())
                .await
                .unwrap();
            #[cfg(unix)]
            let alias = {
                let alias = root.path().join("alias");
                std::os::unix::fs::symlink(&workspace, &alias).unwrap();
                alias
            };
            #[cfg(not(unix))]
            let alias = workspace.clone();
            assert!(workspace.join(WORKSPACE_LOCK_NAME).is_dir());
            let output = original("try", &alias).output().await.unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).trim_end(),
                "WORKSPACE_IN_USE"
            );
            lease.release().await.unwrap();
            let output = original("try", &alias).output().await.unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).trim_end(),
                "acquired"
            );
        })
        .await;
}
