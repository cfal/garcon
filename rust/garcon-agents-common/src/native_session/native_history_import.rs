//! Ports `server-agents/common/src/native-session/native-history-import.ts`.

use std::error::Error;

use futures::{StreamExt, TryStreamExt, stream};
use garcon_contract::chat_types::ChatMessage;
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::native_history::{
    AgentHistoryImport, AgentHistoryImportRequest, AgentHistoryStream, AgentImportedTranscriptRow,
};
use garcon_interface::native_message_source::NativeSourced;
use garcon_interface::resources::{AgentInstanceCallOptions, ExecutorResult};

use super::evidence_source::AgentNativeEvidenceSnapshot;
use super::provider_metadata::provider_metadata;

// Bounds each batch's conversion here and downstream, and lets reload report
// progress while it reads, instead of handing over a whole history at once.
const IMPORT_BATCH_ROWS: usize = 256;

pub struct HistoryImport<S> {
    source: S,
}

pub struct NativeHistoryImport<S> {
    importer: HistoryImport<S>,
}

pub fn create_history_import<S>(source: S) -> HistoryImport<S>
where
    S: AsyncFn(AgentHistoryImportRequest) -> ExecutorResult<AgentNativeEvidenceSnapshot>,
{
    HistoryImport { source }
}

pub fn create_native_history_import<S>(source: S) -> NativeHistoryImport<S>
where
    S: AsyncFn(AgentHistoryImportRequest) -> ExecutorResult<AgentNativeEvidenceSnapshot>,
{
    NativeHistoryImport {
        importer: create_history_import(source),
    }
}

impl<S> AgentHistoryImport for HistoryImport<S>
where
    S: AsyncFn(AgentHistoryImportRequest) -> ExecutorResult<AgentNativeEvidenceSnapshot>,
{
    fn load(
        &self,
        request: AgentHistoryImportRequest,
        _options: Option<AgentInstanceCallOptions>,
    ) -> AgentHistoryStream<'_> {
        stream::once(async move {
            let AgentNativeEvidenceSnapshot { messages } = (self.source)(request).await?;
            let mut messages = messages.into_iter();
            Ok::<_, Box<dyn Error>>(stream::iter(std::iter::from_fn(move || {
                let batch: Vec<_> = messages
                    .by_ref()
                    .take(IMPORT_BATCH_ROWS)
                    .map(imported_row)
                    .collect();
                (!batch.is_empty()).then_some(Ok(batch))
            })))
        })
        .try_flatten()
        .boxed_local()
    }
}

impl<S> AgentHistoryImport for NativeHistoryImport<S>
where
    S: AsyncFn(AgentHistoryImportRequest) -> ExecutorResult<AgentNativeEvidenceSnapshot>,
{
    fn load(
        &self,
        request: AgentHistoryImportRequest,
        options: Option<AgentInstanceCallOptions>,
    ) -> AgentHistoryStream<'_> {
        stream::once(async move {
            if request
                .chat
                .agent_session_id
                .as_deref()
                .is_none_or(str::is_empty)
                && request.chat.native_session.is_none()
            {
                return Err(AgentIntegrationError::new(
                    AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
                    "Native history import requires a selected session",
                    false,
                    None,
                )
                .into());
            }
            Ok::<_, Box<dyn Error>>(self.importer.load(request, options))
        })
        .try_flatten()
        .boxed_local()
    }
}

fn imported_row(message: NativeSourced<ChatMessage>) -> AgentImportedTranscriptRow {
    let provider_meta = provider_metadata(&message);
    AgentImportedTranscriptRow {
        message: message.value,
        provider_meta,
    }
}

#[cfg(test)]
mod tests {
    use garcon_contract::chat_types::AssistantMessage;
    use garcon_interface::native_message_source::{
        NativeMessageSourceInput, attach_native_message_source,
    };
    use garcon_interface::resources::ExecutorResult;
    use garcon_interface::transcript::{AgentChatReference, AgentNativeSessionRef};
    use garcon_js::json::Opaque;
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;

    const TIMESTAMP: &str = "2026-08-12T00:00:00.000Z";

    fn request(agent_session_id: Option<&str>) -> AgentHistoryImportRequest {
        AgentHistoryImportRequest {
            chat: AgentChatReference {
                chat_id: "chat-1".to_owned(),
                agent_id: "test".to_owned(),
                agent_session_id: agent_session_id.map(str::to_owned),
                project_path: "/tmp/project".to_owned(),
                model: "model".to_owned(),
                native_session: agent_session_id.map(|agent_session_id| AgentNativeSessionRef {
                    owner_id: "test".to_owned(),
                    schema_version: 1,
                    value: Opaque::from_value(json!({ "agentSessionId": agent_session_id })),
                }),
                carry_over_revision: "revision".to_owned(),
                native_seed_receipt: None,
                settings: garcon_contract::agent_integration::AgentSettingsEnvelope {
                    owner_id: "test".to_owned(),
                    schema_version: 1,
                    values: Opaque::from_value(json!({})),
                },
            },
            signal: CancellationToken::new(),
        }
    }

    fn answer(text: &str) -> NativeSourced<ChatMessage> {
        NativeSourced::new(ChatMessage::Assistant(AssistantMessage {
            timestamp: TIMESTAMP.to_owned(),
            content: text.to_owned(),
            questions: None,
        }))
    }

    async fn import_rows(
        importer: &impl AgentHistoryImport,
        agent_session_id: Option<&str>,
        mut on_batch: impl FnMut(usize),
    ) -> ExecutorResult<Vec<AgentImportedTranscriptRow>> {
        let mut rows = Vec::new();
        let mut batches = importer.load(request(agent_session_id), None);
        while let Some(batch) = batches.try_next().await? {
            on_batch(batch.len());
            rows.extend(batch);
        }
        Ok(rows)
    }

    #[tokio::test]
    async fn translates_native_evidence_into_import_batches_with_provider_metadata() {
        let mut message = answer("answer");
        attach_native_message_source(
            &mut message,
            Some(NativeMessageSourceInput {
                entry_id: Some("native-1"),
                ..Default::default()
            }),
        );
        let importer = create_native_history_import(async |_| {
            Ok(AgentNativeEvidenceSnapshot {
                messages: vec![message.clone()],
            })
        });

        let rows = import_rows(&importer, Some("session-1"), |_| {})
            .await
            .unwrap();

        assert_eq!(
            rows,
            [AgentImportedTranscriptRow {
                message: message.value,
                provider_meta: Some(Opaque::from_value(json!({ "entryId": "native-1" }))),
            }]
        );
    }

    // [TLV5-ADOPT.08-NATIVE-WRAPPER-UNIT-01] in the original.
    #[tokio::test]
    async fn preserves_valid_empty_and_selected_source_failure_outcomes() {
        let unavailable = AgentIntegrationError::new(
            AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
            "selected native session is unavailable",
            false,
            None,
        );
        let importer = create_native_history_import(async |request| {
            if request.chat.agent_session_id.as_deref() == Some("missing-session") {
                return Err(unavailable.clone().into());
            }
            Ok(AgentNativeEvidenceSnapshot::default())
        });

        assert_eq!(
            import_rows(&importer, Some("empty-session"), |_| {})
                .await
                .unwrap(),
            []
        );
        let error = import_rows(&importer, Some("missing-session"), |_| {})
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<AgentIntegrationError>(),
            Some(&unavailable)
        );
    }

    #[tokio::test]
    async fn refuses_a_chat_without_a_selected_session() {
        let importer = create_native_history_import(async |_| {
            panic!("evidence must not be read without a selected session")
        });

        let error = import_rows(&importer, None, |_| {}).await.unwrap_err();
        let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
        assert_eq!(
            error.code,
            AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
        );
        assert_eq!(
            error.message,
            "Native history import requires a selected session"
        );
        assert!(!error.retryable);
        // An empty session id with no native session is no selection either.
        let mut request = request(Some(""));
        request.chat.native_session = None;
        assert!(importer.load(request, None).try_next().await.is_err());
    }

    #[tokio::test]
    async fn accepts_a_native_reference_without_a_legacy_session_id() {
        let importer = create_native_history_import(async |request| {
            assert!(request.chat.agent_session_id.is_none());
            assert!(request.chat.native_session.is_some());
            Ok(AgentNativeEvidenceSnapshot::default())
        });
        let mut request = request(Some("session-1"));
        request.chat.agent_session_id = None;
        assert!(
            importer
                .load(request, None)
                .try_next()
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn yields_a_long_history_in_bounded_batches_in_order() {
        let messages: Vec<_> = (0..600)
            .map(|index| answer(&format!("answer {index}")))
            .collect();
        let importer = create_history_import(async |request| {
            assert!(request.chat.agent_session_id.is_none());
            Ok(AgentNativeEvidenceSnapshot {
                messages: messages.clone(),
            })
        });
        let mut batch_sizes = Vec::new();

        let rows = import_rows(&importer, None, |size| batch_sizes.push(size))
            .await
            .unwrap();

        assert_eq!(batch_sizes, [256, 256, 88]);
        assert_eq!(
            rows.iter().map(|row| &row.message).collect::<Vec<_>>(),
            messages
                .iter()
                .map(|message| &message.value)
                .collect::<Vec<_>>()
        );
        assert!(rows.iter().all(|row| row.provider_meta.is_none()));
    }
}
