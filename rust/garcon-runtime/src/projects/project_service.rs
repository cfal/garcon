//! Ports `server/runtime/projects/project-service.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_base::executor_path::{to_executor_path, to_native_path};
use garcon_base::path_boundary::assert_real_within_base;
use garcon_contract::project_resolution::ProjectResolution;
use garcon_contract::tickets::TicketProjectDefault;
use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
use garcon_interface::execution_runtime::{
    ExecutionProjectInspectRequest, ExecutionProjectInspectResponse, ExecutionProjectService,
    ResolveFileMentionsRequest, TicketProjectDefaultRequest,
};
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};
use garcon_js::{path::native, trim};

use crate::git::run::{read_only_git_options, run_git};
use crate::git::types::GitCommandOptions;
use crate::{ChildEnvironment, cancellation::check_cancelled};

use super::file_mentions::resolve_file_mentions_in_command;
use super::project_directory_service::inspect_project_directory;
use super::ticket_project_default::resolve_ticket_project_default_with_environment;

type AssertAvailable = dyn Fn(Option<&ExecutorCallOptions>) -> ExecutorResult<()>;

pub struct ProjectService {
    pub project_base_path: String,
    assert_available: Rc<AssertAvailable>,
    child_environment: Option<ChildEnvironment>,
}

impl ProjectService {
    pub fn new(
        project_base_path: &str,
        assert_available: Rc<AssertAvailable>,
    ) -> std::io::Result<Self> {
        let cwd = if cfg!(unix) && native::is_absolute(project_base_path) {
            native::SEP.to_owned()
        } else {
            std::env::current_dir()?.to_string_lossy().into_owned()
        };
        Ok(Self {
            project_base_path: to_executor_path(&native::resolve(&cwd, &[project_base_path]), None),
            assert_available,
            child_environment: None,
        })
    }

    pub fn with_child_environment(mut self, environment: ChildEnvironment) -> Self {
        self.child_environment = Some(environment);
        self
    }

    async fn is_git_repository(
        &self,
        project_path: &str,
        options: Option<&ExecutorCallOptions>,
    ) -> ExecutorResult<bool> {
        let signal = options.and_then(|options| options.signal.clone());
        let timeout = options
            .and_then(|options| options.timeout_ms)
            .unwrap_or(5_000.0)
            .min(5_000.0);
        match run_git(
            project_path,
            vec!["rev-parse".into(), "--is-inside-work-tree".into()],
            read_only_git_options(GitCommandOptions {
                timeout_ms: Some(timeout),
                signal: signal.clone(),
                max_stdout_bytes: Some(1024),
                max_stderr_bytes: Some(4096),
                base_environment: self.child_environment.clone(),
                ..Default::default()
            }),
        )
        .await
        {
            Ok(result) => Ok(trim(&result.stdout) == "true"),
            Err(_) => {
                check_cancelled(signal.as_ref())?;
                Ok(false)
            }
        }
    }
}

#[async_trait(?Send)]
impl ExecutionProjectService for ProjectService {
    async fn ticket_project_default(
        &self,
        request: TicketProjectDefaultRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TicketProjectDefault> {
        let options = options.as_ref();
        (self.assert_available)(options)?;
        let base = to_native_path(&self.project_base_path, None);
        let directory = to_native_path(&request.project_path, None);
        let signal = options.and_then(|options| options.signal.as_ref());
        let result = resolve_ticket_project_default_with_environment(
            &directory,
            signal,
            self.child_environment.clone(),
            async |path: &str| {
                inspect_project_directory(path, |input| assert_real_within_base(&base, input)).await
            },
        )
        .await?;
        (self.assert_available)(options)?;
        Ok(result)
    }

    async fn inspect(
        &self,
        request: ExecutionProjectInspectRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionProjectInspectResponse> {
        let options = options.as_ref();
        (self.assert_available)(options)?;
        let base = to_native_path(&self.project_base_path, None);
        let input = to_native_path(&request.project_path, None);
        let resolution =
            inspect_project_directory(&input, |input| assert_real_within_base(&base, input))
                .await?;
        (self.assert_available)(options)?;
        let ProjectResolution::Available {
            effective_project_key,
        } = resolution
        else {
            return Ok(ExecutionProjectInspectResponse {
                resolution,
                is_git_repository: None,
            });
        };
        let is_git_repository = if request.include_git_repository == Some(true) {
            Some(
                self.is_git_repository(&effective_project_key, options)
                    .await?,
            )
        } else {
            None
        };
        (self.assert_available)(options)?;
        Ok(ExecutionProjectInspectResponse {
            resolution: ProjectResolution::Available {
                effective_project_key: to_executor_path(&effective_project_key, None),
            },
            is_git_repository,
        })
    }

    async fn resolve_file_mentions(
        &self,
        request: ResolveFileMentionsRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<String> {
        let inspected = self
            .inspect(
                ExecutionProjectInspectRequest {
                    project_path: request.project_path,
                    include_git_repository: None,
                },
                options.clone(),
            )
            .await?;
        let path = match inspected.resolution {
            ProjectResolution::Available {
                effective_project_key,
            } => effective_project_key,
            ProjectResolution::Unavailable { reason } => {
                return Err(AgentCallError::new(
                    AgentDeliveryOutcome::NotDispatched,
                    format!("Project folder is unavailable: {reason}"),
                )
                .into());
            }
        };
        let command =
            resolve_file_mentions_in_command(&request.command, &to_native_path(&path, None)).await;
        (self.assert_available)(options.as_ref())?;
        Ok(command)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use garcon_contract::project_resolution::ProjectUnavailableReason;
    use tokio::fs;

    use super::*;

    #[tokio::test]
    async fn project_inspection_and_mentions_observe_the_executor_boundary_and_availability() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("base");
        fs::create_dir(&base).await.unwrap();
        fs::write(root.path().join("outside"), "private")
            .await
            .unwrap();
        let available = Rc::new(Cell::new(true));
        let service = ProjectService::new(
            base.to_str().unwrap(),
            Rc::new({
                let available = available.clone();
                move |_| {
                    if available.get() {
                        Ok(())
                    } else {
                        Err(
                            AgentCallError::new(AgentDeliveryOutcome::NotDispatched, "Disposed")
                                .into(),
                        )
                    }
                }
            }),
        )
        .unwrap();
        let request = ExecutionProjectInspectRequest {
            project_path: root.path().to_str().unwrap().to_owned(),
            include_git_repository: None,
        };
        let inspection = service.inspect(request.clone(), None).await.unwrap();
        assert_eq!(
            inspection.resolution,
            ProjectResolution::Unavailable {
                reason: ProjectUnavailableReason::OutsideBase
            }
        );
        let error = service
            .resolve_file_mentions(
                ResolveFileMentionsRequest {
                    project_path: request.project_path.clone(),
                    command: "Read @outside".to_owned(),
                },
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<AgentCallError>()
                .unwrap()
                .code
                .as_str(),
            "UNAVAILABLE"
        );
        assert_eq!(
            error.to_string(),
            "Project folder is unavailable: outside-base"
        );

        available.set(false);
        let error = service.inspect(request, None).await.unwrap_err();
        assert_eq!(
            error.downcast_ref::<AgentCallError>().unwrap().outcome,
            AgentDeliveryOutcome::NotDispatched
        );
        assert_eq!(error.to_string(), "Disposed");
    }
}
