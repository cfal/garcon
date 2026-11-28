//! Ports `server/runtime/git/temporary-index.ts`.

use std::io::{self, ErrorKind};
use std::rc::Rc;
use std::time::UNIX_EPOCH;

use futures::future::join_all;
use garcon_base::log::{Logger, create_logger};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Clock, SystemClock, path::native, trim};
use tokio::fs;
use tokio_util::sync::CancellationToken;

use super::run::{read_only_git_options, run_git};
use super::types::GitCommandOptions;

const TEMPORARY_INDEX_PREFIX: &str = ".garcon-index-";
const STALE_TEMPORARY_INDEX_AGE_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Clone)]
pub struct TemporaryGitIndexEnvironment {
    pub clock: Rc<dyn Clock>,
    pub next_id: Rc<dyn Fn() -> String>,
}

impl Default for TemporaryGitIndexEnvironment {
    fn default() -> Self {
        Self {
            clock: Rc::new(SystemClock),
            next_id: Rc::new(|| uuid::Uuid::new_v4().to_string()),
        }
    }
}

async fn remove_files_best_effort(paths: &[String]) {
    let results = join_all(paths.iter().map(fs::remove_file)).await;
    for result in results {
        if result.is_err_and(|error| error.kind() != ErrorKind::NotFound) {
            create_logger("git:temporary-index").warn("Failed to remove temporary Git index");
        }
    }
}

async fn stale_temporary_git_indexes(
    index_directory: &str,
    clock: &dyn Clock,
) -> io::Result<Vec<String>> {
    let mut directory = fs::read_dir(index_directory).await?;
    let cutoff = clock.now_ms() as f64 - STALE_TEMPORARY_INDEX_AGE_MS as f64;
    let mut paths = Vec::new();
    while let Some(entry) = directory.next_entry().await? {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(TEMPORARY_INDEX_PREFIX) || !entry.file_type().await?.is_file() {
            continue;
        }
        let path = native::join(&[index_directory, &name]);
        let modified = fs::metadata(&path).await?.modified()?;
        let millis = match modified.duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_secs_f64() * 1000.0,
            Err(error) => -error.duration().as_secs_f64() * 1000.0,
        };
        if millis < cutoff {
            paths.push(path);
        }
    }
    Ok(paths)
}

pub async fn create_temporary_git_index(
    project_path: &str,
    signal: Option<CancellationToken>,
    environment: &TemporaryGitIndexEnvironment,
) -> ExecutorResult<String> {
    let output = run_git(
        project_path,
        ["rev-parse", "--git-path", "index"]
            .map(str::to_owned)
            .into(),
        read_only_git_options(GitCommandOptions {
            signal,
            ..Default::default()
        }),
    )
    .await?;
    let cwd = std::env::current_dir()?;
    let index = native::resolve(
        &cwd.to_string_lossy(),
        &[project_path, trim(&output.stdout)],
    );
    let directory = native::dirname(&index);
    match stale_temporary_git_indexes(&directory, environment.clock.as_ref()).await {
        Ok(paths) => remove_files_best_effort(&paths).await,
        Err(_) => {
            create_logger("git:temporary-index").warn("Failed to sweep stale temporary Git indexes")
        }
    }
    let index_name = format!(
        "{TEMPORARY_INDEX_PREFIX}{}-{}",
        std::process::id(),
        (environment.next_id)()
    );
    let temporary = native::join(&[&directory, &index_name]);
    if let Err(error) = fs::copy(index, &temporary).await
        && error.kind() != ErrorKind::NotFound
    {
        remove_temporary_git_index(&temporary).await;
        return Err(error.into());
    }
    Ok(temporary)
}

pub async fn remove_temporary_git_index(temporary: &str) {
    remove_files_best_effort(&[temporary.into(), format!("{temporary}.lock")]).await;
}
