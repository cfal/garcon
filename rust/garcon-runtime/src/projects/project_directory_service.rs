//! Ports `server/runtime/projects/project-directory-service.ts`.

use std::future::Future;
use std::io;

use garcon_base::path_boundary::is_project_boundary_error;
use garcon_contract::project_resolution::{ProjectResolution, ProjectUnavailableReason};
use garcon_interface::resources::ExecutorResult;
use garcon_js::trim;
use tokio::fs;

use crate::files::errors::{has_any_node_code, is_denied};

pub async fn inspect_project_directory<'a, E, Fut>(
    project_path: &'a str,
    resolve_path: impl FnOnce(&'a str) -> Fut,
) -> ExecutorResult<ProjectResolution>
where
    E: Into<Box<dyn std::error::Error>>,
    Fut: Future<Output = Result<String, E>>,
{
    if trim(project_path).is_empty() {
        return Ok(ProjectResolution::Unavailable {
            reason: ProjectUnavailableReason::NotFound,
        });
    }
    let probe: ExecutorResult<_> = async {
        let canonical = resolve_path(project_path).await.map_err(Into::into)?;
        if !fs::metadata(&canonical).await?.is_dir() {
            return Ok(ProjectResolution::Unavailable {
                reason: ProjectUnavailableReason::NotADirectory,
            });
        }
        access_directory(&canonical).await?;
        Ok(ProjectResolution::Available {
            effective_project_key: canonical,
        })
    }
    .await;
    match probe {
        Err(error) => match unavailable_reason(error.as_ref()) {
            Some(reason) => Ok(ProjectResolution::Unavailable { reason }),
            None => Err(error),
        },
        ready => ready,
    }
}

fn unavailable_reason(
    error: &(dyn std::error::Error + 'static),
) -> Option<ProjectUnavailableReason> {
    if is_project_boundary_error(error) {
        return Some(ProjectUnavailableReason::OutsideBase);
    }
    if has_any_node_code(error, &["ENOENT", "ENOTDIR", "ELOOP"]) {
        Some(ProjectUnavailableReason::NotFound)
    } else if is_denied(error) {
        Some(ProjectUnavailableReason::PermissionDenied)
    } else {
        None
    }
}

#[cfg(unix)]
async fn access_directory(path: &str) -> io::Result<()> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        rustix::fs::access(
            path,
            rustix::fs::Access::READ_OK | rustix::fs::Access::EXEC_OK,
        )
        .map_err(io::Error::from)
    })
    .await?
}

#[cfg(windows)]
async fn access_directory(path: &str) -> io::Result<()> {
    // Windows has no executable permission bit for a directory.
    fs::read_dir(path).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn inspection_does_not_classify_unexpected_filesystem_failures_as_unavailable() {
        let error = inspect_project_directory("project", |_| async {
            Err(io::Error::other("synthetic unexpected failure"))
        })
        .await
        .unwrap_err();
        assert!(error.is::<io::Error>());
        assert_eq!(error.to_string(), "synthetic unexpected failure");
    }
}
