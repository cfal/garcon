//! Ports `server-agents/opencode/src/agents/opencode/forking.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_agents_common::native_session::path_native_session::PathNativeSessionCodec;
use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::transcript_seed::retarget_native_seed_receipt_if_preserved;
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    host::AgentLogger,
    native_fork::{AgentNativeFork, AgentNativeForkOutcome, AgentNativeForkRequest},
    producer::AgentEstablishedSession,
    resources::{AgentInstanceCallOptions, ExecutorResult},
};
use garcon_js::SystemClock;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    endpoint_coordinator::OpenCodeForkOptions,
    execution::{encode_session, resolve_session_id},
    history_loader::{
        HistoryLoadOptions, fetch_open_code_stored_messages, load_required_open_code_chat_messages,
    },
    opencode::OpenCodeRuntime,
};
use crate::js::{AbortSignal, error_of, prop};

#[derive(Clone)]
pub struct OpenCodeNativeForking {
    pub runtime: Rc<OpenCodeRuntime>,
    pub native_sessions: Rc<PathNativeSessionCodec>,
    pub logger: Rc<dyn AgentLogger>,
}

#[async_trait(?Send)]
impl AgentNativeFork for OpenCodeNativeForking {
    async fn fork(
        &self,
        request: AgentNativeForkRequest,
        _: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<AgentNativeForkOutcome> {
        let owner = self.clone();
        self.runtime
            .run_protected_native_fork(move || async move { owner.fork_session(request).await })
            .await
    }

    async fn discard(
        &self,
        session: AgentEstablishedSession,
        signal: CancellationToken,
        _: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<()> {
        AbortSignal::from_token(signal).throw_if_aborted()?;
        self.runtime
            .discard_session(&session.agent_session_id, None)
            .await;
        Ok(())
    }
}

impl OpenCodeNativeForking {
    async fn fork_session(
        &self,
        request: AgentNativeForkRequest,
    ) -> ExecutorResult<AgentNativeForkOutcome> {
        let signal = AbortSignal::from_token(request.signal.clone());
        signal.throw_if_aborted()?;
        let Some(source_id) =
            resolve_session_id(&self.native_sessions, &request.source)?.filter(|id| !id.is_empty())
        else {
            if request.provider_meta.is_some() {
                return Err(not_settled().into());
            }
            return Ok(AgentNativeForkOutcome::Unmaterialized);
        };
        let message_id = if request.provider_meta.is_some() {
            self.resolve_exclusive_boundary(&request, &source_id, &signal)
                .await?
        } else {
            None
        };
        let id = self
            .runtime
            .fork_session(
                &source_id,
                OpenCodeForkOptions {
                    project_path: Some(request.project_path.clone()),
                    message_id,
                    signal: Some(signal.clone()),
                },
                Some(request.permission_mode),
            )
            .await?;
        let materialize = async {
            let receipt = request.source.native_seed_receipt.as_ref();
            let native_seed_receipt = if receipt.is_some() {
                let project_path = &request.project_path;
                let forked_id = &id;
                let load_signal = &signal;
                let rows = self
                    .runtime
                    .with_client_lease(
                        |client| async move {
                            load_required_open_code_chat_messages(
                                Some(forked_id),
                                client.as_ref(),
                                &HistoryLoadOptions {
                                    directory: Some(project_path),
                                    signal: load_signal,
                                    throw_on_error: true,
                                    logger: self.logger.as_ref(),
                                    limit: None,
                                },
                                &SystemClock,
                            )
                            .await
                        },
                        Some(signal.clone()),
                    )
                    .await?;
                signal.throw_if_aborted()?;
                let mut steps = EventLoopSteps::new("opencode-fork-seed");
                let mut messages = Vec::with_capacity(rows.len());
                steps.for_each(rows, |row| messages.push(row.value)).await;
                retarget_native_seed_receipt_if_preserved(receipt, &id, &messages)?
            } else {
                None
            };
            signal.throw_if_aborted()?;
            Ok(AgentEstablishedSession {
                native_session: encode_session(&self.native_sessions, &id),
                agent_session_id: id.clone(),
                native_seed_receipt,
            })
        }
        .await;
        match materialize {
            Ok(session) => Ok(AgentNativeForkOutcome::Materialized { session }),
            Err(failure) => {
                self.runtime
                    .discard_session(&id, Some(&request.project_path))
                    .await;
                Err(failure)
            }
        }
    }

    async fn resolve_exclusive_boundary(
        &self,
        request: &AgentNativeForkRequest,
        id: &str,
        signal: &AbortSignal,
    ) -> ExecutorResult<Option<String>> {
        let entry_id = request
            .provider_meta
            .as_ref()
            .and_then(|meta| meta.get("entryId"))
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(not_settled)?;
        let messages = self
            .runtime
            .with_client_lease(
                |client| async move {
                    fetch_open_code_stored_messages(
                        Some(id),
                        client.as_ref(),
                        &HistoryLoadOptions {
                            directory: Some(&request.project_path),
                            signal,
                            throw_on_error: true,
                            logger: self.logger.as_ref(),
                            limit: None,
                        },
                    )
                    .await
                },
                Some(signal.clone()),
            )
            .await;
        signal.throw_if_aborted()?;
        let messages = messages.map_err(|failure| {
            if error_of::<AgentIntegrationError>(failure.as_ref()).is_some() {
                failure
            } else {
                AgentIntegrationError::new(
                    Code::TRANSCRIPT_UNAVAILABLE,
                    "OpenCode fork boundary resolution failed",
                    true,
                    None,
                )
                .into()
            }
        })?;
        exclusive_boundary(&messages, entry_id).await
    }
}

// Native fork excludes the boundary message itself, so a point fork asks
// OpenCode to stop just before the first message after the anchor.
async fn exclusive_boundary(messages: &[Value], entry_id: &str) -> ExecutorResult<Option<String>> {
    if messages.is_empty() {
        return Err(fork_failure(
            "The OpenCode source session is unavailable",
            "source-missing",
        )
        .into());
    }
    let mut steps = EventLoopSteps::new("opencode-fork-boundary");
    for (index, message) in messages.iter().enumerate() {
        steps.next().await;
        let owns_entry = prop(prop(message, "info"), "id").as_str() == Some(entry_id)
            || prop(message, "parts").as_array().is_some_and(|parts| {
                parts
                    .iter()
                    .any(|part| prop(part, "id").as_str() == Some(entry_id))
            });
        if owns_entry {
            let Some(boundary) = messages.get(index + 1) else {
                return Ok(None);
            };
            let id = prop(prop(boundary, "info"), "id")
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(not_settled)?;
            return Ok(Some(id.to_owned()));
        }
    }
    Err(not_settled().into())
}

fn not_settled() -> AgentIntegrationError {
    fork_failure(
        "The selected ledger row has no provider-native fork position",
        "not-settled",
    )
}

fn fork_failure(message: &str, reason: &str) -> AgentIntegrationError {
    AgentIntegrationError::new(
        Code::TRANSCRIPT_UNAVAILABLE,
        message,
        true,
        Some(Map::from_iter([(
            "nativeForkReason".to_owned(),
            json!(reason),
        )])),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn uses_the_message_after_the_anchor_and_omits_a_tip_boundary() {
        let messages = [
            json!({"info": {"id": "a"}, "parts": [{"id": "part"}]}),
            json!({"info": {"id": "b"}}),
        ];
        assert_eq!(
            exclusive_boundary(&messages, "part")
                .await
                .unwrap()
                .as_deref(),
            Some("b")
        );
        assert_eq!(
            exclusive_boundary(&messages, "a").await.unwrap().as_deref(),
            Some("b")
        );
        assert_eq!(exclusive_boundary(&messages, "b").await.unwrap(), None);
    }

    #[tokio::test]
    async fn distinguishes_a_missing_source_from_an_unsettled_row() {
        let messages = [json!({"info": {"id": "before"}}), json!({"info": {}})];
        for (messages, anchor, reason) in [
            (&messages[..], "missing", "not-settled"),
            (&messages[..], "before", "not-settled"),
            (&[][..], "missing", "source-missing"),
        ] {
            let failure = exclusive_boundary(messages, anchor).await.unwrap_err();
            let failure = failure.downcast::<AgentIntegrationError>().unwrap();
            assert_eq!(failure.code, Code::TRANSCRIPT_UNAVAILABLE);
            assert_eq!(
                failure
                    .details
                    .as_ref()
                    .and_then(|map| map.get("nativeForkReason")),
                Some(&json!(reason))
            );
        }
    }
}
