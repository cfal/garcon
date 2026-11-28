//! Ports `server/controller/preambles/project-path-service.ts`.

use garcon_contract::{
    executors::ExecutorId,
    preambles::PreambleErrorCode,
    project_resolution::{ProjectInspector, ProjectResolution, ProjectUnavailableReason},
};
use garcon_js::OptionalNullable;

use super::errors::PreambleDomainError;

pub(super) async fn resolve_project_path(
    inspect: &dyn ProjectInspector,
    project_path: String,
    executor_id: OptionalNullable<ExecutorId>,
) -> Result<String, PreambleDomainError> {
    let reason = match inspect
        .inspect(project_path.clone(), executor_id, None)
        .await
    {
        ProjectResolution::Available {
            effective_project_key,
        } => return Ok(effective_project_key),
        ProjectResolution::Unavailable { reason } => reason,
    };
    let (code, message, status) = match reason {
        ProjectUnavailableReason::NotFound => (
            PreambleErrorCode::PROJECT_PATH_NOT_FOUND,
            format!("Project path not found: {project_path}"),
            404,
        ),
        ProjectUnavailableReason::OutsideBase => (
            PreambleErrorCode::PROJECT_PATH_OUTSIDE_BASE,
            "Project path is outside the allowed base directory".into(),
            403,
        ),
        ProjectUnavailableReason::NotADirectory => (
            PreambleErrorCode::PROJECT_PATH_NOT_DIRECTORY,
            format!("Project path is not a directory: {project_path}"),
            400,
        ),
        ProjectUnavailableReason::PermissionDenied => (
            PreambleErrorCode::PROJECT_PATH_INACCESSIBLE,
            format!("Project path is not accessible: {project_path}"),
            403,
        ),
    };
    Err(PreambleDomainError::new(code, message, status))
}
