use std::{
    cell::{Cell, RefCell},
    future::ready,
    path::Path,
    process::Command,
    rc::Rc,
};

use futures::future::LocalBoxFuture;
use garcon_base::{
    domain_error::as_domain_error, keyed_lock::KeyedLock, log::create_logger,
    unhandled_rejection_policy::install_unhandled_rejection_policy,
};
use garcon_contract::{
    chat_clear::{ClearChatRequest, ClearChatResponse, ClearChatTarget},
    chat_id::parse_chat_id,
    error_codes::ErrorCode,
    preambles::PendingPreambleBoundary,
};
use garcon_js::{
    Number,
    json::{from_slice, stringify},
};
use garcon_ledger::{
    clear::{
        ClearChatEntry, PromoteClearedView, TranscriptClearExecution, TranscriptClearOptions,
        TranscriptClearRegistry, TranscriptClearService,
    },
    codec::{StoredLedgerRow, decode_ledger_row},
    contracts::{LedgerRowDraft, TranscriptView, transcript_view_id},
    preamble_history::collect_preamble_history_evidence,
    service::{TranscriptLedgerService, TranscriptLedgerServiceOptions},
    sqlite_operations::LedgerResult,
    store::{
        InitializeViewInput, TranscriptLedgerStore, TranscriptLedgerStoreOptions,
        TranscriptReadSignal,
    },
    view_mutation::{ReleaseTranscriptSnapshot, TranscriptMutationExecution},
    view_reader::TranscriptViewAdoption,
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{sync::oneshot, task::LocalSet};
use tokio_util::sync::CancellationToken;

const CHAT: &str = "1795856400000000";
const AT: &str = "2026-11-28T09:00:00.000Z";
const SOURCE: &str = "11111111-1111-4111-8111-111111111111";
const REPLACEMENT: &str = "22222222-2222-4222-8222-222222222222";

fn drafts() -> Vec<LedgerRowDraft> {
    include_str!("../inputs/clear-rows.jsonl")
        .lines()
        .enumerate()
        .map(|(index, line)| {
            let spec: Value = from_slice(line.as_bytes()).unwrap();
            let row = decode_ledger_row(&StoredLedgerRow {
                view_id: SOURCE.into(),
                ordinal: Number((index + 1) as f64),
                kind: spec[0].as_str().unwrap().into(),
                at: AT.into(),
                client_message_id: spec[2].as_str().map(str::to_owned),
                payload_json: stringify(&json!({ "providerMeta": null, "value": spec[1] })),
            })
            .unwrap();
            LedgerRowDraft {
                at: row.at,
                provider_meta: row.provider_meta,
                data: row.data,
            }
        })
        .collect()
}

struct AdoptExisting(Rc<TranscriptLedgerStore>);

impl TranscriptViewAdoption for AdoptExisting {
    fn ensure<'a>(
        &'a self,
        chat_id: &'a str,
        _: Option<TranscriptReadSignal<'a>>,
    ) -> LocalBoxFuture<'a, LedgerResult<TranscriptView>> {
        Box::pin(ready(Ok(self.0.current_view(chat_id).unwrap().unwrap())))
    }
}

type FlushHook = Box<dyn FnOnce() -> LocalBoxFuture<'static, LedgerResult<()>>>;
type PromotionHook = Box<dyn FnOnce()>;

#[derive(Default)]
struct Registry {
    pending: RefCell<Option<PendingPreambleBoundary>>,
    flushes: Cell<usize>,
    flush_hook: RefCell<Option<FlushHook>>,
}

impl TranscriptClearRegistry for Registry {
    fn get_chat(&self, id: &str) -> Option<ClearChatEntry> {
        (id == CHAT).then(|| ClearChatEntry {
            agent_id: "shell".into(),
            executor_id: Some("synthetic-executor".into()),
            pending_preamble_boundary: self.pending.borrow().clone(),
        })
    }

    fn clear_pending_preamble_boundary(&self, _: &str) -> LedgerResult<()> {
        self.pending.take();
        Ok(())
    }

    fn flush(&self) -> LocalBoxFuture<'_, LedgerResult<()>> {
        self.flushes.set(self.flushes.get() + 1);
        self.flush_hook.take().map_or_else(
            || Box::pin(ready(Ok(()))) as LocalBoxFuture<'_, _>,
            |hook| hook(),
        )
    }
}

#[derive(Default)]
struct Execution {
    reserved: Cell<usize>,
    released: Rc<Cell<usize>>,
    pending: Cell<bool>,
    release_fails: Rc<Cell<bool>>,
    at_promotion: RefCell<Option<PromotionHook>>,
}

impl TranscriptMutationExecution for Execution {
    fn reserve_transcript_snapshot(&self, _: &str) -> LedgerResult<ReleaseTranscriptSnapshot> {
        self.reserved.set(self.reserved.get() + 1);
        let released = self.released.clone();
        let fail = self.release_fails.clone();
        Ok(Box::new(move || {
            Box::pin(async move {
                released.set(released.get() + 1);
                if fail.get() {
                    return Err("synthetic release failure".into());
                }
                Ok(())
            })
        }))
    }

    fn has_pending_turn_input<'a>(&'a self, _: &'a str) -> LocalBoxFuture<'a, LedgerResult<bool>> {
        Box::pin(ready(Ok(self.pending.get())))
    }
}

impl TranscriptClearExecution for Execution {
    fn with_chat_execution_control<'a>(
        &'a self,
        _: &'a str,
        promote: PromoteClearedView<'a>,
    ) -> LocalBoxFuture<'a, LedgerResult<ClearChatResponse>> {
        if let Some(before) = self.at_promotion.take() {
            before();
        }
        Box::pin(ready(promote(self.pending.get())))
    }
}

struct Fixture {
    store: Rc<TranscriptLedgerStore>,
    registry: Rc<Registry>,
    execution: Rc<Execution>,
    clear: Rc<TranscriptClearService>,
    reopened: Rc<Cell<usize>>,
    transferring: Rc<Cell<bool>>,
    mutation_lock: Rc<KeyedLock>,
}

fn store(root: &Path, replacement: &str) -> Rc<TranscriptLedgerStore> {
    let replacement = transcript_view_id(replacement).unwrap();
    Rc::new(
        TranscriptLedgerStore::new(
            root.to_str().unwrap(),
            TranscriptLedgerStoreOptions {
                now: Some(Rc::new(|| Ok(AT.into()))),
                create_view_id: Some(Rc::new(move || replacement.clone())),
                ..Default::default()
            },
        )
        .unwrap(),
    )
}

fn fixture(root: &Path) -> Fixture {
    fixture_with_replacement(root, REPLACEMENT)
}

fn fixture_with_replacement(root: &Path, replacement: &str) -> Fixture {
    let store = store(root, replacement);
    store
        .initialize_current_view(
            CHAT,
            InitializeViewInput {
                view_id: Some(transcript_view_id(SOURCE).unwrap()),
                content_start_ordinal: 1,
                rows: &drafts(),
            },
        )
        .unwrap();
    let ledger = Rc::new(TranscriptLedgerService::new(
        store.clone(),
        TranscriptLedgerServiceOptions::default(),
    ));
    let registry = Rc::new(Registry {
        pending: RefCell::new(Some(PendingPreambleBoundary::NewChat {
            ownership_epoch: "owner-1".into(),
        })),
        ..Default::default()
    });
    let execution = Rc::new(Execution::default());
    let reopened = Rc::new(Cell::new(0));
    let count = reopened.clone();
    let transferring = Rc::new(Cell::new(false));
    let pending = transferring.clone();
    let mutation_lock = Rc::new(KeyedLock::new());
    let clear = Rc::new(TranscriptClearService::new(TranscriptClearOptions {
        ledger: ledger.clone(),
        registry: registry.clone(),
        adoption: Rc::new(AdoptExisting(store.clone())),
        ownership_transfer_pending: Rc::new(move |_| pending.get()),
        supports_literal_execution: Rc::new(|agent, executor| {
            agent == "shell" && executor == Some("synthetic-executor")
        }),
        execution: execution.clone(),
        reopen_producer: Rc::new(move |id| {
            count.set(count.get() + 1);
            let _ = ledger.open_producer(id, "shell")?;
            Ok(())
        }),
        chat_mutation_lock: mutation_lock.clone(),
        unhandled_rejections: Rc::new(install_unhandled_rejection_policy(Rc::new(create_logger(
            "clear:test",
        )))),
    }));
    Fixture {
        store,
        registry,
        execution,
        clear,
        reopened,
        transferring,
        mutation_lock,
    }
}

fn request(store: &TranscriptLedgerStore, target: ClearChatTarget) -> ClearChatRequest {
    let head = store.high_watermark(CHAT).unwrap();
    ClearChatRequest {
        chat_id: parse_chat_id(&json!(CHAT)).unwrap(),
        target,
        transcript_view_id: head.view_id.to_string(),
        last_ordinal: head.ordinal,
    }
}

fn bun(root: &Path, mode: &str) -> String {
    let out = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/clear-oracle.ts"
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
    String::from_utf8(out.stdout).unwrap().trim_end().into()
}

async fn snapshot(store: &TranscriptLedgerStore) -> String {
    #[derive(Serialize)]
    struct Snapshot {
        view: TranscriptView,
        rows: Vec<StoredLedgerRow>,
    }
    let head = store.high_watermark(CHAT).unwrap();
    let snapshot = Snapshot {
        view: store.current_view(CHAT).unwrap().unwrap(),
        rows: store
            .with_stored_rows_through(CHAT, &head, |rows| ready(Ok(rows)), None)
            .await
            .unwrap(),
    };
    store.close().unwrap();
    serde_json::to_string(&snapshot).unwrap()
}

#[tokio::test]
async fn clear_all_and_clear_before_match_bun_payload_bytes_on_ledgers_from_both_writers() {
    LocalSet::new()
        .run_until(async {
            for (mode, target) in [
                ("all", ClearChatTarget::All),
                ("before", ClearChatTarget::BeforeMessage { ordinal: 6 }),
            ] {
                let original = tempfile::tempdir().unwrap();
                let expected = bun(original.path(), mode);
                let decoded: Value = from_slice(expected.as_bytes()).unwrap();
                let replacement = decoded["view"]["viewId"].as_str().unwrap();
                assert_eq!(
                    snapshot(&store(original.path(), replacement)).await,
                    expected,
                    "{mode}"
                );
                let port = tempfile::tempdir().unwrap();
                let f = fixture_with_replacement(port.path(), replacement);
                let response = f
                    .clear
                    .clear(request(&f.store, target), CancellationToken::new())
                    .await
                    .unwrap();
                assert_eq!(response.transcript_view_id, replacement);
                assert!(f.registry.pending.borrow().is_none());
                assert_eq!(f.registry.flushes.get(), 1);
                let rows = f.store.current_rows(CHAT).unwrap();
                let evidence = collect_preamble_history_evidence(&rows).unwrap();
                assert_eq!(evidence.len(), 2);
                assert!(evidence[0].requires_native_occurrence);
                assert!(!evidence[1].requires_native_occurrence);
                assert_eq!(snapshot(&f.store).await, expected, "{mode}");
                assert_eq!(bun(port.path(), "read"), expected, "{mode}");
            }
        })
        .await;
}

#[tokio::test]
async fn clear_refuses_ownership_before_reservation_and_rechecks_queue_and_watermark_at_promotion()
{
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let f = fixture(root.path());
            let confirmation = request(&f.store, ClearChatTarget::All);
            f.transferring.set(true);
            let failure = f
                .clear
                .clear(confirmation.clone(), CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(
                as_domain_error(failure.as_ref()).unwrap().code,
                ErrorCode::OWNERSHIP_TRANSFER_PENDING
            );
            assert_eq!(f.execution.reserved.get(), 0);
            f.transferring.set(false);
            let exec = f.execution.clone();
            f.execution
                .at_promotion
                .replace(Some(Box::new(move || exec.pending.set(true))));
            let failure = f
                .clear
                .clear(confirmation.clone(), CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(
                as_domain_error(failure.as_ref()).unwrap().code,
                ErrorCode::CHAT_RUNNING
            );
            assert_eq!(
                f.store.high_watermark(CHAT).unwrap().view_id.as_str(),
                SOURCE
            );
            assert_eq!(f.reopened.get(), 1);
            f.execution.pending.set(false);

            let store = f.store.clone();
            f.execution.at_promotion.replace(Some(Box::new(move || {
                let view = transcript_view_id(SOURCE).unwrap();
                store.append(CHAT, &view, &drafts()[3..4]).unwrap();
            })));
            let failure = f
                .clear
                .clear(confirmation, CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(
                as_domain_error(failure.as_ref()).unwrap().code,
                ErrorCode::STALE_TRANSCRIPT_VIEW
            );
            assert_eq!(
                f.store.high_watermark(CHAT).unwrap().view_id.as_str(),
                SOURCE
            );
            assert_eq!(f.reopened.get(), 2);
            assert_eq!(f.execution.released.get(), 2);
        })
        .await;
}

#[tokio::test]
async fn clear_reports_an_unknown_outcome_when_release_fails_after_cutover() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let f = fixture(root.path());
            f.execution.release_fails.set(true);
            let failure = f
                .clear
                .clear(
                    request(&f.store, ClearChatTarget::All),
                    CancellationToken::new(),
                )
                .await
                .unwrap_err();
            let failure = as_domain_error(failure.as_ref()).unwrap();
            assert_eq!(failure.code, ErrorCode::TRANSCRIPT_CLEAR_OUTCOME_UNKNOWN);
            assert!(!failure.retryable);
            assert_eq!(
                f.store.high_watermark(CHAT).unwrap().view_id.as_str(),
                REPLACEMENT
            );
            assert_eq!(f.reopened.get(), 1);
            assert_eq!(f.execution.released.get(), 1);
        })
        .await;
}

#[tokio::test]
async fn dropping_clear_waiter_keeps_the_lock_and_releases_only_after_cancellation_settles() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let f = fixture(root.path());
            let (entered, held) = oneshot::channel();
            let (continue_clear, finished) = oneshot::channel();
            f.registry.flush_hook.replace(Some(Box::new(move || {
                Box::pin(async move {
                    entered.send(()).unwrap();
                    finished.await?;
                    Ok(())
                })
            })));
            let signal = CancellationToken::new();
            let mut pending = Box::pin(
                f.clear
                    .clear(request(&f.store, ClearChatTarget::All), signal.clone()),
            );
            assert!(futures::poll!(&mut pending).is_pending());
            drop(pending);
            held.await.unwrap();
            let key = format!("chat:{CHAT}");
            let mut waiter = Box::pin(f.mutation_lock.run_exclusive(&key, || ready(()), None));
            assert!(futures::poll!(&mut waiter).is_pending());
            assert_eq!(f.execution.released.get(), 0);
            signal.cancel();
            continue_clear.send(()).unwrap();
            waiter.await.unwrap();
            assert_eq!(f.execution.released.get(), 1);
            assert_eq!(f.reopened.get(), 1);
            assert_eq!(
                f.store.high_watermark(CHAT).unwrap().view_id.as_str(),
                SOURCE
            );
        })
        .await;
}
