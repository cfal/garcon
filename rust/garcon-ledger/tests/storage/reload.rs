use std::{
    cell::{Cell, RefCell},
    future::ready,
    path::Path,
    process::Command,
    rc::Rc,
};

use futures::{future::LocalBoxFuture, stream};
use garcon_base::{
    domain_error::as_domain_error, keyed_lock::KeyedLock, log::create_logger,
    unhandled_rejection_policy::install_unhandled_rejection_policy,
};
use garcon_contract::{
    agent_integration::AgentSettingsEnvelope,
    chat_types::{AssistantMessage, ChatMessage, UserMessage},
    error_codes::ErrorCode,
    preamble_prefix::create_preamble_prefix,
    preambles::PendingPreambleBoundary,
    transcript_seed::{NativeSeedPlacement, NativeSeedReceiptInput, create_native_seed_receipt},
    ws_events::ChatReloadProgress,
};
use garcon_interface::{
    native_history::{
        AgentHistoryImport, AgentHistoryImportRequest, AgentHistoryStream,
        AgentImportedTranscriptRow,
    },
    producer::AgentEstablishedSession,
    resources::AgentInstanceCallOptions,
    transcript::AgentNativeSessionRef,
    versioned_settings::VersionedSettings,
};
use garcon_js::{clock::ManualClock, json::from_slice};
use garcon_ledger::{
    adoption::{RegisteredTranscriptChat, TranscriptSessionCache},
    contracts::{
        LedgerNoticeDetail, LedgerRowData, LedgerRowDraft, LedgerUserInputDetail, RunOrigin,
        RunOutcome, transcript_view_id,
    },
    reload::{
        NativeHistoryIntegration, ReloadChatEntry, TranscriptReloadIntegrations,
        TranscriptReloadOptions, TranscriptReloadRegistry, TranscriptReloadService,
        TranscriptReloadServiceOptions,
    },
    service::{TranscriptLedgerService, TranscriptLedgerServiceOptions},
    sqlite_operations::LedgerResult,
    store::{InitializeViewInput, TranscriptLedgerStore},
};
use serde_json::{Value, json};
use tokio::task::LocalSet;

use super::clear::{AdoptExisting, Execution, snapshot, store};

const CHAT: &str = "1795856400000000";
const SOURCE: &str = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT: &str = "22222222-2222-4222-8222-222222222222";
const AT: &str = "2026-11-28T09:00:00.000Z";
const SESSION: &str = "synthetic-session";
const CARRIED: &str = "<carried-context>Synthetic earlier context</carried-context>\n";

fn preamble() -> garcon_contract::preamble_prefix::PreamblePrefixApplication {
    create_preamble_prefix(&["Synthetic private preamble \u{1f680}"])
        .unwrap()
        .unwrap()
}

fn boundary() -> PendingPreambleBoundary {
    PendingPreambleBoundary::NewChat {
        ownership_epoch: "owner-1".into(),
    }
}

fn session() -> AgentEstablishedSession {
    AgentEstablishedSession {
        agent_session_id: SESSION.into(),
        native_session: Some(AgentNativeSessionRef {
            owner_id: "shell".into(),
            schema_version: 1,
            value: json!({"nativeId": "synthetic"}).into(),
        }),
        native_seed_receipt: Some(
            create_native_seed_receipt(NativeSeedReceiptInput {
                agent_session_id: SESSION,
                placement: NativeSeedPlacement::UserPrefix,
                prefix: CARRIED,
                format: None,
            })
            .unwrap(),
        ),
    }
}

fn user(content: String) -> UserMessage {
    UserMessage {
        timestamp: AT.into(),
        content,
        images: None,
        metadata: None,
        presentation: None,
    }
}

fn assistant(content: &str) -> ChatMessage {
    ChatMessage::Assistant(AssistantMessage {
        timestamp: AT.into(),
        content: content.into(),
        questions: None,
    })
}

fn initial_rows() -> Vec<LedgerRowDraft> {
    let notice = |message: &str, detail: Value| LedgerRowData::Notice {
        message: message.into(),
        detail: LedgerNoticeDetail::Other(detail.into()),
    };
    vec![
        LedgerRowData::ProviderRow {
            message: assistant("Frozen answer"),
        },
        notice(
            "Synthetic quarantine",
            json!({"type": "carryover-migration-quarantine",
            "artifactId": "artifact-1", "errorCode": "CARRYOVER_PARSE_FAILED"}),
        ),
        LedgerRowData::Session { detail: session() },
        notice(
            "Preambles applied",
            json!({"type": "preamble-application", "preambles": [
                {"id": "3502b645-222b-49d2-ac39-1c91f9fb1174", "title": "Synthetic rules"}
            ]}),
        ),
        LedgerRowData::UserInput {
            detail: LedgerUserInputDetail {
                client_message_id: Some("input-1".into()),
                message: user("Old input".into()),
                attachments: vec![],
                steer: false,
                preamble_boundary: Some(boundary()),
                preamble_prefix_receipt: Some(preamble().receipt),
            },
        },
        LedgerRowData::RunEnded {
            outcome: RunOutcome::Finished,
            origin: RunOrigin::Provider,
            error: None,
        },
    ]
    .into_iter()
    .map(|data| LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data,
    })
    .collect()
}

struct Registry {
    pending: RefCell<Option<PendingPreambleBoundary>>,
    flushes: Cell<usize>,
}

impl TranscriptReloadRegistry<()> for Registry {
    fn get_chat(&self, id: &str) -> Option<ReloadChatEntry<()>> {
        (id == CHAT).then(|| ReloadChatEntry {
            transcript: RegisteredTranscriptChat {
                agent_id: "shell".into(),
                executor_id: Some("synthetic-executor".into()),
                ownership_epoch: "owner-1".into(),
                project_path: "/synthetic".into(),
                model: "synthetic".into(),
                settings_by_agent: Default::default(),
                session: TranscriptSessionCache {
                    agent_session_id: Some("stale-registry-cache".into()),
                    ..Default::default()
                },
                carryover: (),
                quarantine: None,
            },
            pending_preamble_boundary: self.pending.borrow().clone(),
        })
    }

    fn clear_pending_preamble_boundary(
        &self,
        id: &str,
    ) -> LedgerResult<Option<ReloadChatEntry<()>>> {
        self.pending.take();
        Ok(self.get_chat(id))
    }

    fn flush(&self) -> LocalBoxFuture<'_, LedgerResult<()>> {
        self.flushes.set(self.flushes.get() + 1);
        Box::pin(ready(Ok(())))
    }
}

#[derive(Clone, Copy, Default)]
enum NativeFixture {
    #[default]
    Complete,
    MissingTurn,
    WrongPreamble,
    WrongCarriedContext,
}

#[derive(Default)]
struct History(Cell<NativeFixture>);

impl AgentHistoryImport for History {
    fn load(
        &self,
        request: AgentHistoryImportRequest,
        _: Option<AgentInstanceCallOptions>,
    ) -> AgentHistoryStream<'_> {
        assert_eq!(request.chat.agent_session_id.as_deref(), Some(SESSION));
        assert_eq!(request.chat.native_session, session().native_session);
        assert_eq!(
            request.chat.native_seed_receipt,
            session().native_seed_receipt
        );
        assert_eq!(request.chat.carry_over_revision, "synthetic-revision");
        let first = match self.0.get() {
            NativeFixture::Complete => format!("{CARRIED}{}Visible question", preamble().prefix),
            NativeFixture::MissingTurn => return Box::pin(stream::empty()),
            NativeFixture::WrongPreamble => {
                format!("{CARRIED}<garcon-preambles version=\"2\">\nVisible question")
            }
            NativeFixture::WrongCarriedContext => {
                "<carried-context>Unexpected context</carried-context>\n".into()
            }
        };
        Box::pin(stream::iter([
            Ok(vec![AgentImportedTranscriptRow {
                message: ChatMessage::User(user(first)),
                provider_meta: Some(json!({"event": 1}).into()),
            }]),
            Ok(vec![AgentImportedTranscriptRow {
                message: assistant("Visible answer"),
                provider_meta: Some(json!({"event": 2}).into()),
            }]),
        ]))
    }
}

struct Integrations(Rc<History>);

impl TranscriptReloadIntegrations for Integrations {
    fn require(
        &self,
        agent: &str,
        executor: Option<&str>,
    ) -> LedgerResult<NativeHistoryIntegration> {
        assert_eq!((agent, executor), ("shell", Some("synthetic-executor")));
        Ok(NativeHistoryIntegration {
            agent_id: agent.into(),
            settings: Rc::new(VersionedSettings::new(
                AgentSettingsEnvelope {
                    owner_id: agent.into(),
                    schema_version: 1,
                    values: json!({}).into(),
                },
                vec![],
                None,
            )),
            native_history_import: Some(self.0.clone()),
        })
    }
}

struct Fixture {
    store: Rc<TranscriptLedgerStore>,
    reload: Rc<TranscriptReloadService<()>>,
    registry: Rc<Registry>,
    history: Rc<History>,
    execution: Rc<Execution>,
    reopened: Rc<Cell<usize>>,
}

fn fixture(path: &Path, replacement: &str) -> Fixture {
    let store = store(path, replacement);
    store
        .initialize_current_view(
            CHAT,
            InitializeViewInput {
                view_id: Some(transcript_view_id(SOURCE).unwrap()),
                content_start_ordinal: 3,
                rows: &initial_rows(),
            },
        )
        .unwrap();
    let ledger = Rc::new(TranscriptLedgerService::new(
        store.clone(),
        TranscriptLedgerServiceOptions::default(),
    ));
    let registry = Rc::new(Registry {
        pending: RefCell::new(Some(boundary())),
        flushes: Cell::new(0),
    });
    let history = Rc::new(History::default());
    let execution = Rc::new(Execution::default());
    let reopened = Rc::new(Cell::new(0));
    let count = reopened.clone();
    let reload = Rc::new(TranscriptReloadService::new(
        TranscriptReloadServiceOptions {
            ledger: ledger.clone(),
            adoption: Rc::new(AdoptExisting(store.clone())),
            registry: registry.clone(),
            integrations: Rc::new(Integrations(history.clone())),
            execution: execution.clone(),
            reopen_producer: Rc::new(move |id| {
                count.set(count.get() + 1);
                let _ = ledger.open_producer(id, "shell")?;
                Ok(())
            }),
            carryover_revision: Rc::new(|_, _| "synthetic-revision".into()),
            chat_mutation_lock: Rc::new(KeyedLock::new()),
            unhandled_rejections: Rc::new(install_unhandled_rejection_policy(Rc::new(
                create_logger("reload:test"),
            ))),
            clock: Some(Rc::new(ManualClock::new(1_795_856_400_000))),
        },
    ));
    Fixture {
        store,
        reload,
        registry,
        history,
        execution,
        reopened,
    }
}

fn bun(root: &Path, mode: &str) -> Value {
    let out = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/reload-oracle.ts"
        ))
        .arg(mode)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    from_slice(&out.stdout).unwrap()
}

#[tokio::test]
async fn tlv5_l10_02_reload_preserves_the_frozen_prefix_and_matches_bun_bytes_in_both_directions() {
    LocalSet::new()
        .run_until(async {
            let original = tempfile::tempdir().unwrap();
            let expected = bun(original.path(), "write");
            let replacement = expected["replacement"]["viewId"].as_str().unwrap();
            let original_read = snapshot(&store(original.path(), replacement)).await;
            assert_eq!(
                original_read,
                serde_json::to_string(&expected["snapshot"]).unwrap()
            );
            let dir = tempfile::tempdir().unwrap();
            let f = fixture(dir.path(), replacement);
            let progress = Rc::new(RefCell::new(Vec::<ChatReloadProgress>::new()));
            let log = progress.clone();
            let result = f
                .reload
                .reload(
                    CHAT,
                    TranscriptReloadOptions {
                        on_progress: Some(Rc::new(move |update| {
                            log.borrow_mut().push(update);
                            Ok(())
                        })),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                expected["replacement"]
            );
            assert_eq!(
                serde_json::to_value(progress.borrow().as_slice()).unwrap(),
                expected["progress"]
            );
            assert!(f.registry.pending.borrow().is_none());
            assert_eq!(
                (
                    f.registry.flushes.get(),
                    f.reopened.get(),
                    f.execution.released.get()
                ),
                (1, 1, 1)
            );
            assert_eq!(snapshot(&f.store).await, original_read);
            assert_eq!(bun(dir.path(), "read")["snapshot"], expected["snapshot"]);
            assert!(!original_read.contains("Synthetic earlier context"));
            assert!(!original_read.contains("Synthetic private preamble"));
            assert!(original_read.contains("Visible question"));
        })
        .await;
}

#[tokio::test]
async fn reload_preserves_the_view_on_mismatched_envelopes_and_when_native_history_has_not_caught_up()
 {
    LocalSet::new()
        .run_until(async {
            let dir = tempfile::tempdir().unwrap();
            let f = fixture(dir.path(), REPLACEMENT);
            for (mode, code, status, retryable) in [
                (
                    NativeFixture::MissingTurn,
                    ErrorCode::HISTORY_LOAD_FAILED,
                    409,
                    true,
                ),
                (
                    NativeFixture::WrongPreamble,
                    ErrorCode::PREAMBLE_ENVELOPE_MISMATCH,
                    422,
                    false,
                ),
                (
                    NativeFixture::WrongCarriedContext,
                    ErrorCode::CONTEXT_ENVELOPE_MISMATCH,
                    422,
                    false,
                ),
            ] {
                f.history.0.set(mode);
                let error = f
                    .reload
                    .reload(CHAT, TranscriptReloadOptions::default())
                    .await
                    .unwrap_err();
                let error = as_domain_error(error.as_ref()).unwrap();
                assert_eq!(
                    (error.code, error.status, error.retryable),
                    (code, status, retryable)
                );
                let head = f.store.high_watermark(CHAT).unwrap();
                assert_eq!((head.view_id.as_str(), head.ordinal), (SOURCE, 6));
            }
            f.history.0.set(NativeFixture::Complete);
            assert_eq!(
                f.reload
                    .reload(CHAT, TranscriptReloadOptions::default())
                    .await
                    .unwrap()
                    .view_id
                    .as_str(),
                REPLACEMENT
            );
            assert_eq!((f.reopened.get(), f.execution.released.get()), (4, 4));
        })
        .await;
}
