use std::{
    cell::{Cell, RefCell},
    future::ready,
    path::Path,
    process::Command,
    rc::Rc,
};

use futures::{future::LocalBoxFuture, stream};
use garcon_base::errors::NamedError;
use garcon_contract::{
    agent_integration::AgentSettingsEnvelope,
    chat_types::{ChatMessage, parse_chat_message},
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    native_history::{
        AgentHistoryImport, AgentHistoryImportRequest, AgentHistoryStream,
        AgentImportedTranscriptRow,
    },
    resources::AgentInstanceCallOptions,
    versioned_settings::VersionedSettings,
};
use garcon_js::clock::ManualClock;
use garcon_ledger::{
    adoption::{
        CarryoverQuarantine, LegacyHistoryIntegration, RegisteredTranscriptChat,
        TranscriptAdoptionIntegrations, TranscriptAdoptionOptions, TranscriptAdoptionRegistry,
        TranscriptAdoptionService, TranscriptFrozenHistory, TranscriptSessionCache,
    },
    contracts::transcript_view_id,
    sqlite_operations::LedgerResult,
    store::{TranscriptLedgerStore, TranscriptLedgerStoreOptions},
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

const CHAT: &str = "1795856400000000";
const VIEW: &str = "adoption-view";
const AT: &str = "2026-11-28T09:00:00.000Z";

struct Registry {
    entry: RefCell<RegisteredTranscriptChat<()>>,
    repairs: Cell<u32>,
}

impl TranscriptAdoptionRegistry<()> for Registry {
    fn get_chat(&self, chat_id: &str) -> Option<RegisteredTranscriptChat<()>> {
        matches!(chat_id, CHAT | "unrelated").then(|| self.entry.borrow().clone())
    }

    fn update_session_cache(&self, _: &str, cache: TranscriptSessionCache) -> LedgerResult<()> {
        self.entry.borrow_mut().session = cache;
        self.repairs.set(self.repairs.get() + 1);
        Ok(())
    }
}

#[derive(Default)]
struct History {
    unavailable: Cell<bool>,
    empty: Cell<bool>,
    calls: Cell<u32>,
}

impl AgentHistoryImport for History {
    fn load(
        &self,
        request: AgentHistoryImportRequest,
        _options: Option<AgentInstanceCallOptions>,
    ) -> AgentHistoryStream<'_> {
        assert_eq!(
            request.chat.agent_session_id.as_deref(),
            Some("session-one")
        );
        assert_eq!(request.chat.carry_over_revision, "synthetic-revision");
        self.calls.set(self.calls.get() + 1);
        if self.empty.get() {
            return Box::pin(stream::empty());
        }
        let tail = if self.unavailable.get() {
            Err(NamedError {
                name: "IOError".into(),
                message: "PRIVATE transcript text".into(),
                code: Some("EIO".into()),
            }
            .into())
        } else {
            Ok(vec![
                imported(
                    "assistant-message",
                    "<garcon-get-chat-id />\nSynthetic answer.",
                    None,
                ),
                imported(
                    "user-message",
                    "<garcon-chat-id>1795856400000000</garcon-chat-id>",
                    None,
                ),
            ])
        };
        Box::pin(stream::iter([
            Ok(vec![imported(
                "user-message",
                "Imported question",
                Some(json!({"event": 1})),
            )]),
            tail,
        ]))
    }
}

fn imported(kind: &str, content: &str, meta: Option<Value>) -> AgentImportedTranscriptRow {
    AgentImportedTranscriptRow {
        message: message(json!({"type": kind, "timestamp": AT, "content": content})),
        provider_meta: meta.map(Into::into),
    }
}

fn message(input: Value) -> ChatMessage {
    parse_chat_message(&input).unwrap().unwrap()
}

struct Integrations {
    history: Rc<History>,
    forbid: bool,
    null_import: Cell<bool>,
}

impl TranscriptAdoptionIntegrations for Integrations {
    fn require(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> LedgerResult<LegacyHistoryIntegration> {
        assert!(
            !self.forbid,
            "existing view must not consult an integration"
        );
        assert_eq!((agent_id, executor_id), ("synthetic", Some("executor-one")));
        Ok(LegacyHistoryIntegration {
            agent_id: agent_id.into(),
            settings: Rc::new(VersionedSettings::new(
                AgentSettingsEnvelope {
                    owner_id: agent_id.into(),
                    schema_version: 1,
                    values: json!({}).into(),
                },
                Vec::new(),
                None,
            )),
            importer: (!self.null_import.get())
                .then(|| self.history.clone() as Rc<dyn AgentHistoryImport>),
        })
    }
}

#[derive(Default)]
struct Frozen {
    calls: Cell<u32>,
    unavailable: Cell<bool>,
    replacement: RefCell<Option<Rc<Registry>>>,
}

impl TranscriptFrozenHistory<()> for Frozen {
    fn revision(&self, _: &(), _: Option<&CarryoverQuarantine>) -> String {
        "synthetic-revision".into()
    }

    fn load_all(
        &self,
        _: &(),
        _: CancellationToken,
    ) -> LocalBoxFuture<'_, LedgerResult<Vec<ChatMessage>>> {
        self.calls.set(self.calls.get() + 1);
        if let Some(registry) = self.replacement.take() {
            registry.entry.borrow_mut().ownership_epoch = "new-owner".into();
        }
        Box::pin(async {
            tokio::task::yield_now().await;
            if self.unavailable.get() {
                return Err(Box::<dyn std::error::Error>::from("PRIVATE frozen text"));
            }
            Ok(vec![
                message(
                    json!({"type":"user-message","timestamp":AT,"content":"Frozen question","metadata":{"upstreamRequestId":"frozen-input"}}),
                ),
                message(
                    json!({"type":"agent-switch","timestamp":AT,"fromAgentId":"previous","toAgentId":"synthetic","fromModel":"modelA","toModel":"modelB"}),
                ),
            ])
        })
    }
}

struct Fixture {
    store: Rc<TranscriptLedgerStore>,
    registry: Rc<Registry>,
    integrations: Rc<Integrations>,
    frozen: Rc<Frozen>,
    adoption: TranscriptAdoptionService<()>,
    adopted: Rc<Cell<u32>>,
}

fn fixture(root: &Path, read: bool) -> Fixture {
    let store = Rc::new(
        TranscriptLedgerStore::new(
            root.to_str().unwrap(),
            TranscriptLedgerStoreOptions {
                create_view_id: Some(Rc::new(|| transcript_view_id(VIEW).unwrap())),
                now: Some(Rc::new(|| Ok(AT.into()))),
                ..Default::default()
            },
        )
        .unwrap(),
    );
    let registry = Rc::new(Registry {
        entry: RefCell::new(RegisteredTranscriptChat {
            agent_id: "synthetic".into(),
            executor_id: Some("executor-one".into()),
            ownership_epoch: "owner-1".into(),
            project_path: root.to_string_lossy().into_owned(),
            model: "modelB".into(),
            settings_by_agent: Default::default(),
            session: TranscriptSessionCache {
                agent_session_id: Some(if read { "old-cache" } else { "session-one" }.into()),
                ..Default::default()
            },
            carryover: (),
            quarantine: None,
        }),
        repairs: Cell::default(),
    });
    let integrations = Rc::new(Integrations {
        history: Rc::new(History::default()),
        forbid: read,
        null_import: Cell::default(),
    });
    let frozen = Rc::new(Frozen::default());
    let adopted = Rc::new(Cell::new(0));
    let adoption = TranscriptAdoptionService::new(TranscriptAdoptionOptions {
        store: store.clone(),
        registry: registry.clone(),
        integrations: integrations.clone(),
        frozen_history: frozen.clone(),
        on_adopted: Some(Rc::new({
            let adopted = adopted.clone();
            move |_| {
                adopted.set(adopted.get() + 1);
                Ok(())
            }
        })),
        logger: None,
        clock: Some(Rc::new(ManualClock::new(1_795_856_400_000))),
    });
    Fixture {
        store,
        registry,
        integrations,
        frozen,
        adoption,
        adopted,
    }
}

fn bun(root: &Path, mode: &str) -> String {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/adoption-oracle.ts"
        ))
        .arg(mode)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim_end().into()
}

async fn native(root: &Path, read: bool) -> String {
    let f = fixture(root, read);
    let (first, second) =
        tokio::join!(f.adoption.ensure(CHAT, None), f.adoption.ensure(CHAT, None));
    let view = first.unwrap();
    assert_eq!(view, second.unwrap());
    assert_eq!(view.content_start_ordinal, 3);
    assert_eq!(f.frozen.calls.get(), u32::from(!read));
    assert_eq!(f.integrations.history.calls.get(), u32::from(!read));
    assert_eq!(f.adopted.get(), u32::from(!read));
    assert_eq!(f.registry.repairs.get(), u32::from(read));
    let head = f.store.high_watermark(CHAT).unwrap();
    let stored = f
        .store
        .with_stored_rows_through(CHAT, &head, |rows| ready(Ok(rows)), None)
        .await
        .unwrap();
    assert_eq!(stored.len(), 7);
    f.store.close().unwrap();
    let session = f.registry.entry.borrow().session.agent_session_id.clone();
    serde_json::to_string(&json!({ "view": view, "stored": stored, "session": session })).unwrap()
}

// TLV5-ADOPT.03, TLV5-ADOPT.09, TLV5-CHAT-ID-DISCOVERY.03
#[tokio::test]
async fn tlv5_adopt_03_genesis_order_and_existing_cache_repair_match_between_runtimes() {
    let original = tempfile::tempdir().unwrap();
    let expected = bun(original.path(), "write");
    assert_eq!(native(original.path(), true).await, expected);
    let port = tempfile::tempdir().unwrap();
    assert_eq!(native(port.path(), false).await, expected);
    assert_eq!(bun(port.path(), "read"), expected);
}

// TLV5-ADOPT.01, TLV5-ADOPT.02, TLV5-ADOPT.04, TLV5-ADOPT.10
#[tokio::test]
async fn tlv5_adopt_02_04_10_a_failed_source_is_retryable_and_quarantine_skips_the_prefix() {
    let root = tempfile::tempdir().unwrap();
    let f = fixture(root.path(), false);
    f.integrations.history.unavailable.set(true);
    let error = f.adoption.ensure(CHAT, None).await.unwrap_err();
    let error = error.downcast::<AgentIntegrationError>().unwrap();
    assert_eq!(
        error.code,
        AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
    );
    assert_eq!(error.to_string(), "Transcript adoption source failed");
    assert!(error.retryable);
    assert!(error.details.as_ref().is_some_and(
        |detail| **detail == json!({"provider": "synthetic", "phase": "legacy-history-import"})
    ));
    assert!(f.store.existing_current_view(CHAT).unwrap().is_none());
    assert_eq!(f.adopted.get(), 0);
    f.integrations.null_import.set(true);
    assert_eq!(
        f.adoption
            .ensure("unrelated", None)
            .await
            .unwrap()
            .content_start_ordinal,
        3
    );
    f.integrations.null_import.set(false);
    f.integrations.history.unavailable.set(false);
    f.registry.entry.borrow_mut().quarantine = Some(CarryoverQuarantine {
        artifact_id: "artifact-1".into(),
        error_code: "CARRYOVER_PARSE_FAILED".into(),
    });
    let view = f.adoption.ensure(CHAT, None).await.unwrap();
    assert_eq!(view.content_start_ordinal, 2);
    assert_eq!(f.frozen.calls.get(), 2);
    assert_eq!(f.integrations.history.calls.get(), 2);
    let rows = f.store.current_rows(CHAT).unwrap();
    assert_eq!(rows[0].data.kind(), "notice");
    assert_eq!(rows[1].data.kind(), "session");
    assert_eq!(rows[2].data.kind(), "user-input");
}

#[tokio::test]
async fn tlv5_adopt_01_empty_sources_and_unbound_chats_do_not_need_native_history() {
    let root = tempfile::tempdir().unwrap();
    let f = fixture(root.path(), false);
    f.frozen.unavailable.set(true);
    let error = f.adoption.ensure(CHAT, None).await.unwrap_err();
    let error = error.downcast::<AgentIntegrationError>().unwrap();
    assert_eq!(error.to_string(), "Transcript adoption source failed");
    assert!(error.details.as_ref().is_some_and(
        |detail| **detail == json!({"provider": "synthetic", "phase": "frozen-prefix"})
    ));
    assert!(f.store.existing_current_view(CHAT).unwrap().is_none());
    assert_eq!(f.integrations.history.calls.get(), 0);
    f.frozen.unavailable.set(false);
    f.integrations.history.empty.set(true);
    assert_eq!(
        f.adoption
            .ensure(CHAT, None)
            .await
            .unwrap()
            .content_start_ordinal,
        3
    );
    assert_eq!(f.store.current_rows(CHAT).unwrap().len(), 3);
    assert_eq!(f.integrations.history.calls.get(), 1);
    f.registry.entry.borrow_mut().session = TranscriptSessionCache::default();
    assert_eq!(
        f.adoption
            .ensure("unrelated", None)
            .await
            .unwrap()
            .content_start_ordinal,
        3
    );
    assert_eq!(f.store.current_rows("unrelated").unwrap().len(), 2);
    assert_eq!(f.integrations.history.calls.get(), 1);
}

#[tokio::test]
async fn genesis_rechecks_ownership_before_creating_a_view() {
    let root = tempfile::tempdir().unwrap();
    let f = fixture(root.path(), false);
    f.frozen.replacement.replace(Some(f.registry.clone()));
    let error = f.adoption.ensure(CHAT, None).await.unwrap_err();
    assert_eq!(
        error.to_string(),
        format!("Chat ownership changed while adopting {CHAT}")
    );
    assert!(f.store.existing_current_view(CHAT).unwrap().is_none());
    assert_eq!(f.adopted.get(), 0);
    assert!(f.adoption.ensure(CHAT, None).await.is_ok());
}
