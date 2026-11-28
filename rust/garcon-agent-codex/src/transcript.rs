use std::rc::Rc;

use async_trait::async_trait;
use garcon_agents_common::native_session::{
    evidence_source::{
        AgentNativeEvidenceRequest, AgentNativeEvidenceSnapshot, AgentNativeEvidenceSource,
    },
    path_native_session::{PathNativeSessionCodec, PathNativeSessionValue},
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    host::AgentLogger,
    native_history::{AgentNativeSessionAccess, AgentNativeSessionReleaseRequest},
    resources::ExecutorResult,
    transcript::{AgentChatReference, AgentNativeSessionRef, AgentTranscriptSourceLocation},
};
use serde_json::{Map, json};
use tokio_util::sync::CancellationToken;

use crate::{
    app_server::runtime::managed::CodexAppServerRuntime, history_profile::check_aborted,
    history_source::CodexHistoryService, native_path::resolve_codex_native_path,
};

pub struct CodexNativeEvidence {
    pub runtime: CodexAppServerRuntime,
    pub history: Rc<CodexHistoryService>,
    pub native_sessions: Rc<PathNativeSessionCodec>,
    pub logger: Rc<dyn AgentLogger>,
}

impl CodexNativeEvidence {
    fn reference(&self, chat: &AgentChatReference) -> ExecutorResult<PathNativeSessionValue> {
        let mut native = self.native_sessions.decode(chat.native_session.as_ref())?;
        native.agent_session_id = chat.agent_session_id.clone().or(native.agent_session_id);
        Ok(native)
    }

    async fn resolve_path(
        &self,
        reference: &PathNativeSessionValue,
        signal: &CancellationToken,
    ) -> ExecutorResult<Option<String>> {
        let thread_id = reference.agent_session_id.as_deref();
        resolve_codex_native_path(
            thread_id,
            reference.path.as_deref(),
            || self.runtime.resolve_native_path(thread_id),
            self.logger.as_ref(),
            signal,
        )
        .await
    }

    pub async fn load_legacy(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<AgentNativeEvidenceSnapshot> {
        check_aborted(&request.signal)?;
        let reference = self.reference(&request.chat)?;
        let path = self.resolve_path(&reference, &request.signal).await?;
        Ok(AgentNativeEvidenceSnapshot {
            messages: self
                .history
                .load(
                    path.as_deref(),
                    reference.agent_session_id.as_deref(),
                    &request.signal,
                )
                .await?,
        })
    }
}

#[async_trait(?Send)]
impl AgentNativeEvidenceSource for CodexNativeEvidence {
    async fn load(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<AgentNativeEvidenceSnapshot> {
        check_aborted(&request.signal)?;
        let reference = self.reference(&request.chat)?;
        let path = self.resolve_path(&reference, &request.signal).await?;
        let thread_id = reference.agent_session_id.as_deref();
        if path.is_none()
            && let Some(thread_id) = thread_id.filter(|id| !id.is_empty())
        {
            self.runtime
                .request_native_path_discovery_refresh(thread_id);
            return Err(AgentIntegrationError::new(
                Code::TRANSCRIPT_UNAVAILABLE,
                "Codex native transcript could not be resolved",
                true,
                Some(Map::from_iter([
                    ("provider".into(), json!("codex")),
                    ("agentSessionId".into(), json!(thread_id)),
                    ("reason".into(), json!("not-found")),
                ])),
            )
            .into());
        }
        Ok(AgentNativeEvidenceSnapshot {
            messages: self
                .history
                .load(path.as_deref(), thread_id, &request.signal)
                .await?,
        })
    }
}

#[async_trait(?Send)]
impl AgentNativeSessionAccess for CodexNativeEvidence {
    async fn resolve_native_session(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        check_aborted(&request.signal)?;
        let current = self
            .native_sessions
            .decode(request.chat.native_session.as_ref())?;
        let mut reference = self.reference(&request.chat)?;
        let Some(thread_id) = reference
            .agent_session_id
            .as_deref()
            .filter(|id| !id.is_empty())
        else {
            return Ok(None);
        };
        let Some(path) = self.resolve_path(&reference, &request.signal).await? else {
            return Ok(request.chat.native_session.filter(|_| {
                current.path.is_none() && current.agent_session_id.as_deref() == Some(thread_id)
            }));
        };
        if current.path.as_ref() == Some(&path) && request.chat.native_session.is_some() {
            return Ok(request.chat.native_session);
        }
        reference.path = Some(path);
        Ok(self.native_sessions.encode(reference))
    }

    async fn describe_source(
        &self,
        request: AgentNativeEvidenceRequest,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>> {
        check_aborted(&request.signal)?;
        let reference = self.reference(&request.chat)?;
        Ok(self
            .resolve_path(&reference, &request.signal)
            .await?
            .map(|value| AgentTranscriptSourceLocation::FilesystemPath { value }))
    }

    async fn release(&self, request: AgentNativeSessionReleaseRequest) -> ExecutorResult<()> {
        let request = request.request;
        check_aborted(&request.signal)?;
        let thread_id = match request.chat.agent_session_id {
            Some(thread_id) => Some(thread_id),
            None => {
                self.native_sessions
                    .decode(request.chat.native_session.as_ref())?
                    .agent_session_id
            }
        };
        self.runtime
            .release_session(&request.chat.chat_id, thread_id.as_deref())
            .await;
        Ok(())
    }
}
