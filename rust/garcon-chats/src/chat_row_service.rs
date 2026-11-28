//! Ports `server/controller/chats/chat-row-service.ts`.

use std::{error::Error, rc::Rc};

use garcon_base::{
    KeyedLock,
    domain_error::{DomainError, TRANSCRIPT_UNAVAILABLE_MESSAGE},
    keyed_lock::LockAborted,
    log::Logger,
};
use garcon_contract::{
    chat_row_contracts::{
        AddChatRowRequest, AddChatRowResponse, AddChatRowStatus, ChatRowCommandType,
        ChatRowTargetResponse,
    },
    cli_presentation::is_cli_presentation,
    error_codes::ErrorCode,
};
use garcon_interface::resources::ExecutorResult;
use garcon_ledger::{
    contracts::{LedgerNoticeDetail, LedgerRowData, transcript_view_id},
    errors::{LedgerError, safe_fence_diagnostic},
    service::{AppendChatRowInput, TranscriptLedgerService},
    store::TranscriptReadSignal,
    view_reader::TranscriptViewAdoption,
};
use tokio_util::sync::CancellationToken;

use crate::{agent_ownership_journal::AgentOwnershipJournal, store::ChatRegistry};

pub struct ChatRowService {
    pub registry: Rc<ChatRegistry>,
    pub adoption: Rc<dyn TranscriptViewAdoption>,
    pub ledger: Rc<TranscriptLedgerService>,
    pub ownership_journal: Rc<AgentOwnershipJournal>,
    pub chat_mutation_lock: Rc<KeyedLock>,
    pub logger: Rc<dyn Logger>,
}

impl ChatRowService {
    pub async fn target(
        &self,
        chat_id: &str,
        signal: &CancellationToken,
    ) -> ExecutorResult<ChatRowTargetResponse> {
        self.require_chat(chat_id)?;
        let view = self
            .adoption
            .ensure(chat_id, Some(TranscriptReadSignal::new(signal)))
            .await
            .map_err(|error| self.map_transcript_error(error))?;
        Ok(ChatRowTargetResponse {
            success: true,
            chat_id: chat_id.into(),
            transcript_view_id: view.view_id.to_string(),
        })
    }

    pub async fn add(
        &self,
        input: AddChatRowRequest,
        signal: &CancellationToken,
    ) -> ExecutorResult<AddChatRowResponse> {
        let chat_id = input.chat_id.as_str();
        self.require_chat(chat_id)?;
        self.adoption
            .ensure(chat_id, Some(TranscriptReadSignal::new(signal)))
            .await
            .map_err(|error| self.map_transcript_error(error))?;
        self.chat_mutation_lock
            .run_exclusive(
                &format!("chat:{chat_id}"),
                || async {
                    self.require_chat(chat_id)?;
                    if self.ownership_journal.has_pending(chat_id) {
                        return Err(DomainError::new_ownership_transfer_pending().into());
                    }
                    if signal.is_cancelled() {
                        return Err(LockAborted.into());
                    }
                    let view_id = transcript_view_id(&input.transcript_view_id)?;
                    let result = self
                        .ledger
                        .append_chat_row(
                            chat_id,
                            AppendChatRowInput {
                                view_id: &view_id,
                                client_message_id: &input.client_message_id,
                                presentation: &input.presentation,
                                format: input.format,
                                disclosure: input.disclosure,
                                title: input.title.as_deref(),
                                content: &input.content,
                            },
                        )
                        .map_err(|error| self.map_transcript_error(error))?;
                    let LedgerRowData::Notice {
                        detail: LedgerNoticeDetail::CliRow(detail),
                        ..
                    } = result.row.data
                    else {
                        // INFALLIBLE: append_chat_row returns only the inserted or matching CLI notice.
                        unreachable!("non-CLI result of append_chat_row");
                    };
                    // INFALLIBLE: the ledger validates and normalizes the notice presentation.
                    let presentation = is_cli_presentation(detail.presentation.as_value())
                        .expect("validated CLI row presentation");
                    Ok(AddChatRowResponse {
                        success: true,
                        command_type: ChatRowCommandType::ChatRowAdd,
                        client_request_id: input.client_request_id,
                        client_message_id: input.client_message_id,
                        chat_id: chat_id.into(),
                        transcript_view_id: result.row.view_id.to_string(),
                        ordinal: result.row.ordinal,
                        presentation,
                        format: detail.format,
                        disclosure: detail.disclosure,
                        status: if result.inserted {
                            AddChatRowStatus::Appended
                        } else {
                            AddChatRowStatus::Duplicate
                        },
                        timestamp: result.row.at,
                    })
                },
                None,
            )
            .await?
    }

    fn require_chat(&self, chat_id: &str) -> ExecutorResult<()> {
        if !self.registry.has_chat(chat_id) {
            return Err(DomainError::new(
                ErrorCode::SESSION_NOT_FOUND,
                "Session not found",
                404,
                false,
            )
            .into());
        }
        Ok(())
    }

    fn map_transcript_error(&self, error: Box<dyn Error>) -> Box<dyn Error> {
        let mapped = match error.downcast_ref::<LedgerError>() {
            Some(LedgerError::StaleView { .. }) => DomainError::new(
                ErrorCode::STALE_TRANSCRIPT_VIEW,
                "The transcript changed before the row was added.",
                409,
                false,
            ),
            Some(LedgerError::SubmissionConflict { .. }) => DomainError::new(
                ErrorCode::IDEMPOTENCY_CONFLICT,
                "The row identity was already used for different content.",
                409,
                false,
            ),
            Some(LedgerError::Fenced { .. }) => {
                self.logger.warn(&format!(
                    "Chat row mutation encountered a fenced transcript ledger. {:?}",
                    safe_fence_diagnostic(error.as_ref()),
                ));
                DomainError::new(
                    ErrorCode::TRANSCRIPT_UNAVAILABLE,
                    TRANSCRIPT_UNAVAILABLE_MESSAGE,
                    422,
                    false,
                )
            }
            _ => return error,
        };
        mapped.with_cause(error).into()
    }
}

#[cfg(test)]
mod tests {
    use std::future::ready;

    use async_trait::async_trait;
    use futures::future::{FutureExt, LocalBoxFuture};
    use garcon_base::{domain_error::as_domain_error, log::create_logger};
    use garcon_contract::chat_row_contracts::parse_add_chat_row_request;
    use garcon_js::ManualClock;
    use garcon_ledger::{
        contracts::TranscriptView,
        service::TranscriptLedgerServiceOptions,
        store::{InitializeViewInput, TranscriptLedgerStore},
    };
    use serde_json::json;

    use super::*;
    use crate::agent_ownership_journal::{
        OwnershipAgent, OwnershipAgentDirectory, OwnershipLedger,
    };

    const CHAT: &str = "1000000000000001";

    struct ExistingFixtureView(TranscriptView);

    impl TranscriptViewAdoption for ExistingFixtureView {
        fn ensure<'a>(
            &'a self,
            chat_id: &'a str,
            _signal: Option<TranscriptReadSignal<'a>>,
        ) -> LocalBoxFuture<'a, ExecutorResult<TranscriptView>> {
            assert_eq!(chat_id, CHAT);
            ready(Ok(self.0.clone())).boxed_local()
        }
    }

    struct UnusedOwnershipPorts;

    impl OwnershipAgentDirectory for UnusedOwnershipPorts {
        fn get(&self, _: &str, _: Option<&str>) -> Option<OwnershipAgent> {
            panic!("appending a row must not reach an executor");
        }
    }

    #[async_trait(?Send)]
    impl OwnershipLedger for UnusedOwnershipPorts {
        async fn delete_chat(&self, _: &str) -> ExecutorResult<()> {
            panic!("appending a row must not delete its ledger");
        }
    }

    #[tokio::test]
    async fn duplicate_rows_reuse_the_durable_ordinal_and_stale_or_conflicting_writes_do_not_append()
     {
        tokio::task::LocalSet::new().run_until(async {
            let directory = tempfile::tempdir().unwrap();
            let session = json!({
                "agentId":"shell","agentOwnershipEpoch":"fixture-epoch","agentSettingsById":{},
                "projectPath":"/srv/seeded-project","carryOverSegments":[],"nativeSeedReceipt":null,
                "carryOverMigrationQuarantine":null,"parentChatId":null,"lineage":null,
            });
            std::fs::write(directory.path().join("chats.json"), json!({
                "version":6,"sessions":{(CHAT):session},
            }).to_string()).unwrap();
            let registry = ChatRegistry::open(directory.path()).await.unwrap();
            let store = Rc::new(TranscriptLedgerStore::new(
                &directory.path().join("transcript-ledgers").to_string_lossy(), Default::default(),
            ).unwrap());
            let current_view = store.initialize_current_view(CHAT, InitializeViewInput {
                view_id: Some(transcript_view_id("fixture-view").unwrap()),
                content_start_ordinal: 1, rows: &[],
            }).unwrap();
            let clock = Rc::new(ManualClock::new(1000));
            let service = ChatRowService {
                ownership_journal: AgentOwnershipJournal::open(
                    directory.path(), registry.clone(), Rc::new(UnusedOwnershipPorts),
                    Rc::new(UnusedOwnershipPorts), Rc::new(|_| true), Default::default(),
                ).await.unwrap(),
                registry,
                adoption: Rc::new(ExistingFixtureView(current_view)),
                ledger: Rc::new(TranscriptLedgerService::new(store.clone(), TranscriptLedgerServiceOptions {
                    clock: Some(clock.clone()), ..Default::default()
                })),
                chat_mutation_lock: Rc::default(),
                logger: Rc::new(create_logger("chat-row-test")),
            };
            let signal = CancellationToken::new();
            assert_eq!(service.target(CHAT, &signal).await.unwrap().transcript_view_id, "fixture-view");
            let input = parse_add_chat_row_request(&json!({
                "chatId":CHAT,"transcriptViewId":"fixture-view","clientRequestId":"first",
                "clientMessageId":"stable","presentation":{"style":"notice"},
                "format":"plain","disclosure":"expanded","content":"Synthetic row",
            })).unwrap();
            let first = service.add(input.clone(), &signal).await.unwrap();
            assert_eq!(first.status, AddChatRowStatus::Appended);
            assert_eq!(first.ordinal, 1);
            clock.advance(1000);
            let mut next = input.clone();
            next.client_request_id = "duplicate".into();
            let second = service.add(next.clone(), &signal).await.unwrap();
            assert_eq!(second.status, AddChatRowStatus::Duplicate);
            assert_eq!(second.client_request_id, "duplicate");
            assert_eq!(second.ordinal, first.ordinal);
            assert_eq!(second.timestamp, first.timestamp);
            next.content = "Different row".into();
            let conflict = service.add(next, &signal).await.unwrap_err();
            let conflict = as_domain_error(conflict.as_ref()).unwrap();
            assert_eq!(conflict.code, ErrorCode::IDEMPOTENCY_CONFLICT);
            assert_eq!(conflict.message, "The row identity was already used for different content.");
            let mut stale = input.clone();
            stale.transcript_view_id = "stale".into();
            let error = service.add(stale, &signal).await.unwrap_err();
            let stale = as_domain_error(error.as_ref()).unwrap();
            assert_eq!(stale.code, ErrorCode::STALE_TRANSCRIPT_VIEW);
            assert_eq!(stale.message, "The transcript changed before the row was added.");
            signal.cancel();
            let mut cancelled = input;
            cancelled.client_message_id = "would-append".into();
            assert!(service.add(cancelled, &signal).await.unwrap_err().is::<LockAborted>());
            assert_eq!(store.high_watermark(CHAT).unwrap().ordinal, 1);
        }).await;
    }
}
