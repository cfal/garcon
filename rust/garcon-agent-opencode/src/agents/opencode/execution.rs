//! Ports `server-agents/opencode/src/agents/opencode/execution.ts`.

use std::{cell::RefCell, rc::Rc};

use async_trait::async_trait;
use garcon_agents_common::{
    chats::artificial_native_path::{
        create_artificial_native_path, get_artificial_agent_session_id,
    },
    execution::runtime_events::{
        AgentRuntimeEvent, AgentRuntimeExecution, AgentRuntimeExecutionContext,
        AgentRuntimePublisher, AgentRuntimeResumeRequest, AgentRuntimeStartRequest,
        runtime_operation,
    },
    native_session::path_native_session::{PathNativeSessionCodec, PathNativeSessionValue},
};
use garcon_contract::transcript_seed::receipt_for_carried_context;
use garcon_interface::{
    execution::{AgentRunningSession, AgentSessionConfigurationUpdates},
    producer::AgentEstablishedSession,
    resources::{ExecutorCallOptions, ExecutorResult},
    transcript::{AgentChatReference, AgentNativeSessionRef},
};

use super::{
    opencode::OpenCodeRuntime,
    runtime_types::{
        OpenCodeExecutionRequest, OpenCodeResumeRequest, OpenCodeSessionSettingsPatch,
        OpenCodeStartRequest,
    },
};

pub struct OpenCodeExecution {
    pub runtime: Rc<OpenCodeRuntime>,
    pub native_sessions: Rc<PathNativeSessionCodec>,
}

pub(crate) fn encode_session(
    codec: &PathNativeSessionCodec,
    id: &str,
) -> Option<AgentNativeSessionRef> {
    codec.encode(PathNativeSessionValue {
        path: create_artificial_native_path(Some("opencode"), Some(id)),
        agent_session_id: Some(id.to_owned()),
        model_endpoint_id: None,
    })
}

pub(crate) fn resolve_session_id(
    codec: &PathNativeSessionCodec,
    chat: &AgentChatReference,
) -> ExecutorResult<Option<String>> {
    let native = codec.decode(chat.native_session.as_ref())?;
    Ok(chat
        .agent_session_id
        .clone()
        .or(native.agent_session_id)
        .or_else(|| {
            let path = serde_json::Value::String(native.path?);
            get_artificial_agent_session_id(&path, ["opencode"])
        }))
}

#[async_trait(?Send)]
impl AgentRuntimeExecution for OpenCodeExecution {
    async fn start(
        &self,
        request: AgentRuntimeStartRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<AgentEstablishedSession> {
        let carried_context = request.carried_context;
        let seed = carried_context
            .as_ref()
            .map_or("", |context| context.prefix.as_str());
        let command = format!("{seed}{}", request.prompt);
        let native_sessions = self.native_sessions.clone();
        let established = Rc::new(RefCell::new(None::<AgentEstablishedSession>));
        let activate = Rc::new({
            let established = established.clone();
            let publish = publish.clone();
            move |id: &str| {
                if established.borrow().is_some() {
                    return;
                }
                let session = AgentEstablishedSession {
                    agent_session_id: id.to_owned(),
                    native_session: encode_session(&native_sessions, id),
                    // INFALLIBLE: Runtime admission rejects a missing session ID.
                    native_seed_receipt: receipt_for_carried_context(
                        carried_context.as_ref(),
                        id,
                        None,
                    )
                    .expect("admitted session has an ID"),
                };
                established.replace(Some(session.clone()));
                publish(AgentRuntimeEvent::Session { session });
            }
        });
        let id = self
            .runtime
            .start_session(OpenCodeStartRequest {
                execution: execution_fields(request.context, publish),
                command,
                images: request.attachments,
                on_session_activated: Some(activate.clone()),
            })
            .await?;
        activate(&id);
        // INFALLIBLE: Activation assigned the session before publishing it.
        Ok(established.take().expect("admitted session was activated"))
    }

    async fn resume(
        &self,
        request: AgentRuntimeResumeRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<()> {
        self.runtime
            .run_turn(OpenCodeResumeRequest {
                start: OpenCodeStartRequest {
                    execution: execution_fields(request.context, publish),
                    command: request.prompt,
                    images: request.attachments,
                    on_session_activated: None,
                },
                agent_session_id: request.agent_session_id,
            })
            .await
    }

    async fn abort(&self, id: &str) -> ExecutorResult<bool> {
        Ok(self.runtime.abort(id).await)
    }

    fn running_sessions(&self) -> Vec<AgentRunningSession> {
        self.runtime.running_sessions()
    }
}

impl OpenCodeExecution {
    pub async fn compact(
        &self,
        request: AgentRuntimeResumeRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<()> {
        self.runtime
            .compact(
                &request.agent_session_id,
                execution_fields(request.context, publish),
            )
            .await
    }
}

#[async_trait(?Send)]
impl AgentSessionConfigurationUpdates for OpenCodeExecution {
    async fn apply(
        &self,
        agent_session_id: &str,
        configuration: garcon_interface::execution::AgentSessionConfigurationUpdate,
        _: garcon_interface::execution::AgentSessionConfiguration,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        self.runtime.update_session_settings(
            agent_session_id,
            OpenCodeSessionSettingsPatch {
                model: Some(configuration.configuration.model),
                thinking_mode: Some(configuration.configuration.thinking_mode),
                permission_mode: Some(configuration.configuration.permission_mode),
            },
        );
        Ok(())
    }
}

fn execution_fields(
    request: AgentRuntimeExecutionContext,
    publish: AgentRuntimePublisher,
) -> OpenCodeExecutionRequest {
    OpenCodeExecutionRequest {
        chat_id: request.chat_id,
        project_path: request.project_path,
        model: Some(request.model),
        permission_mode: request.permission_mode,
        thinking_mode: Some(request.thinking_mode),
        execution_admission: Some(request.admission),
        operation: runtime_operation(request.run_id, publish),
    }
}
