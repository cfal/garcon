//! Bounded ledger preview reads; they never adopt a chat or contact a provider.

use std::rc::Rc;

use futures::TryStreamExt;
use garcon_contract::{chat_id::ChatId, chat_types::*};
use garcon_ledger::{
    projection::{message_for_conversation_row, preview_messages},
    store::TranscriptLedgerStore,
};

use super::{
    AgentPreviewMetadata, BoxError, ExistingTranscriptPreview, MetadataIndex,
    MetadataTranscriptSource,
    preview::{text, timestamp},
};
use crate::registry_contracts::ChatRegistryEntry;

pub struct LedgerMetadataSource {
    store: Rc<TranscriptLedgerStore>,
}

impl LedgerMetadataSource {
    pub fn new(store: Rc<TranscriptLedgerStore>) -> Self {
        Self { store }
    }

    pub async fn replace_metadata(
        &self,
        metadata: &Rc<MetadataIndex>,
        chat_id: &ChatId,
        view_id: &str,
    ) -> Result<(), BoxError> {
        let watermark = self.store.high_watermark(chat_id)?;
        let pages = self
            .store
            .row_pages_through(chat_id, &watermark, 1, None)
            .map_ok(|rows| {
                rows.iter()
                    .filter_map(message_for_conversation_row)
                    .collect()
            });
        metadata
            .replace_from_transcript_view(chat_id, view_id, pages)
            .await?;
        Ok(())
    }
}

impl MetadataTranscriptSource for LedgerMetadataSource {
    fn existing_view_id(&self, chat_id: &ChatId) -> Result<Option<String>, BoxError> {
        Ok(self
            .store
            .existing_current_view(chat_id)?
            .map(|view| view.view_id.to_string()))
    }

    fn existing_preview(
        &self,
        session: &ChatRegistryEntry,
        chat_id: &ChatId,
    ) -> Result<Option<ExistingTranscriptPreview>, BoxError> {
        if session.agent_id.is_empty() {
            return Ok(None);
        }
        let Some(view) = self.store.existing_current_view(chat_id)? else {
            return Ok(None);
        };
        let edges = self.store.preview_edges(chat_id, &view.view_id)?;
        let preview = if let Some(messages) = preview_messages(&edges) {
            let date = |message: &ChatMessage| {
                let at = timestamp(message);
                (!at.is_empty()).then(|| at.to_owned())
            };
            AgentPreviewMetadata {
                first_message: match &messages.first {
                    ChatMessage::User(message) => message.content.clone(),
                    _ => String::new(),
                },
                last_message: Some(preview_message_text(&messages.last).into()),
                created_at: date(&messages.first),
                last_activity: date(&messages.last),
            }
        } else {
            let ordinal = self.store.high_watermark(chat_id)?.ordinal;
            if ordinal != 0
                && !(ordinal == 1
                    && self
                        .store
                        .current_session(chat_id)?
                        .is_some_and(|row| row.ordinal == 1))
            {
                // A bounded read without a candidate does not prove the view is empty.
                return Ok(None);
            }
            AgentPreviewMetadata {
                first_message: String::new(),
                last_message: Some(String::new()),
                created_at: None,
                last_activity: None,
            }
        };
        Ok(Some(ExistingTranscriptPreview {
            preview: Some(preview),
        }))
    }
}

fn preview_message_text(message: &ChatMessage) -> &str {
    // Unlike the live metadata fold, the registry preview uses any string
    // content and falls back to the message's wire type.
    match message {
        ChatMessage::User(_) | ChatMessage::Assistant(_) | ChatMessage::CommandOutput(_) => {
            text(message)
        }
        ChatMessage::CommandResult(message) => &message.content,
        ChatMessage::Thinking(message) => &message.content,
        ChatMessage::ToolUse(ToolUseChatMessage::Write {
            content: Some(content),
            ..
        }) => content,
        ChatMessage::ToolUse(message) => message.message_type(),
        ChatMessage::ToolResult(message) => {
            message.content.as_value().as_str().unwrap_or("tool-result")
        }
        ChatMessage::Error(message) => &message.content,
        ChatMessage::Notice(message) => &message.content,
        ChatMessage::CliRow(message) => &message.content,
        ChatMessage::PermissionRequest(_) => PermissionRequestMessage::TYPE,
        ChatMessage::PermissionResolved(_) => PermissionResolvedMessage::TYPE,
        ChatMessage::PermissionCancelled(_) => PermissionCancelledMessage::TYPE,
        ChatMessage::PermissionExpired(_) => PermissionExpiredMessage::TYPE,
        ChatMessage::Compaction(_) => CompactionMessage::TYPE,
        ChatMessage::AgentSwitch(_) => AgentSwitchMessage::TYPE,
    }
}

#[cfg(test)]
mod tests {
    use std::{path::Path, process::Command};

    use garcon_contract::chat_id::parse_chat_id;
    use garcon_interface::producer::AgentEstablishedSession;
    use garcon_ledger::{
        contracts::{LedgerRowData, LedgerRowDraft, TranscriptView},
        store::InitializeViewInput,
    };
    use serde_json::json;

    use super::*;
    use crate::{registry_entry_codec::normalize_chat_registry_entry, store::ChatRegistry};

    const CHAT: &str = "1783725900000200";
    const AT: &str = "2026-08-15T00:00:00.000Z";
    const OTHER_AT: &str = "2026-08-15T00:01:00.000Z";

    struct Fixture {
        source: LedgerMetadataSource,
        entry: ChatRegistryEntry,
        id: ChatId,
    }

    impl Fixture {
        fn new(root: &std::path::Path) -> Self {
            let entry = json!({
                "agentId":"shell","agentOwnershipEpoch":"preview-fixture",
                "agentSettingsById":{},"projectPath":"/repo","carryOverSegments":[],
                "nativeSeedReceipt":null,"carryOverMigrationQuarantine":null,
                "parentChatId":null,"lineage":null
            });
            Self {
                source: LedgerMetadataSource::new(Rc::new(
                    TranscriptLedgerStore::new(&root.to_string_lossy(), Default::default())
                        .unwrap(),
                )),
                entry: normalize_chat_registry_entry(entry.as_object().unwrap(), CHAT).unwrap(),
                id: parse_chat_id(&json!(CHAT)).unwrap(),
            }
        }

        fn initialize(&self) -> TranscriptView {
            self.source
                .store
                .initialize_current_view(
                    &self.id,
                    InitializeViewInput {
                        view_id: None,
                        content_start_ordinal: 1,
                        rows: &[],
                    },
                )
                .unwrap()
        }

        fn append(&self, view: &TranscriptView, data: LedgerRowData) {
            self.source
                .store
                .append(
                    &self.id,
                    &view.view_id,
                    &[LedgerRowDraft {
                        at: AT.into(),
                        provider_meta: None,
                        data,
                    }],
                )
                .unwrap();
        }

        fn preview(&self) -> Option<AgentPreviewMetadata> {
            self.source
                .existing_preview(&self.entry, &self.id)
                .unwrap()
                .and_then(|value| value.preview)
        }
    }

    #[test]
    fn does_not_materialize_an_unadopted_ledger_to_resolve_its_preview() {
        let root = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(root.path());
        assert!(
            fixture
                .source
                .existing_view_id(&fixture.id)
                .unwrap()
                .is_none()
        );
        assert!(fixture.preview().is_none());
        assert!(!root.path().join(CHAT).exists());
    }

    #[test]
    fn distinguishes_empty_and_session_only_from_an_omitted_oversized_preview() {
        let root = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(root.path());
        let view = fixture.initialize();
        let assert_empty = || {
            let preview = fixture.preview().unwrap();
            assert_eq!(preview.first_message, "");
            assert_eq!(preview.last_message.as_deref(), Some(""));
            assert_eq!(preview.created_at, None);
            assert_eq!(preview.last_activity, None);
        };
        assert_empty();
        fixture.append(
            &view,
            LedgerRowData::Session {
                detail: AgentEstablishedSession {
                    agent_session_id: "synthetic-session".into(),
                    native_session: None,
                    native_seed_receipt: None,
                },
            },
        );
        assert_empty();
        fixture.append(
            &view,
            LedgerRowData::ProviderRow {
                message: ChatMessage::User(UserMessage {
                    timestamp: AT.into(),
                    content: "x".repeat(80 * 1024),
                    images: None,
                    metadata: None,
                    presentation: None,
                }),
            },
        );
        assert!(fixture.preview().is_none());
        assert_eq!(
            fixture
                .source
                .existing_view_id(&fixture.id)
                .unwrap()
                .as_deref(),
            Some(view.view_id.as_str())
        );
    }

    #[test]
    fn preserves_assistant_only_title_and_uses_the_last_conversation_rows_content_or_type() {
        let root = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(root.path());
        let view = fixture.initialize();
        fixture.append(
            &view,
            LedgerRowData::ProviderRow {
                message: ChatMessage::Assistant(AssistantMessage {
                    timestamp: AT.into(),
                    content: "Stored conversation".into(),
                    questions: None,
                }),
            },
        );
        let first = fixture.preview().unwrap();
        fixture.append(
            &view,
            LedgerRowData::ProviderRow {
                message: ChatMessage::Thinking(ThinkingMessage {
                    timestamp: OTHER_AT.into(),
                    content: "Synthetic reasoning".into(),
                }),
            },
        );
        let reasoning = fixture.preview().unwrap();
        fixture.append(
            &view,
            LedgerRowData::ProviderRow {
                message: ChatMessage::ToolUse(ToolUseChatMessage::Bash {
                    timestamp: OTHER_AT.into(),
                    tool_id: "tool".into(),
                    command: "pwd".into(),
                    description: None,
                }),
            },
        );
        let wire = [first, reasoning, fixture.preview().unwrap()].map(|preview| {
            json!({
                "preview":{
                    "firstMessage": preview.first_message, "lastMessage": preview.last_message,
                    "createdAt": preview.created_at, "lastActivity": preview.last_activity,
                }
            })
        });
        let bun = Command::new("bun")
            .arg(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("tests/oracles/ledger-metadata-preview.ts"),
            )
            .arg(root.path().join("original"))
            .output()
            .unwrap();
        assert!(
            bun.status.success(),
            "{}",
            String::from_utf8_lossy(&bun.stderr)
        );
        assert_eq!(
            serde_json::to_string(&wire).unwrap(),
            String::from_utf8(bun.stdout).unwrap().trim_end()
        );
    }

    #[tokio::test]
    async fn replacement_metadata_folds_the_whole_view_and_keeps_the_view_identity() {
        let root = tempfile::tempdir().unwrap();
        let fixture = Fixture::new(root.path());
        std::fs::write(
            root.path().join("chats.json"),
            json!({"version":6,"sessions":{CHAT:&fixture.entry}}).to_string(),
        )
        .unwrap();
        let registry = ChatRegistry::open(root.path()).await.unwrap();
        let source = Rc::new(fixture.source);
        let index = MetadataIndex::open(registry, source.clone(), Default::default()).await;
        let mut drafts: Vec<_> = (0..450)
            .map(|number| LedgerRowDraft {
                at: AT.into(),
                provider_meta: None,
                data: LedgerRowData::ProviderRow {
                    message: ChatMessage::Assistant(AssistantMessage {
                        timestamp: AT.into(),
                        content: format!("Synthetic reply {number}"),
                        questions: None,
                    }),
                },
            })
            .collect();
        drafts[1].data = LedgerRowData::ProviderRow {
            message: ChatMessage::User(UserMessage {
                timestamp: AT.into(),
                content: "Synthetic first input".into(),
                images: None,
                metadata: None,
                presentation: None,
            }),
        };
        let view = source
            .store
            .initialize_current_view(
                &fixture.id,
                InitializeViewInput {
                    view_id: None,
                    content_start_ordinal: 1,
                    rows: &drafts,
                },
            )
            .unwrap();
        source
            .replace_metadata(&index, &fixture.id, "stale-view")
            .await
            .unwrap();
        assert!(index.get_chat_metadata(&fixture.id).is_none());
        source
            .replace_metadata(&index, &fixture.id, view.view_id.as_str())
            .await
            .unwrap();
        let entry = index.get_chat_metadata(&fixture.id).unwrap();
        assert_eq!(
            entry.transcript_view_id.as_deref(),
            Some(view.view_id.as_str())
        );
        assert_eq!(entry.first_message, "Synthetic first input");
        assert_eq!(entry.last_message, "Synthetic reply 449");
    }
}
