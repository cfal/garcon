//! Ports `server-agents/common/src/direct/execution.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use async_trait::async_trait;
use garcon_contract::agent_execution::AgentAttachment;
use garcon_contract::transcript_seed::{
    CarriedContext, NativeSeedPlacement, receipt_for_carried_context,
};
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::execution::AgentRunningSession;
use garcon_interface::host::AgentApiProviderReader;
use garcon_interface::producer::AgentEstablishedSession;
use garcon_interface::resources::ExecutorResult;

use crate::execution::resolve_endpoint::resolve_agent_endpoint;
use crate::execution::runtime_events::{
    AgentRuntimeEvent, AgentRuntimeExecution, AgentRuntimeExecutionContext, AgentRuntimePublisher,
    AgentRuntimeResumeRequest, AgentRuntimeStartRequest, runtime_operation,
};

use super::router::{DirectCompatibleRuntime, DirectEndpointRouterRuntime};
use super::runtime_types::{
    DirectEndpointRuntime, DirectExecutionRequest, DirectResumeRequest, DirectStartRequest,
    DirectStartedSession, SessionActivated,
};

pub struct DirectExecution<R> {
    pub api_providers: Rc<dyn AgentApiProviderReader>,
    pub runtime: Rc<DirectEndpointRouterRuntime<R>>,
}

impl<R: DirectCompatibleRuntime> DirectExecution<R> {
    async fn endpoint(
        &self,
        request: &mut AgentRuntimeExecutionContext,
    ) -> ExecutorResult<DirectEndpointRuntime> {
        let signal = request.admission.signal();
        resolve_agent_endpoint(self.api_providers.as_ref(), request.endpoint.take(), signal)
            .await?
            .ok_or_else(|| {
                AgentIntegrationError::new(
                    AgentIntegrationErrorCode::INVALID_ENDPOINT,
                    "A compatible API provider endpoint is required",
                    false,
                    None,
                )
                .into()
            })
    }

    pub fn is_running(&self, id: &str) -> bool {
        self.runtime.is_running(id)
    }
}

#[async_trait(?Send)]
impl<R: DirectCompatibleRuntime> AgentRuntimeExecution for DirectExecution<R> {
    async fn start(
        &self,
        request: AgentRuntimeStartRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<AgentEstablishedSession> {
        let AgentRuntimeStartRequest {
            mut context,
            prompt,
            attachments,
            carried_context,
        } = request;
        let endpoint = self.endpoint(&mut context).await?;
        let command = match &carried_context {
            Some(context) => format!("{}{prompt}", context.prefix),
            None => prompt,
        };
        let established = Rc::new(RefCell::new(None));
        let activate: SessionActivated = Rc::new({
            let sink = publish.clone();
            let established = established.clone();
            move |started| establish(started, &established, carried_context.as_ref(), &sink)
        });
        let result = self
            .runtime
            .start_session(DirectStartRequest {
                execution: execution_fields(context, command, attachments, endpoint, publish),
                on_session_activated: Some(activate.clone()),
            })
            .await?;
        if established.borrow().is_none() {
            activate(&result)?;
        }
        // INFALLIBLE: successful activation fills the established session exactly once.
        Ok(established
            .take()
            .expect("a successful direct start established its session"))
    }

    async fn resume(
        &self,
        request: AgentRuntimeResumeRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<()> {
        let AgentRuntimeResumeRequest {
            mut context,
            agent_session_id,
            native_session,
            prompt,
            attachments,
        } = request;
        let endpoint = self.endpoint(&mut context).await?;
        self.runtime
            .run_turn(DirectResumeRequest {
                execution: execution_fields(context, prompt, attachments, endpoint, publish),
                agent_session_id,
                native_session,
            })
            .await
    }

    async fn abort(&self, id: &str) -> ExecutorResult<bool> {
        Ok(self.runtime.abort(id))
    }

    fn running_sessions(&self) -> Vec<AgentRunningSession> {
        self.runtime.get_running_sessions()
    }
}

fn establish(
    started: &DirectStartedSession,
    established: &RefCell<Option<AgentEstablishedSession>>,
    carried_context: Option<&CarriedContext>,
    publish: &AgentRuntimePublisher,
) -> ExecutorResult<()> {
    if established.borrow().is_some() {
        return Ok(());
    }
    let session = AgentEstablishedSession {
        agent_session_id: started.agent_session_id.clone(),
        native_session: Some(started.native_session.clone()),
        native_seed_receipt: receipt_for_carried_context(
            carried_context,
            &started.agent_session_id,
            Some(NativeSeedPlacement::UserPrefix),
        )?,
    };
    established.replace(Some(session.clone()));
    publish(AgentRuntimeEvent::Session { session });
    Ok(())
}

fn execution_fields(
    context: AgentRuntimeExecutionContext,
    command: String,
    attachments: Vec<AgentAttachment>,
    endpoint: DirectEndpointRuntime,
    publish: AgentRuntimePublisher,
) -> DirectExecutionRequest {
    DirectExecutionRequest {
        chat_id: context.chat_id,
        project_path: context.project_path,
        model: context.model,
        permission_mode: context.permission_mode,
        thinking_mode: context.thinking_mode,
        execution_admission: Some(context.admission),
        command,
        images: Some(attachments),
        endpoint,
        operation: runtime_operation(context.run_id, publish),
    }
}

#[cfg(test)]
mod tests;
