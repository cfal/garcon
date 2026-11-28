//! Ports `server-agents/common/src/acp/execution.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use async_trait::async_trait;
use garcon_contract::agent_execution::AgentAttachment;
use garcon_contract::transcript_seed::{
    CarriedContext, NativeSeedPlacement, receipt_for_carried_context,
};
use garcon_interface::execution::{
    AgentProjectPathUpdateRequest, AgentRunningSession, AgentSessionConfiguration,
    AgentSessionConfigurationUpdate, AgentSessionConfigurationUpdates,
};
use garcon_interface::producer::AgentEstablishedSession;
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};

use crate::execution::runtime_events::{
    AgentRuntimeEvent, AgentRuntimeExecution, AgentRuntimeExecutionContext, AgentRuntimePublisher,
    AgentRuntimeResumeRequest, AgentRuntimeStartRequest, runtime_operation,
};
use crate::native_session::path_native_session::{PathNativeSessionCodec, PathNativeSessionValue};

use super::agent_runtime::AcpAgentRuntime;
use super::runtime_types::{
    AcpExecutionRequest, AcpProjectPathUpdateRequest, AcpResumeRequest, AcpSessionSettingsPatch,
    AcpStartRequest, AcpStartedSession, SessionActivated,
};

pub struct AcpExecution {
    pub runtime: AcpAgentRuntime,
    pub native_sessions: Rc<PathNativeSessionCodec>,
}

#[async_trait(?Send)]
impl AgentRuntimeExecution for AcpExecution {
    async fn start(
        &self,
        request: AgentRuntimeStartRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<AgentEstablishedSession> {
        let AgentRuntimeStartRequest {
            context,
            prompt,
            attachments,
            carried_context,
        } = request;
        let command = match &carried_context {
            Some(context) => format!("{}{prompt}", context.prefix),
            None => prompt,
        };
        let established = Rc::new(RefCell::new(None));
        let activate: SessionActivated = Rc::new({
            let publish = Rc::clone(&publish);
            let established = Rc::clone(&established);
            let native_sessions = Rc::clone(&self.native_sessions);
            move |started| {
                establish(
                    started,
                    &established,
                    &native_sessions,
                    carried_context.as_ref(),
                    &publish,
                )
            }
        });
        let started = self
            .runtime
            .start_session(AcpStartRequest {
                execution: execution_fields(context, command, attachments, publish),
                on_session_activated: Some(Rc::clone(&activate)),
            })
            .await?;
        if established.borrow().is_none() {
            activate(&started)?;
        }
        // INFALLIBLE: successful activation stores the same established session it publishes.
        Ok(established
            .take()
            .expect("a successful ACP start established its session"))
    }

    async fn resume(
        &self,
        request: AgentRuntimeResumeRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<()> {
        let AgentRuntimeResumeRequest {
            context,
            agent_session_id,
            native_session,
            prompt,
            attachments,
        } = request;
        let native_path = self.native_sessions.decode(native_session.as_ref())?.path;
        self.runtime
            .run_turn(AcpResumeRequest {
                execution: execution_fields(context, prompt, attachments, publish),
                agent_session_id,
                native_path,
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

impl AcpExecution {
    pub fn is_running(&self, id: &str) -> bool {
        self.runtime.is_running(id)
    }

    pub async fn prepare_project_path_update(
        &self,
        request: AgentProjectPathUpdateRequest,
    ) -> ExecutorResult<()> {
        let native_path = self
            .native_sessions
            .decode(request.chat.native_session.as_ref())?
            .path;
        self.runtime
            .prepare_project_path_update(AcpProjectPathUpdateRequest {
                chat_id: request.chat.chat_id,
                agent_session_id: request.chat.agent_session_id,
                previous_project_path: request.chat.project_path,
                next_project_path: request.next_project_path,
                native_path,
            })
            .await
    }
}

#[async_trait(?Send)]
impl AgentSessionConfigurationUpdates for AcpExecution {
    async fn apply(
        &self,
        id: &str,
        configuration: AgentSessionConfigurationUpdate,
        _previous: AgentSessionConfiguration,
        _options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        if configuration.permission_mode_explicit {
            self.runtime.update_session_settings(
                id,
                AcpSessionSettingsPatch {
                    permission_mode: Some(configuration.configuration.permission_mode),
                    ..Default::default()
                },
            );
        }
        Ok(())
    }
}

fn establish(
    started: &AcpStartedSession,
    established: &RefCell<Option<AgentEstablishedSession>>,
    native_sessions: &PathNativeSessionCodec,
    carried_context: Option<&CarriedContext>,
    publish: &AgentRuntimePublisher,
) -> ExecutorResult<()> {
    if established.borrow().is_some() {
        return Ok(());
    }
    let id = &started.agent_session_id;
    let session = AgentEstablishedSession {
        agent_session_id: id.clone(),
        native_session: native_sessions.encode(PathNativeSessionValue {
            path: started.native_path.clone(),
            agent_session_id: Some(id.clone()),
            model_endpoint_id: None,
        }),
        native_seed_receipt: receipt_for_carried_context(
            carried_context,
            id,
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
    publish: AgentRuntimePublisher,
) -> AcpExecutionRequest {
    AcpExecutionRequest {
        chat_id: context.chat_id,
        project_path: context.project_path,
        model: context.model,
        permission_mode: context.permission_mode,
        thinking_mode: context.thinking_mode,
        execution_admission: Some(context.admission),
        command,
        images: Some(attachments),
        operation: runtime_operation(context.run_id, publish),
        env_overrides: Default::default(),
    }
}
