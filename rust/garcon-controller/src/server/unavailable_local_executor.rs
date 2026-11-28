use std::{error::Error, rc::Rc};

use garcon_contract::{
    api_providers::ApiProviderModelDiscoveryResponse, executors::LOCAL_EXECUTOR_ID,
};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome},
    execution_runtime::{
        ApiProviderDiscoveryRequest, ExecutionProjectService, ExecutionRuntimeApi,
        ExecutorAvailability, ExecutorInfo,
    },
    files::ExecutionFilesService,
    git::{ExecutionGhService, ExecutionGitService},
    integration::AgentIntegration,
    resources::{ExecutorCallOptions, ExecutorResult},
    terminals::ExecutionTerminalService,
};

pub struct UnavailableLocalExecutor;

fn unavailable() -> Box<dyn Error> {
    Box::new(AgentCallError::new(
        AgentDeliveryOutcome::NotDispatched,
        "Local executor is unavailable",
    ))
}

#[async_trait::async_trait(?Send)]
impl ExecutionRuntimeApi for UnavailableLocalExecutor {
    fn id(&self) -> &str {
        LOCAL_EXECUTOR_ID
    }

    fn availability(&self) -> ExecutorAvailability {
        ExecutorAvailability::Offline
    }

    async fn get_info(&self, _: Option<ExecutorCallOptions>) -> ExecutorResult<ExecutorInfo> {
        Err(unavailable())
    }

    async fn get_agent_integration(
        &self,
        _: &str,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<AgentIntegration>> {
        Err(unavailable())
    }

    async fn get_project_service(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionProjectService>> {
        Err(unavailable())
    }

    async fn discover_api_provider_models(
        &self,
        _: ApiProviderDiscoveryRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ApiProviderModelDiscoveryResponse> {
        Err(unavailable())
    }

    async fn get_files_service(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionFilesService>> {
        Err(unavailable())
    }

    async fn get_git_service(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionGitService>> {
        Err(unavailable())
    }

    async fn get_gh_service(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionGhService>> {
        Err(unavailable())
    }

    async fn get_terminal_service(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionTerminalService>> {
        Err(unavailable())
    }

    fn on_availability_changed(&self, _: Rc<dyn Fn(ExecutorAvailability)>) -> Box<dyn Fn()> {
        Box::new(|| {})
    }

    async fn dispose(&self) -> ExecutorResult<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use garcon_interface::errors::AgentIntegrationErrorCode;

    use super::*;

    #[tokio::test]
    async fn unavailable_local_does_not_report_runtime_information() {
        let local = UnavailableLocalExecutor;
        assert_eq!(local.id(), LOCAL_EXECUTOR_ID);
        let error = local.get_info(None).await.unwrap_err();
        let error = error.downcast_ref::<AgentCallError>().unwrap();
        assert_eq!(error.outcome, AgentDeliveryOutcome::NotDispatched);
        assert_eq!(error.code, AgentIntegrationErrorCode::UNAVAILABLE);
        assert_eq!(error.to_string(), "Local executor is unavailable");
        local.dispose().await.unwrap();
        local.dispose().await.unwrap();
        assert_eq!(local.availability(), ExecutorAvailability::Offline);
    }
}
