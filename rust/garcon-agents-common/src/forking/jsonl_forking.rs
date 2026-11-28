use std::{io, rc::Rc};

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_base::errors::{ErrorInput, has_node_error_code};
use garcon_contract::{
    chat_types::ChatMessage, transcript_seed::retarget_native_seed_receipt_if_preserved,
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    native_fork::{AgentNativeFork, AgentNativeForkOutcome, AgentNativeForkRequest},
    native_message_source::{NativeMessageSource, get_native_message_revision_source},
    producer::AgentEstablishedSession,
    resources::{AgentInstanceCallOptions, ExecutorResult},
    transcript::AgentChatReference,
};
use garcon_js::{
    is_safe_integer,
    json::{Opaque, as_number},
};
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::fs;
use tokio_util::sync::CancellationToken;

use super::fork_jsonl::{
    CreateTargetPath, ForkJsonlOutcome, ForkJsonlRequest, JsonlSourcePrefixChangedError,
    RewriteEntry, TransformEntries, fork_jsonl_transcript,
};
use crate::{
    execution::admission::check_signal,
    native_session::{
        evidence_source::{AgentNativeEvidenceRequest, AgentNativeEvidenceSource},
        path_native_session::{PathNativeSessionCodec, PathNativeSessionValue},
    },
};

pub type ForkWholeSession =
    dyn Fn(
        AgentNativeForkRequest,
    ) -> LocalBoxFuture<'static, ExecutorResult<Option<AgentEstablishedSession>>>;
pub type SemanticDigest =
    dyn for<'a> Fn(&'a [ChatMessage]) -> LocalBoxFuture<'a, ExecutorResult<String>>;

pub struct JsonlNativeForkingOptions {
    pub native_evidence: Rc<dyn AgentNativeEvidenceSource>,
    pub native_sessions: Rc<PathNativeSessionCodec>,
    pub rewrite_entry: Option<Rc<RewriteEntry>>,
    pub create_rewrite_entry: Option<Rc<dyn Fn() -> Option<Rc<RewriteEntry>>>>,
    pub fork_whole_session: Option<Rc<ForkWholeSession>>,
    pub transform_entries: Option<Rc<TransformEntries>>,
    pub create_target_path: Option<Rc<CreateTargetPath>>,
    pub allow_unmaterialized_whole_session: bool,
    pub semantic_digest: Option<Rc<SemanticDigest>>,
}

pub struct JsonlNativeForking(JsonlNativeForkingOptions);

pub fn create_jsonl_native_forking(options: JsonlNativeForkingOptions) -> JsonlNativeForking {
    JsonlNativeForking(options)
}

#[async_trait(?Send)]
impl AgentNativeFork for JsonlNativeForking {
    async fn fork(
        &self,
        mut request: AgentNativeForkRequest,
        _options: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<AgentNativeForkOutcome> {
        check_signal(Some(&request.signal))?;
        request.source.native_session = self
            .0
            .native_evidence
            .resolve_native_session(AgentNativeEvidenceRequest {
                chat: request.source.clone(),
                signal: request.signal.clone(),
            })
            .await?;
        check_signal(Some(&request.signal))?;
        if request.provider_meta.is_none()
            && let Some(fork) = &self.0.fork_whole_session
            && let Some(session) = fork(request.clone()).await?
        {
            return Ok(AgentNativeForkOutcome::Materialized { session });
        }
        fork_jsonl_at_provider_point(&self.0, request).await
    }

    async fn discard(
        &self,
        session: AgentEstablishedSession,
        signal: CancellationToken,
        _options: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<()> {
        check_signal(Some(&signal))?;
        if let Some(path) = self
            .0
            .native_sessions
            .decode(session.native_session.as_ref())?
            .path
        {
            remove_fork_file(path).await?;
        }
        Ok(())
    }
}

async fn remove_fork_file(path: String) -> io::Result<()> {
    match fs::remove_file(path).await {
        Err(error) if has_node_error_code(ErrorInput::Error(&error), "ENOENT") => Ok(()),
        result => result,
    }
}

async fn fork_jsonl_at_provider_point(
    options: &JsonlNativeForkingOptions,
    request: AgentNativeForkRequest,
) -> ExecutorResult<AgentNativeForkOutcome> {
    let source = options
        .native_sessions
        .decode(request.source.native_session.as_ref())?;
    let source_agent_session_id = request
        .source
        .agent_session_id
        .clone()
        .or(source.agent_session_id)
        .filter(|id| !id.is_empty());
    let Some((source_agent_session_id, source_path)) =
        source_agent_session_id.clone().zip(source.path)
    else {
        if request.provider_meta.is_none()
            && options.allow_unmaterialized_whole_session
            && source_agent_session_id.is_none()
        {
            return Ok(AgentNativeForkOutcome::Unmaterialized);
        }
        return Err(transcript_unavailable("Source native transcript is unavailable").into());
    };
    let point = if request.provider_meta.is_some() {
        Some(resolve_provider_point(options, &request).await?)
    } else {
        None
    };
    let result = fork_jsonl_transcript(ForkJsonlRequest {
        source_path,
        source_agent_session_id,
        cutoff_line: point.map(|(line, _)| line as f64),
        allow_unmaterialized_whole_session: point.is_none()
            && options.allow_unmaterialized_whole_session,
        leading_line_count: None,
        retained_message_counts: point.into_iter().collect::<IndexMap<_, _>>(),
        rewrite_entry: options
            .create_rewrite_entry
            .as_ref()
            .and_then(|create| create())
            .or_else(|| options.rewrite_entry.clone()),
        transform_entries: options.transform_entries.clone(),
        create_target_path: options.create_target_path.clone(),
    })
    .await
    .map_err(|error| -> Box<dyn std::error::Error> {
        if error.is::<JsonlSourcePrefixChangedError>() {
            source_revision_changed().into()
        } else {
            error
        }
    })?;
    let ForkJsonlOutcome::Materialized {
        agent_session_id,
        native_path,
        expected_semantic_digest,
    } = result
    else {
        if request.provider_meta.is_some() {
            return Err("A message-point fork cannot remain unmaterialized".into());
        }
        return Ok(AgentNativeForkOutcome::Unmaterialized);
    };
    let outcome: ExecutorResult<_> = async {
        let native_session = options.native_sessions.encode(PathNativeSessionValue {
            path: Some(native_path.clone()),
            agent_session_id: Some(agent_session_id.clone()),
            model_endpoint_id: request
                .endpoint
                .map(|endpoint| endpoint.endpoint_id)
                .or(source.model_endpoint_id),
        });
        let mut forked_messages = Vec::new();
        if expected_semantic_digest.is_some() || request.source.native_seed_receipt.is_some() {
            let forked = options
                .native_evidence
                .load(AgentNativeEvidenceRequest {
                    chat: AgentChatReference {
                        chat_id: request.chat_id,
                        agent_id: request.source.agent_id,
                        agent_session_id: Some(agent_session_id.clone()),
                        project_path: request.project_path,
                        model: request.model,
                        native_session: native_session.clone(),
                        carry_over_revision: String::new(),
                        native_seed_receipt: None,
                        settings: request.settings,
                    },
                    signal: request.signal,
                })
                .await?;
            forked_messages = forked.messages.into_iter().map(|row| row.value).collect();
            if let Some(expected) = expected_semantic_digest {
                let actual = match &options.semantic_digest {
                    Some(digest) => Some(digest(&forked_messages).await?),
                    None => None,
                };
                if actual.as_ref() != Some(&expected) {
                    return Err(transcript_unavailable(
                        "The provider-native fork did not preserve its selected prefix",
                    )
                    .into());
                }
            }
        }
        let native_seed_receipt = retarget_native_seed_receipt_if_preserved(
            request.source.native_seed_receipt.as_ref(),
            &agent_session_id,
            &forked_messages,
        )?;
        Ok(AgentNativeForkOutcome::Materialized {
            session: AgentEstablishedSession {
                agent_session_id,
                native_session,
                native_seed_receipt,
            },
        })
    }
    .await;
    if outcome.is_err() {
        let _ = remove_fork_file(native_path).await;
    }
    outcome
}

async fn resolve_provider_point(
    options: &JsonlNativeForkingOptions,
    request: &AgentNativeForkRequest,
) -> ExecutorResult<(u64, u64)> {
    let expected = request
        .provider_meta
        .as_ref()
        .ok_or_else(missing_native_point)?;
    let native = options
        .native_evidence
        .load(AgentNativeEvidenceRequest {
            chat: request.source.clone(),
            signal: request.signal.clone(),
        })
        .await
        .map_err(|error| -> Box<dyn std::error::Error> {
            if has_node_error_code(ErrorInput::Error(error.as_ref()), "ENOENT")
                || error
                    .downcast_ref::<AgentIntegrationError>()
                    .is_some_and(|error| {
                        error.code == AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
                            && error
                                .details
                                .as_ref()
                                .and_then(|details| details.get("reason"))
                                .and_then(Value::as_str)
                                == Some("source-missing")
                    })
            {
                missing_native_source().into()
            } else {
                error
            }
        })?;
    for message in native.messages {
        let Some(source) = get_native_message_revision_source(&message) else {
            continue;
        };
        if !matches_provider_meta(&source, expected) {
            continue;
        }
        let Some(line) = source
            .line_number
            .map(|line| line.0)
            .filter(|&line| is_safe_integer(line) && line > 0.0)
        else {
            break;
        };
        return Ok((
            line as u64,
            source.within_source_ordinal.unwrap_or_default() + 1,
        ));
    }
    Err(missing_native_point().into())
}

fn matches_provider_meta(source: &NativeMessageSource, expected: &Opaque) -> bool {
    let mut compared = false;
    for key in ["entryId", "lineNumber", "byteOffset", "withinSourceOrdinal"] {
        let Some(value) = expected.get(key) else {
            continue;
        };
        compared = true;
        let matches = match key {
            "entryId" => value
                .as_str()
                .is_some_and(|expected| source.entry_id.as_deref() == Some(expected)),
            "lineNumber" => as_number(value)
                .is_some_and(|expected| source.line_number.is_some_and(|line| line.0 == expected)),
            "byteOffset" => as_number(value).is_some_and(|expected| {
                source
                    .byte_offset
                    .is_some_and(|offset| offset as f64 == expected)
            }),
            "withinSourceOrdinal" => as_number(value).is_some_and(|expected| {
                source
                    .within_source_ordinal
                    .is_some_and(|ordinal| ordinal as f64 == expected)
            }),
            _ => false,
        };
        if !matches {
            return false;
        }
    }
    compared
}

fn transcript_unavailable(message: &str) -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
        message,
        false,
        None,
    )
}

fn source_revision_changed() -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::SOURCE_REVISION_CHANGED,
        "Source transcript changed while the fork was being created",
        true,
        None,
    )
}

fn missing_native_source() -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
        "The source native transcript is unavailable",
        true,
        json!({ "nativeForkReason": "source-missing" })
            .as_object()
            .cloned(),
    )
}

pub fn missing_native_point() -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
        "The selected ledger row has no provider-native fork position",
        true,
        json!({ "nativeForkReason": "not-settled" })
            .as_object()
            .cloned(),
    )
}

#[cfg(test)]
mod tests;
