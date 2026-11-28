use std::time::Duration;

use tokio::time::{Instant, sleep};

pub struct MaterializedThreadOptions {
    pub timeout: Duration,
    pub poll_interval: Duration,
}

impl Default for MaterializedThreadOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(10),
            poll_interval: Duration::from_millis(250),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MaterializedThreadError {
    #[error("Codex thread {thread_id} did not report a native transcript path")]
    MissingPath { thread_id: String },
    #[error("Codex thread {thread_id} did not materialize transcript at {path}")]
    NotMaterialized { thread_id: String, path: String },
}

pub async fn accessible_thread_path(native_path: Option<&str>) -> Option<&str> {
    let path = native_path.filter(|path| !path.is_empty())?;
    tokio::fs::try_exists(path)
        .await
        .unwrap_or(false)
        .then_some(path)
}

pub async fn wait_for_materialized_thread(
    thread_id: &str,
    native_path: Option<&str>,
    options: MaterializedThreadOptions,
) -> Result<String, MaterializedThreadError> {
    let path = native_path.filter(|path| !path.is_empty()).ok_or_else(|| {
        MaterializedThreadError::MissingPath {
            thread_id: thread_id.into(),
        }
    })?;
    let started = Instant::now();
    let poll_interval = options.poll_interval.max(Duration::from_millis(1));
    while started.elapsed().as_millis() <= options.timeout.as_millis() {
        if accessible_thread_path(Some(path)).await.is_some() {
            return Ok(path.to_owned());
        }
        sleep(poll_interval).await;
    }
    Err(MaterializedThreadError::NotMaterialized {
        thread_id: thread_id.into(),
        path: path.into(),
    })
}
