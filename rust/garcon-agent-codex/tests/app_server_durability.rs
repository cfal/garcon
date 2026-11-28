use std::time::Duration;

use garcon_agent_codex::app_server::durability::{
    MaterializedThreadOptions, accessible_thread_path, wait_for_materialized_thread,
};
use tempfile::tempdir;

#[tokio::test]
async fn returns_the_app_server_native_path_once_it_exists() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    let native_path = path.to_str().unwrap();
    assert_eq!(accessible_thread_path(Some(native_path)).await, None);
    let (found, ()) = tokio::join!(
        wait_for_materialized_thread(
            "thread-1",
            Some(native_path),
            MaterializedThreadOptions {
                timeout: Duration::from_secs(2),
                poll_interval: Duration::from_millis(5),
            }
        ),
        async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            tokio::fs::write(&path, "{}\n").await.unwrap();
        },
    );
    assert_eq!(found.unwrap(), native_path);
}

#[tokio::test]
async fn rejects_threads_without_a_native_path() {
    let error =
        wait_for_materialized_thread("thread-1", None, MaterializedThreadOptions::default())
            .await
            .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Codex thread thread-1 did not report a native transcript path"
    );
}

#[tokio::test]
async fn reports_the_announced_path_when_it_never_materializes() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("missing.jsonl");
    let native_path = path.to_str().unwrap();
    let error = wait_for_materialized_thread(
        "thread-1",
        Some(native_path),
        MaterializedThreadOptions {
            timeout: Duration::from_millis(1),
            poll_interval: Duration::from_millis(1),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        format!("Codex thread thread-1 did not materialize transcript at {native_path}")
    );
}
