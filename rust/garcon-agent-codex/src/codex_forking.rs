use std::{error::Error, io, rc::Rc, sync::LazyLock};

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_agents_common::{
    forking::jsonl_forking::missing_native_point,
    native_session::path_native_session::PathNativeSessionCodec,
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    native_fork::{AgentNativeFork, AgentNativeForkOutcome, AgentNativeForkRequest},
    native_history::{AgentHistoryImportRequest, AgentNativeSessionAccess},
    producer::AgentEstablishedSession,
    resources::{AgentInstanceCallOptions, ExecutorResult},
};
use regress::Regex;
use serde_json::{Map, json};
use tokio_util::sync::CancellationToken;

use crate::{
    app_server::{client::CodexAppServerRpcError, endpoint_runtime::assert_codex_session_endpoint},
    history_profile::{
        CodexHistoryProfile, CodexSessionIdentityInput, check_aborted,
        inspect_codex_history_profile,
    },
    message_source_identity::codex_turn_id_from_entry_id,
};

pub type ForkPaginated =
    dyn Fn(
        AgentNativeForkRequest,
        Option<String>,
    ) -> LocalBoxFuture<'static, ExecutorResult<Option<AgentEstablishedSession>>>;

pub struct CodexForking {
    pub native_sessions: Rc<PathNativeSessionCodec>,
    pub journal: Rc<dyn AgentNativeFork>,
    pub native_evidence: Rc<dyn AgentNativeSessionAccess>,
    pub fork_paginated: Rc<ForkPaginated>,
}

#[async_trait(?Send)]
impl AgentNativeFork for CodexForking {
    async fn fork(
        &self,
        mut request: AgentNativeForkRequest,
        options: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<AgentNativeForkOutcome> {
        check_aborted(&request.signal)?;
        if request.source.native_session.is_some() || request.source.agent_session_id.is_some() {
            let source = self
                .native_sessions
                .decode(request.source.native_session.as_ref())?;
            assert_codex_session_endpoint(
                source.model_endpoint_id.as_deref(),
                request
                    .endpoint
                    .as_ref()
                    .map(|endpoint| endpoint.endpoint_id.as_str()),
            )?;
        }
        let resolved = self
            .native_evidence
            .resolve_native_session(AgentHistoryImportRequest {
                chat: request.source.clone(),
                signal: request.signal.clone(),
            })
            .await;
        check_aborted(&request.signal)?;
        request.source.native_session = match resolved {
            Ok(session) => session,
            Err(error) if request.provider_meta.is_none() && is_empty_source(error.as_ref()) => {
                return Ok(AgentNativeForkOutcome::Unmaterialized);
            }
            Err(error) => return Err(error),
        };
        if !matches!(
            self.resolve_profile(&request).await?,
            Some(CodexHistoryProfile::Paginated { .. })
        ) {
            return self.journal.fork(request, options).await;
        }

        let last_turn_id = request
            .provider_meta
            .as_ref()
            .map(|meta| {
                codex_turn_id_from_entry_id(&meta["entryId"])
                    .map(str::to_owned)
                    .ok_or_else(missing_native_point)
            })
            .transpose()?;
        let at_point = last_turn_id.is_some();
        match (self.fork_paginated)(request, last_turn_id).await {
            Ok(Some(session)) => Ok(AgentNativeForkOutcome::Materialized { session }),
            Ok(None) => Err(paginated_fork_unsupported().into()),
            Err(error) if at_point && is_unsettled_paginated_fork_point(error.as_ref()) => {
                Err(missing_native_point().into())
            }
            Err(error) if is_unsupported_paginated_fork(error.as_ref()) => {
                Err(paginated_fork_unsupported().into())
            }
            Err(error) => Err(error),
        }
    }

    async fn discard(
        &self,
        session: AgentEstablishedSession,
        signal: CancellationToken,
        options: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<()> {
        self.journal.discard(session, signal, options).await
    }
}

impl CodexForking {
    async fn resolve_profile(
        &self,
        request: &AgentNativeForkRequest,
    ) -> ExecutorResult<Option<CodexHistoryProfile>> {
        let source = self
            .native_sessions
            .decode(request.source.native_session.as_ref())?;
        if let Some(path) = source.path.as_deref()
            && codex_rollout_has_content(path).await?
        {
            return inspect_codex_history_profile(CodexSessionIdentityInput {
                native_path: path,
                expected_thread_id: request
                    .source
                    .agent_session_id
                    .as_deref()
                    .or(source.agent_session_id.as_deref()),
                signal: &request.signal,
            })
            .await
            .map(Some);
        }
        if request.provider_meta.is_some() {
            return Err(AgentIntegrationError::new(
                Code::TRANSCRIPT_UNAVAILABLE,
                "Source native transcript is unavailable",
                false,
                None,
            )
            .into());
        }
        Ok(None)
    }
}

pub(super) async fn codex_rollout_has_content(path: &str) -> io::Result<bool> {
    match tokio::fs::metadata(path).await {
        Ok(metadata) => Ok(metadata.len() > 0),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

fn is_empty_source(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<AgentIntegrationError>()
        .is_some_and(|error| {
            error.code == Code::TRANSCRIPT_UNAVAILABLE
                && error
                    .details
                    .as_ref()
                    .is_some_and(|details| details["reason"] == "empty-source")
        })
}

pub fn is_codex_thread_not_found(error: &(dyn Error + 'static)) -> bool {
    static NO_ROLLOUT: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expressions are valid.
        Regex::with_flags(r"^no rollout found for thread id [0-9a-f-]{36}$", "i")
            .expect("Codex missing rollout pattern")
    });
    static MISSING_PATH: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::new(r"^failed to resolve rollout path `[^`]+`: file does not exist$")
            .expect("Codex missing path pattern")
    });
    error
        .downcast_ref::<CodexAppServerRpcError>()
        .is_some_and(|error| {
            error.code.0 == -32600.0
                && (NO_ROLLOUT.find(&error.message).is_some()
                    || MISSING_PATH.find(&error.message).is_some())
        })
}

fn is_unsupported_paginated_fork(error: &(dyn Error + 'static)) -> bool {
    if let Some(error) = error.downcast_ref::<AgentIntegrationError>() {
        return error.code == Code::OPERATION_UNSUPPORTED;
    }
    error
        .downcast_ref::<CodexAppServerRpcError>()
        .is_some_and(|error| {
            error.code.0 == -32601.0 || {
                let message = error.message.to_lowercase();
                ["paginated_threads", "paginated threads", "not supported"]
                    .iter()
                    .any(|pattern| message.contains(pattern))
            }
        })
}

fn is_unsettled_paginated_fork_point(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<CodexAppServerRpcError>()
        .is_some_and(|error| {
            error.code.0 == -32600.0
                && (error.message.contains("identifies an in-progress turn")
                    || error.message.starts_with("turn not found: "))
        })
}

fn paginated_fork_unsupported() -> AgentIntegrationError {
    AgentIntegrationError::new(
        Code::OPERATION_UNSUPPORTED,
        "Codex paginated history cannot be forked by the installed Codex CLI",
        false,
        Some(Map::from_iter([
            ("operation".into(), json!("fork")),
            ("historyMode".into(), json!("paginated")),
            ("provider".into(), json!("codex")),
        ])),
    )
}
