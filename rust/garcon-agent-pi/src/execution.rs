//! Ports `server-agents/pi/src/agents/pi/execution.ts`.

use std::{cell::RefCell, rc::Rc};

use async_trait::async_trait;
use garcon_agents_common::{
    execution::{
        control_adapters::RuntimeSteering,
        runtime_events::{
            AgentRuntimeEvent, AgentRuntimeExecution, AgentRuntimeExecutionContext,
            AgentRuntimePublisher, AgentRuntimeResumeRequest, AgentRuntimeStartRequest,
            RuntimeSteerRequest, RuntimeSteerTarget, runtime_operation,
        },
    },
    native_session::path_native_session::{PathNativeSessionCodec, PathNativeSessionValue},
};
use garcon_contract::{
    agent_execution::AgentAttachment, transcript_seed::receipt_for_carried_context,
};
use garcon_interface::{
    execution::AgentRunningSession, producer::AgentEstablishedSession, resources::ExecutorResult,
    services::AgentSteerResult,
};

use crate::{
    lazy_runtime::LazyPiRuntime,
    runtime_types::{PiExecutionRequest, PiResumeRequest, PiStartRequest, PiStartedSession},
};

pub struct PiExecution {
    pub runtime: Rc<LazyPiRuntime>,
    pub native_sessions: Rc<PathNativeSessionCodec>,
}

#[async_trait(?Send)]
impl AgentRuntimeExecution for PiExecution {
    async fn start(
        &self,
        request: AgentRuntimeStartRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<AgentEstablishedSession> {
        let seed = request
            .carried_context
            .as_ref()
            .map_or("", |context| context.prefix.as_str());
        let command = format!("{seed}{}", request.prompt);
        let execution = execution_fields(
            request.context,
            command,
            request.attachments,
            publish.clone(),
        );
        let established = RefCell::<Option<AgentEstablishedSession>>::new(None);
        let establish = Rc::new({
            let native_sessions = self.native_sessions.clone();
            move |result: &PiStartedSession| -> ExecutorResult<AgentEstablishedSession> {
                if let Some(session) = &*established.borrow() {
                    return Ok(session.clone());
                }
                let session = AgentEstablishedSession {
                    agent_session_id: result.agent_session_id.clone(),
                    native_session: native_sessions.encode(PathNativeSessionValue {
                        path: result.native_path.clone(),
                        agent_session_id: Some(result.agent_session_id.clone()),
                        model_endpoint_id: None,
                    }),
                    native_seed_receipt: receipt_for_carried_context(
                        request.carried_context.as_ref(),
                        &result.agent_session_id,
                        None,
                    )?,
                };
                established.replace(Some(session.clone()));
                publish(AgentRuntimeEvent::Session {
                    session: session.clone(),
                });
                Ok(session)
            }
        });
        let result = self
            .runtime
            .start_session(PiStartRequest {
                execution,
                on_session_activated: Some(Rc::new({
                    let establish = establish.clone();
                    move |result| establish(result).map(|_| ())
                })),
            })
            .await?;
        establish(&result)
    }

    async fn resume(
        &self,
        request: AgentRuntimeResumeRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<()> {
        let path = self
            .native_sessions
            .decode(request.native_session.as_ref())?
            .path;
        self.runtime
            .run_turn(PiResumeRequest {
                execution: execution_fields(
                    request.context,
                    request.prompt,
                    request.attachments,
                    publish,
                ),
                agent_session_id: request.agent_session_id,
                native_path: path,
            })
            .await
    }

    async fn abort(&self, agent_session_id: &str) -> ExecutorResult<bool> {
        self.runtime.abort(agent_session_id).await
    }
    fn running_sessions(&self) -> Vec<AgentRunningSession> {
        self.runtime.running_sessions()
    }
}

#[async_trait(?Send)]
impl RuntimeSteering for PiExecution {
    fn capture_target(&self, agent_session_id: &str) -> Option<RuntimeSteerTarget> {
        self.runtime.capture_steer_target(agent_session_id)
    }
    async fn steer(&self, request: RuntimeSteerRequest) -> ExecutorResult<AgentSteerResult> {
        self.runtime.steer(request).await
    }
}

fn execution_fields(
    context: AgentRuntimeExecutionContext,
    command: String,
    images: Vec<AgentAttachment>,
    publish: AgentRuntimePublisher,
) -> PiExecutionRequest {
    PiExecutionRequest {
        chat_id: context.chat_id,
        project_path: context.project_path,
        model: context.model,
        permission_mode: context.permission_mode,
        thinking_mode: context.thinking_mode,
        execution_admission: Some(context.admission),
        operation: runtime_operation(context.run_id, publish),
        command,
        images,
        env_overrides: None,
    }
}
