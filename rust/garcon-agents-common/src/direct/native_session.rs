//! Ports `server-agents/common/src/direct/native-session.ts`.

use std::error::Error;
use std::future::Future;

use async_trait::async_trait;
use futures::{StreamExt, TryStreamExt, stream};
use garcon_base::errors::{NamedError, error_metadata};
use garcon_contract::chat_message_coercion::ChatImage;
use garcon_contract::chat_types::{AssistantMessage, ChatMessage, UserMessage};
use garcon_contract::file_mention_context::strip_resolved_file_mention_context;
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::native_history::{
    AgentHistoryImport, AgentHistoryImportRequest, AgentHistoryStream, AgentImportedTranscriptRow,
    AgentNativeSessionAccess, AgentNativeSessionReleaseRequest,
};
use garcon_interface::resources::{AgentInstanceCallOptions, ExecutorResult};
use garcon_interface::transcript::{AgentNativeSessionRef, AgentTranscriptSourceLocation};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::execution::admission::check_signal;

use super::session_store::{DirectSessionRecordV1, DirectSessionSnapshot, DirectSessionStore};

const IMPORT_BATCH_SIZE: usize = 256;
const TRANSCRIPT_UNAVAILABLE_MESSAGE: &str =
    "This conversation cannot be loaded because its Direct history is unavailable.";

pub struct DirectNativeSessions(pub DirectSessionStore);

#[async_trait(?Send)]
impl AgentNativeSessionAccess for DirectNativeSessions {
    async fn resolve_native_session(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        check_signal(Some(&request.signal))?;
        let chat = request.chat;
        if chat.agent_session_id.as_deref().is_none_or(str::is_empty)
            && chat.native_session.is_none()
        {
            return Ok(None);
        }
        let id = required_session_id(
            &self.0,
            chat.agent_session_id.as_deref(),
            chat.native_session.as_ref(),
        )?;
        run_required_session_operation(self.0.inspect(id), &request.signal).await?;
        self.0.native_reference(id).map(Some)
    }

    async fn describe_source(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>> {
        check_signal(Some(&request.signal))?;
        let chat = request.chat;
        if chat.agent_session_id.as_deref().is_none_or(str::is_empty)
            && chat.native_session.is_none()
        {
            return Ok(None);
        }
        let id = required_session_id(
            &self.0,
            chat.agent_session_id.as_deref(),
            chat.native_session.as_ref(),
        )?;
        let path = run_required_session_operation(self.0.inspect(id), &request.signal).await?;
        Ok(Some(AgentTranscriptSourceLocation::FilesystemPath {
            value: path,
        }))
    }

    async fn release(&self, release: AgentNativeSessionReleaseRequest) -> ExecutorResult<()> {
        let request = release.request;
        check_signal(Some(&request.signal))?;
        let Some(native_session) = &request.chat.native_session else {
            return Ok(());
        };
        let id = required_session_id(
            &self.0,
            request.chat.agent_session_id.as_deref(),
            Some(native_session),
        )?;
        self.0
            .delete(id)
            .await
            .map_err(|error| direct_session_unavailable(Some(error.as_ref())))?;
        check_signal(Some(&request.signal))
    }
}

impl AgentHistoryImport for DirectNativeSessions {
    fn load(
        &self,
        request: AgentHistoryImportRequest,
        _options: Option<AgentInstanceCallOptions>,
    ) -> AgentHistoryStream<'_> {
        stream::once(async move {
            let signal = request.signal;
            check_signal(Some(&signal))?;
            let id = required_session_id(
                &self.0,
                request.chat.agent_session_id.as_deref(),
                request.chat.native_session.as_ref(),
            )?;
            let snapshot = run_required_session_operation(self.0.load(id), &signal).await?;
            Ok::<_, Box<dyn Error>>(stream::try_unfold(
                (snapshot.records.into_iter(), signal),
                |(mut records, signal)| async move {
                    let mut rows = Vec::new();
                    for record in records.by_ref().take(IMPORT_BATCH_SIZE) {
                        check_signal(Some(&signal))?;
                        rows.push(AgentImportedTranscriptRow {
                            message: imported_message(record),
                            provider_meta: None,
                        });
                    }
                    Ok((!rows.is_empty()).then_some((rows, (records, signal))))
                },
            ))
        })
        .try_flatten()
        .boxed_local()
    }
}

pub async fn load_direct_session_required(
    sessions: &DirectSessionStore,
    agent_session_id: &str,
    native_session: Option<&AgentNativeSessionRef>,
    signal: &CancellationToken,
) -> ExecutorResult<DirectSessionSnapshot> {
    check_signal(Some(signal))?;
    let id = sessions
        .session_id_from_reference(native_session, Some(agent_session_id))
        .map_err(|error| direct_session_unavailable(Some(error.as_ref())))?;
    run_required_session_operation(sessions.load(id), signal).await
}

fn required_session_id<'a>(
    sessions: &DirectSessionStore,
    agent_session_id: Option<&str>,
    native_session: Option<&'a AgentNativeSessionRef>,
) -> ExecutorResult<&'a str> {
    let Some(agent_session_id) = agent_session_id.filter(|id| !id.is_empty()) else {
        return Err(direct_session_unavailable(None).into());
    };
    if native_session.is_none() {
        return Err(direct_session_unavailable(None).into());
    }
    sessions
        .session_id_from_reference(native_session, Some(agent_session_id))
        .map_err(|error| direct_session_unavailable(Some(error.as_ref())).into())
}

async fn run_required_session_operation<T>(
    operation: impl Future<Output = ExecutorResult<T>>,
    signal: &CancellationToken,
) -> ExecutorResult<T> {
    let result = operation.await;
    check_signal(Some(signal))?;
    result.map_err(|error| {
        if error
            .downcast_ref::<NamedError>()
            .is_some_and(|error| error.name == "AbortError")
        {
            return error;
        }
        direct_session_unavailable(Some(error.as_ref())).into()
    })
}

fn imported_message(record: DirectSessionRecordV1) -> ChatMessage {
    match record {
        DirectSessionRecordV1::Assistant(record) => ChatMessage::Assistant(AssistantMessage {
            timestamp: record.at,
            content: record.content,
            questions: None,
        }),
        DirectSessionRecordV1::User(record) => ChatMessage::User(UserMessage {
            timestamp: record.at,
            content: strip_resolved_file_mention_context(&record.content).to_owned(),
            images: (!record.attachments.is_empty()).then(|| {
                record
                    .attachments
                    .into_iter()
                    .map(|attachment| ChatImage {
                        data: attachment.data,
                        name: attachment.name.unwrap_or_default(),
                        mime_type: Some(attachment.mime_type),
                    })
                    .collect()
            }),
            metadata: None,
            presentation: None,
        }),
    }
}

pub fn direct_session_unavailable(cause: Option<&(dyn Error + 'static)>) -> AgentIntegrationError {
    let details = cause.map(|error| {
        let metadata = error_metadata(error);
        Map::from_iter([
            ("causeName".into(), Value::from(metadata.name)),
            (
                "causeCode".into(),
                Value::from(metadata.code.unwrap_or("INVALID_HISTORY")),
            ),
        ])
    });
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
        TRANSCRIPT_UNAVAILABLE_MESSAGE,
        false,
        details,
    )
}
