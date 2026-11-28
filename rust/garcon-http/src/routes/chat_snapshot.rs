//! Ports `server/controller/routes/chat-snapshot.ts`.

use std::{error::Error, ops::Deref, rc::Rc};

use garcon_base::{
    domain_error::{DomainError, transcript_unavailable_message},
    errors::ErrorInput,
    executor_disconnect::as_agent_call_error,
    http_error::json_error_from_unknown,
    log::{Logger, create_logger},
};
use garcon_chats::{
    chat_list_projector::ChatListProjector,
    chat_message_reader::TranscriptPageReader,
    chat_snapshot::{ChatSnapshot, snapshot_transcript_view},
    chat_transient_feed::ChatTransientFeedStore,
};
use garcon_contract::{
    chat_id::{ChatId, parse_chat_id_input},
    chat_snapshot::{
        CHAT_SNAPSHOT_DEFAULT_MESSAGE_LIMIT, CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT,
        ChatSnapshotTranscript, UnavailableChatSnapshotTranscript,
    },
    chat_view::ChatHistoryState,
    error_codes::ErrorCode,
};
use garcon_execution::{
    control_state::to_client_chat_execution_control_state, types::ChatExecutionQueries,
};
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_js::{Clock, to_iso_string};
use garcon_ledger::view_reader::TranscriptHistoryUnavailableError;
use http::{HeaderValue, Method, StatusCode, header::CACHE_CONTROL};
use serde_json::Value;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
    compose_routes::RouteMap,
    http_route_types::{Route, RouteResult},
    json_route::json_response,
};

pub struct ChatSnapshotRoutes {
    pub summaries: Rc<ChatListProjector>,
    pub execution: Rc<dyn ChatExecutionQueries>,
    pub pages: Rc<dyn TranscriptPageReader>,
    pub feeds: Rc<ChatTransientFeedStore>,
    pub clock: Rc<dyn Clock>,
}

pub fn create_chat_snapshot_routes(deps: &Rc<ChatSnapshotRoutes>) -> RouteMap<Route> {
    let deps = Rc::clone(deps);
    let get = Route::new(Default::default(), move |_, url, _| {
        let deps = Rc::clone(&deps);
        async move {
            let mut reply = match parse_snapshot_query(&url) {
                Ok(query) => match deps.snapshot(&query).await {
                    Ok(reply) => Ok(reply),
                    Err(error) => {
                        create_logger("routes:chat-snapshot").error(&format!(
                            "snapshot failed for chat {}: {error}",
                            query.chat_id
                        ));
                        error_response(error.as_ref())
                    }
                },
                Err(error) => error_response(&error),
            }?;
            reply
                .headers_mut()
                .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
            Ok(reply)
        }
    });
    RouteMap::from([("/api/v1/chats/snapshot".into(), [(Method::GET, get)].into())])
}

impl ChatSnapshotRoutes {
    async fn snapshot(&self, query: &SnapshotQuery) -> RouteResult {
        let observed_at = to_iso_string(self.clock.now_ms())?;
        let Some(summary) = self.summaries.build_summary(&query.chat_id)? else {
            return error_response(&DomainError::new(
                ErrorCode::SESSION_NOT_FOUND,
                "Session not found",
                404,
                false,
            ));
        };
        let chat_id = query.chat_id.as_str();
        let control = self.execution.read_chat_execution_control(chat_id).await?;
        let control = to_client_chat_execution_control_state(&control);
        let transcript =
            read_snapshot_transcript(self.pages.as_ref(), chat_id, query.message_limit).await?;
        let view_id =
            snapshot_transcript_view(&transcript, &summary.chat.agent_ownership_epoch, || {
                self.feeds
                    .current_snapshot(chat_id)
                    .map(|feed| feed.transcript_view_id)
            });
        let feed = self.feeds.snapshot(chat_id, &view_id)?;
        Ok(json_response(
            StatusCode::OK,
            &ChatSnapshot::new(
                observed_at,
                query.message_limit,
                summary,
                control,
                feed,
                transcript,
            ),
        )?)
    }
}

fn error_response(error: &(dyn Error + 'static)) -> RouteResult {
    Ok(json_error_from_unknown(ErrorInput::Error(error), None, None, None)?.map(Some))
}

struct SnapshotQuery {
    chat_id: ChatId,
    message_limit: u64,
}

fn parse_snapshot_query(url: &Url) -> Result<SnapshotQuery, DomainError> {
    let query_value = |name| {
        url.query_pairs()
            .find_map(|(key, value)| (key == name).then_some(value))
    };
    let raw_chat_id = query_value("chatId").map(|id| Value::String(id.into_owned()));
    let chat_id = parse_chat_id_input(raw_chat_id.as_ref())
        .map_err(|_| DomainError::new_validation("chatId must be a canonical Garcon chat ID"))?;
    let message_limit = match query_value("limit") {
        None => CHAT_SNAPSHOT_DEFAULT_MESSAGE_LIMIT,
        Some(raw) => {
            let parsed = (!raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit()))
                .then(|| raw.parse::<u64>().ok())
                .flatten()
                .filter(|limit| *limit <= CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT);
            parsed.ok_or_else(|| {
                DomainError::new_validation(format!(
                    "limit must be an integer from 0 through {CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT}"
                ))
            })?
        }
    };
    Ok(SnapshotQuery {
        chat_id,
        message_limit,
    })
}

async fn read_snapshot_transcript(
    pages: &dyn TranscriptPageReader,
    chat_id: &str,
    limit: u64,
) -> Result<ChatSnapshotTranscript, Box<dyn Error>> {
    use ChatSnapshotTranscript::{Available, NotRequested, Unavailable};

    if limit == 0 {
        return Ok(NotRequested);
    }
    let request = CancellationToken::new();
    match pages.page(chat_id, limit, None, None, &request, None).await {
        Ok(page) => Ok(Available(page)),
        Err(error) => {
            if let Some(history) = error.downcast_ref::<TranscriptHistoryUnavailableError>()
                && let ChatHistoryState::Degraded {
                    error_code,
                    retryable,
                } = &history.history_state
            {
                return Ok(Unavailable(UnavailableChatSnapshotTranscript {
                    error_code: error_code.clone(),
                    retryable: *retryable,
                    message: history.to_string(),
                }));
            }
            if let Some(integration) = error
                .downcast_ref::<AgentIntegrationError>()
                .or_else(|| as_agent_call_error(error.as_ref()).map(Deref::deref))
                && integration.code == AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
            {
                return Ok(Unavailable(UnavailableChatSnapshotTranscript {
                    error_code: integration.code.as_str().into(),
                    retryable: integration.retryable,
                    message: transcript_unavailable_message(integration.retryable).into(),
                }));
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use garcon_chats::chat_list_projector::{ChatSummaryProjection, ProjectedChatSnapshot};
    use garcon_contract::{
        chat_activity::ChatActivityStatus,
        chat_modes::{PermissionMode, ThinkingMode},
        chat_snapshot::{ChatSnapshotActivity, ChatSnapshotChat},
        chat_types::{AssistantMessage, ChatMessage, ChatProcessingPhase},
        chat_view::{TranscriptMessage, TranscriptPage, TranscriptReadPurpose},
        queue_state::QueueEntryKind,
    };
    use garcon_execution::control_state::{
        StoredQueueEntry, StoredQueueEntryStatus, empty_stored_chat_execution_control,
    };
    use garcon_js::{Number, OptionalNullable};
    use std::{cell::RefCell, path::Path, process::Command};

    struct PageReply(RefCell<Option<Result<TranscriptPage, Box<dyn Error>>>>);

    #[async_trait(?Send)]
    impl TranscriptPageReader for PageReply {
        async fn page(
            &self,
            _: &str,
            _: u64,
            before_ordinal: Option<u64>,
            expected_view: Option<&str>,
            _: &CancellationToken,
            purpose: Option<TranscriptReadPurpose>,
        ) -> Result<TranscriptPage, Box<dyn Error>> {
            assert!(before_ordinal.is_none());
            assert!(expected_view.is_none());
            assert!(purpose.is_none());
            self.0.borrow_mut().take().expect("unexpected page read")
        }
    }

    #[tokio::test]
    async fn does_not_read_unrequested_history_and_keeps_snapshot_usable_if_history_is_degraded() {
        use ChatSnapshotTranscript::{NotRequested, Unavailable};
        let pages = PageReply(RefCell::new(None));
        assert_eq!(
            read_snapshot_transcript(&pages, "chat", 0).await.unwrap(),
            NotRequested
        );
        pages
            .0
            .replace(Some(Err(TranscriptHistoryUnavailableError::new(
                "LEDGER_FENCED",
                false,
                None,
            )
            .into())));
        assert_eq!(
            read_snapshot_transcript(&pages, "chat", 1).await.unwrap(),
            Unavailable(UnavailableChatSnapshotTranscript {
                error_code: "LEDGER_FENCED".into(),
                retryable: false,
                message: "The transcript ledger is unavailable".into(),
            })
        );
        pages.0.replace(Some(Err(
            DomainError::new_validation("other failure").into()
        )));
        assert_eq!(
            read_snapshot_transcript(&pages, "chat", 1)
                .await
                .unwrap_err()
                .to_string(),
            "other failure"
        );
    }

    fn parse(query: &str) -> Result<SnapshotQuery, DomainError> {
        parse_snapshot_query(
            &Url::parse(&format!("http://localhost/api/v1/chats/snapshot?{query}")).unwrap(),
        )
    }

    #[test]
    fn snapshot_reads_the_first_value_without_trimming_and_validates_id_before_limit() {
        let id = "1000000000000002";
        let query = parse(&format!("chatId={id}&chatId=bad&limit=000&limit=-1")).unwrap();
        assert_eq!(query.chat_id.as_str(), id);
        assert_eq!(query.message_limit, 0);
        assert_eq!(
            parse(&format!("chatId={id}")).unwrap().message_limit,
            CHAT_SNAPSHOT_DEFAULT_MESSAGE_LIMIT
        );
        assert_eq!(
            parse(&format!("chatId=%20{id}&limit=invalid"))
                .err()
                .unwrap()
                .message,
            "chatId must be a canonical Garcon chat ID"
        );
    }

    #[test]
    fn snapshot_limit_accepts_only_ascii_decimal_between_zero_and_maximum() {
        let id = "1000000000000002";
        for value in [
            "",
            "-0",
            "%200",
            "1e2",
            "2.0",
            "201",
            "\u{ff19}",
            "9007199254740992",
        ] {
            let error = parse(&format!("chatId={id}&limit={value}")).err().unwrap();
            assert_eq!(
                error.message, "limit must be an integer from 0 through 200",
                "{value}"
            );
        }
        assert_eq!(
            parse(&format!("chatId={id}&limit=200"))
                .unwrap()
                .message_limit,
            200
        );
    }

    #[test]
    fn snapshot_bytes_match_bun_across_availability_and_optional_executor_id() {
        let output = Command::new("bun")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/oracles/chat-snapshot.ts"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let original = String::from_utf8(output.stdout).unwrap();
        const AT: &str = "2001-09-09T01:46:40.000Z";
        const INSTANCE: &str = "fixture-instance";
        let mut chat = ChatSnapshotChat {
            id: garcon_contract::chat_id::chat_id_from_epoch_microseconds(1_000_000_000_000_002)
                .unwrap(),
            executor_id: OptionalNullable::ABSENT,
            title: "Synthetic title".into(),
            activity_status: Some(ChatActivityStatus::Working),
            agent_id: "shell".into(),
            agent_ownership_epoch: "fixture-epoch".into(),
            carry_over_revision: "carry-v1:0".into(),
            model: None,
            api_provider_id: None,
            model_endpoint_id: None,
            model_protocol: None,
            permission_mode: PermissionMode::Default,
            thinking_mode: ThinkingMode::None,
            project_path: "/srv/seeded-project".into(),
            tags: vec!["synthetic".into()],
            can_reload_from_native_history: false,
            activity: ChatSnapshotActivity {
                created_at: Some(AT.into()),
                last_activity_at: None,
            },
        };
        let mut control = empty_stored_chat_execution_control(INSTANCE);
        control.entries.push(StoredQueueEntry {
            id: "fixture-entry".into(),
            content: "Queued text".into(),
            kind: QueueEntryKind::Turn,
            revision: 1,
            created_at: AT.into(),
            updated_at: AT.into(),
            status: StoredQueueEntryStatus::Queued,
            images: vec![],
            submission: None,
        });
        let feeds = ChatTransientFeedStore::new(INSTANCE.into()).unwrap();
        let mut rust = String::new();
        for executor_id in [
            OptionalNullable::ABSENT,
            OptionalNullable::NULL,
            OptionalNullable::some("local".into()),
        ] {
            chat.executor_id = executor_id;
            for (limit, transcript) in [
                (0, ChatSnapshotTranscript::NotRequested),
                (
                    1,
                    ChatSnapshotTranscript::Available(TranscriptPage {
                        transcript_view_id: "fixture-view".into(),
                        messages: vec![TranscriptMessage {
                            ordinal: Number(1.0),
                            message: ChatMessage::Assistant(AssistantMessage {
                                timestamp: AT.into(),
                                content: "Synthetic transcript".into(),
                                questions: None,
                            }),
                        }],
                        last_ordinal: 1,
                        page_oldest_ordinal: 1,
                        page_newest_ordinal: 1,
                        next_before_ordinal: None,
                        has_more: false,
                    }),
                ),
                (
                    2,
                    ChatSnapshotTranscript::Unavailable(UnavailableChatSnapshotTranscript {
                        error_code: "LEDGER_FENCED".into(),
                        retryable: false,
                        message: "The transcript ledger is unavailable".into(),
                    }),
                ),
            ] {
                let view =
                    snapshot_transcript_view(&transcript, &chat.agent_ownership_epoch, || None);
                let snapshot = ChatSnapshot::new(
                    AT.into(),
                    limit,
                    ChatSummaryProjection {
                        chat: ProjectedChatSnapshot(chat.clone()),
                        processing_phase: Some(ChatProcessingPhase::Running),
                    },
                    to_client_chat_execution_control_state(&control),
                    feeds.snapshot(chat.id.as_str(), &view).unwrap(),
                    transcript,
                );
                rust.push_str(&serde_json::to_string(&snapshot).unwrap());
                rust.push('\n');
            }
        }
        assert_eq!(rust, original);
    }
}
