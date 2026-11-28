use std::{
    cell::{Cell, RefCell},
    collections::{HashSet, VecDeque},
    error::Error,
    io,
    path::{Path, PathBuf},
    process::Command,
    rc::Rc,
    time::Duration,
};

use async_trait::async_trait;
use garcon_base::{domain_error::as_domain_error, json_file_store::JsonFileStore};
use garcon_chats::{
    agent_ownership_journal::{
        AgentOwnershipJournal, DecideHandoff, OwnershipAgent, OwnershipAgentDirectory,
        OwnershipJournalOptions, OwnershipJournalWriter, OwnershipLedger, matches_handoff_target,
    },
    agent_ownership_journal_format::{
        AgentOwnershipJournalFileV5, HandoffPhase, HandoffSource, ResolvedAgentHandoffTarget,
        TranscriptWatermark,
    },
    store::{ChatRegistry, NewChatRegistryEntry, ReferenceLease, RegistryWriteFailure},
};
use garcon_contract::{
    agent_integration::{AgentSettingDescriptor, AgentSettingsEnvelope},
    api_providers::ApiProtocol,
    chat_id::parse_chat_id,
    chat_modes::{PermissionMode, ThinkingMode},
    preambles::{ChatPreambleSelection, PendingPreambleBoundary},
};
use garcon_interface::{
    native_history::{
        AgentHistoryImportRequest, AgentNativeSessionAccess, AgentNativeSessionReleaseReason,
        AgentNativeSessionReleaseRequest,
    },
    resources::ExecutorResult,
    services::AgentSettings,
    transcript::{AgentNativeSessionRef, AgentTranscriptSourceLocation},
};
use garcon_js::{
    ManualClock, OptionalNullable,
    date_parse::date_parse,
    json::{Opaque, from_str},
};
use indexmap::IndexMap;
use serde_json::json;
use tokio::{
    sync::{Notify, oneshot},
    task::LocalSet,
};

const A: &str = "1783725900000200";
const B: &str = "1783725900000201";
const EXECUTOR: &str = "3502b645-222b-49d2-ac39-1c91f9fb1174";
const OTHER_EXECUTOR: &str = "d3db9fba-3add-45af-8a81-9abffcca5300";
const HANDOFF: &str = "handoff:fixture";
const FILE: &str = "agent-ownership-journal.json";
const EMPTY: &str = "{\n  \"version\": 5,\n  \"ownershipIntents\": []\n}\n";

type BoxError = Box<dyn Error>;
type DeleteGate = (oneshot::Sender<()>, oneshot::Receiver<()>);

fn workspace() -> tempfile::TempDir {
    let root = PathBuf::from(std::env::var_os("HOME").unwrap()).join("tmp/interface");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::Builder::new()
        .prefix("chat-ownership-")
        .tempdir_in(root)
        .unwrap()
}

fn settings(agent: &str) -> AgentSettingsEnvelope {
    AgentSettingsEnvelope {
        owner_id: agent.into(),
        schema_version: 1,
        values: from_str(
            r#"{"b":1.0,"10":"ten","2":"two","big":9007199254740993,"exp21":1e21,"zero":-0}"#,
        )
        .unwrap(),
    }
}

fn add(registry: &Rc<ChatRegistry>, chat: &str, executor: Option<&str>, epoch: &str) {
    let mut new = NewChatRegistryEntry::new(
        parse_chat_id(&json!(chat)).unwrap(),
        "codex".into(),
        "source-model".into(),
        "/workspace/project".into(),
        ChatPreambleSelection {
            revision: 3,
            ordered_preamble_ids: Vec::new(),
        },
    );
    new.entry.agent_ownership_epoch = epoch.into();
    new.entry.agent_session_id = Some("fixture-session".into());
    new.entry
        .agent_settings_by_id
        .insert("codex".into(), settings("codex"));
    new.entry.executor_id = executor.map_or(OptionalNullable::ABSENT, |id| {
        OptionalNullable::some(id.into())
    });
    registry.add_chat(new).unwrap();
}

fn decision(chat: &str) -> DecideHandoff {
    DecideHandoff {
        operation_id: HANDOFF.into(),
        client_request_id: "fixture".into(),
        submitted_target_hash: "a".repeat(64),
        chat_id: chat.into(),
        source: HandoffSource {
            executor_id: OptionalNullable::ABSENT,
            agent_id: "codex".into(),
            agent_ownership_epoch: "source-epoch".into(),
        },
        target: ResolvedAgentHandoffTarget {
            executor_id: OptionalNullable::some(EXECUTOR.into()),
            project_path: Some("/worker/project".into()),
            agent_id: "claude".into(),
            model: "target-model".into(),
            api_provider_id: Some("fixture-provider".into()),
            model_endpoint_id: Some("fixture-endpoint".into()),
            model_protocol: Some(ApiProtocol::AnthropicMessages),
            permission_mode: PermissionMode::AcceptEdits,
            thinking_mode: ThinkingMode::Low,
            agent_settings: settings("claude"),
        },
        target_agent_ownership_epoch: "target-epoch".into(),
        watermark: TranscriptWatermark {
            view_id: "fixture-view".into(),
            ordinal: 7,
        },
    }
}

fn bun(workspace: &Path, mode: &str) -> Opaque {
    let response = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/ownership-journal-disk.ts"
        ))
        .arg(mode)
        .arg(workspace)
        .output()
        .unwrap();
    assert!(
        response.status.success(),
        "Bun {mode}: {}",
        String::from_utf8_lossy(&response.stderr)
    );
    garcon_js::json::from_slice(&response.stdout).unwrap()
}

async fn read(workspace: &Path) -> String {
    tokio::fs::read_to_string(workspace.join(FILE))
        .await
        .unwrap()
}

#[derive(Default)]
struct Ledger {
    calls: RefCell<Vec<String>>,
    fail: Cell<bool>,
    gate: RefCell<Option<DeleteGate>>,
}

#[async_trait(?Send)]
impl OwnershipLedger for Ledger {
    async fn delete_chat(&self, chat_id: &str) -> Result<(), BoxError> {
        self.calls.borrow_mut().push(chat_id.into());
        let gate = self.gate.borrow_mut().take();
        if let Some((entered, proceed)) = gate {
            entered.send(()).unwrap();
            proceed.await.unwrap();
        }
        if self.fail.get() {
            return Err(io::Error::other("synthetic ledger delete failure").into());
        }
        Ok(())
    }
}

struct Settings(String);

#[async_trait(?Send)]
impl AgentSettings for Settings {
    fn describe(&self) -> &[AgentSettingDescriptor] {
        &[]
    }
    fn defaults(&self) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(settings(&self.0))
    }
    fn parse(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        if input.owner_id != self.0 {
            return Err("wrong owner".into());
        }
        Ok(input)
    }
    async fn migrate(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        self.parse(input)
    }
    fn apply_patch(
        &self,
        mut current: AgentSettingsEnvelope,
        patch: IndexMap<String, Opaque>,
    ) -> ExecutorResult<AgentSettingsEnvelope> {
        let mut values = (*current.values).clone();
        for (key, value) in patch {
            values[&key] = (*value).clone();
        }
        current.values = Opaque::from_value(values);
        self.parse(current)
    }
}

#[derive(Default)]
struct Native {
    releases: RefCell<Vec<AgentNativeSessionReleaseRequest>>,
    fail: Cell<bool>,
    gate: RefCell<Option<DeleteGate>>,
    wait_for_abort: Cell<bool>,
    abort_observed: Notify,
}

#[async_trait(?Send)]
impl AgentNativeSessionAccess for Native {
    async fn resolve_native_session(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        Ok(request.chat.native_session)
    }
    async fn describe_source(
        &self,
        _request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>> {
        Ok(None)
    }
    async fn release(&self, request: AgentNativeSessionReleaseRequest) -> ExecutorResult<()> {
        self.releases.borrow_mut().push(request.clone());
        let gate = self.gate.borrow_mut().take();
        if let Some((entered, proceed)) = gate {
            entered.send(()).unwrap();
            proceed.await.unwrap();
        }
        if self.wait_for_abort.get() {
            request.request.signal.cancelled().await;
            self.abort_observed.notify_one();
        }
        if self.fail.get() {
            return Err(io::Error::other("synthetic release failure").into());
        }
        Ok(())
    }
}

#[derive(Default)]
struct Directory {
    online: RefCell<HashSet<String>>,
    native: Rc<Native>,
}

impl OwnershipAgentDirectory for Directory {
    fn get(&self, agent_id: &str, executor_id: Option<&str>) -> Option<OwnershipAgent> {
        self.online
            .borrow()
            .contains(executor_id.unwrap_or("local"))
            .then(|| OwnershipAgent {
                agent_id: agent_id.into(),
                settings: Rc::new(Settings(agent_id.into())),
                native_sessions: Some(self.native.clone()),
            })
    }
}

#[tokio::test]
async fn handoff_decisions_use_the_real_writers_in_both_directions() {
    LocalSet::new().run_until(async {
        let bun_dir = workspace();
        let rust_dir = workspace();
        let original = bun(bun_dir.path(), "write-handoff");
        let directory = Rc::new(Directory::default());
        let ledger = Rc::new(Ledger::default());
        let registry_read = ChatRegistry::open(bun_dir.path()).await.unwrap();
        let read_bun = AgentOwnershipJournal::open(bun_dir.path(), registry_read.clone(), directory.clone(), ledger.clone(), Rc::new(|_| true), Default::default()).await.unwrap();
        assert!(read_bun.references_api_provider("fixture-provider"));
        assert!(read_bun.references_executor(EXECUTOR));
        assert!(read_bun.blocks_executor_removal(EXECUTOR));
        assert_eq!(read_bun.pending_handoffs().len(), 1);
        assert_eq!(read_bun.pending_handoffs()[0].phase, HandoffPhase::CommitDecided);
        assert_eq!(registry_read.get_chat(A).unwrap().agent_id, "codex");
        assert!(read_bun.complete_handoff(HANDOFF).await.unwrap_err().to_string().contains("before target ownership is installed"));

        let registry_native = ChatRegistry::open(rust_dir.path()).await.unwrap();
        add(&registry_native, A, None, "source-epoch");
        registry_native.flush().await.unwrap();
        let clock = ManualClock::new(date_parse(original["intent"]["createdAt"].as_str().unwrap()).unwrap());
        let native = AgentOwnershipJournal::open(rust_dir.path(), registry_native, directory, ledger.clone(), Rc::new(|_| true), OwnershipJournalOptions { clock: Rc::new(clock), ..Default::default() }).await.unwrap();
        let first = native.decide_handoff(decision(A)).await.unwrap();
        assert_eq!(native.decide_handoff(decision(A)).await.unwrap(), first);
        assert_eq!(read(rust_dir.path()).await, original["decided"].as_str().unwrap());
        let from_rust = bun(rust_dir.path(), "apply-handoff");
        assert_eq!(from_rust["decided"], original["decided"]);

        let applied = read_bun.apply_handoff_decision(HANDOFF).await.unwrap();
        assert!(matches_handoff_target(Some(&applied.entry), &first));
        assert!(applied.entry.agent_session_id.is_none());
        assert!(matches!(applied.entry.pending_preamble_boundary, Some(PendingPreambleBoundary::AgentSwitch { ownership_epoch }) if ownership_epoch == "target-epoch"));
        assert_eq!(applied.entry.preamble_selection.revision, 3);
        assert_eq!(read(bun_dir.path()).await, from_rust["applied"].as_str().unwrap());
        assert_eq!(tokio::fs::read_to_string(registry_read.path()).await.unwrap(), from_rust["registryBytes"].as_str().unwrap());
        read_bun.complete_handoff(HANDOFF).await.unwrap();
        assert_eq!(read(bun_dir.path()).await, from_rust["completed"].as_str().unwrap());
        assert_eq!(read(bun_dir.path()).await, EMPTY);
        assert!(!read_bun.references_executor(EXECUTOR));
        assert!(ledger.calls.borrow().is_empty());
    }).await;
}

#[tokio::test]
async fn offline_delete_journals_round_trip_both_writers_and_retire_without_retargeting() {
    LocalSet::new()
        .run_until(async {
            let bun_dir = workspace();
            let rust_dir = workspace();
            let original = bun(bun_dir.path(), "write-delete");
            let bytes = original["file"].as_str().unwrap();
            let parsed: Opaque = from_str(bytes).unwrap();
            let entry = &parsed["ownershipIntents"][0];
            let operation = entry["operationId"].as_str().unwrap().to_owned();
            let at = date_parse(entry["createdAt"].as_str().unwrap()).unwrap();
            let agents = Rc::new(Directory::default());
            let configured = Rc::new(Cell::new(true));
            let registry = ChatRegistry::open(rust_dir.path()).await.unwrap();
            add(&registry, A, Some(EXECUTOR), "source-epoch");
            registry.flush().await.unwrap();
            let ledger = Rc::new(Ledger::default());
            let native = AgentOwnershipJournal::open(
                rust_dir.path(),
                registry.clone(),
                agents.clone(),
                ledger.clone(),
                {
                    let configured = configured.clone();
                    Rc::new(move |id| id == "local" || configured.get())
                },
                OwnershipJournalOptions {
                    operation_id: Rc::new(move || operation.clone()),
                    clock: Rc::new(ManualClock::new(at)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            native.delete(A).await.unwrap();
            native.wait_for_provider_cleanup().await;
            assert!(!registry.has_chat(A));
            assert_eq!(*ledger.calls.borrow(), [A]);
            assert_eq!(read(rust_dir.path()).await, bytes);
            assert_eq!(bun(rust_dir.path(), "recover-delete"), original);

            let bun_registry = ChatRegistry::open(bun_dir.path()).await.unwrap();
            let read_bun = AgentOwnershipJournal::open(
                bun_dir.path(),
                bun_registry,
                agents.clone(),
                ledger.clone(),
                {
                    let configured = configured.clone();
                    Rc::new(move |id| id == "local" || configured.get())
                },
                Default::default(),
            )
            .await
            .unwrap();
            read_bun.wait_for_provider_cleanup().await;
            assert_eq!(read(bun_dir.path()).await, bytes);
            assert!(read_bun.references_executor(EXECUTOR));
            assert!(!read_bun.blocks_executor_removal(EXECUTOR));
            read_bun.retire_removed_executor(EXECUTOR).await.unwrap();
            assert!(read_bun.has_pending(A));
            configured.set(false);
            agents.online.borrow_mut().insert("local".into());
            read_bun.retire_removed_executor(EXECUTOR).await.unwrap();
            assert_eq!(read(bun_dir.path()).await, EMPTY);
            assert!(!read_bun.has_pending(A));
            assert!(agents.native.releases.borrow().is_empty());
            assert_eq!(*ledger.calls.borrow(), [A, A]);
        })
        .await;
}

#[derive(Default)]
struct FaultWriter {
    faults: RefCell<VecDeque<bool>>,
    candidates: RefCell<Vec<String>>,
    retry_gate: RefCell<Option<DeleteGate>>,
}

#[async_trait(?Send)]
impl OwnershipJournalWriter for FaultWriter {
    async fn write(
        &self,
        path: &Path,
        journal: &AgentOwnershipJournalFileV5,
    ) -> Result<(), RegistryWriteFailure> {
        let fault = self.faults.borrow_mut().pop_front();
        self.candidates
            .borrow_mut()
            .push(serde_json::to_string(journal).unwrap());
        let gate = if self.candidates.borrow().len() == 3 {
            self.retry_gate.borrow_mut().take()
        } else {
            None
        };
        if let Some((entered, proceed)) = gate {
            entered.send(()).unwrap();
            proceed.await.unwrap();
        }
        if fault != Some(false) {
            JsonFileStore::default().write(path, journal).await?;
        }
        match fault {
            Some(renamed) => Err(RegistryWriteFailure {
                renamed,
                cause: Box::new(io::Error::other("synthetic journal write failure")),
            }),
            None => Ok(()),
        }
    }
}

#[tokio::test]
async fn an_ambiguous_intent_holds_references_and_retries_the_identical_candidate() {
    LocalSet::new()
        .run_until(async {
            let directory = workspace();
            let registry = ChatRegistry::open(directory.path()).await.unwrap();
            add(&registry, A, None, "source-epoch");
            registry.flush().await.unwrap();
            let writer = Rc::new(FaultWriter::default());
            writer.faults.borrow_mut().extend([false, true]);
            let references = Rc::new(Cell::new(0usize));
            let active = references.clone();
            let journal = AgentOwnershipJournal::open(
                directory.path(),
                registry.clone(),
                Rc::new(Directory::default()),
                Rc::new(Ledger::default()),
                Rc::new(|_| true),
                OwnershipJournalOptions {
                    writer: writer.clone(),
                    retain_executor_references: Some(Rc::new(move |next, _previous| {
                        assert!(next.iter().any(|id| id == EXECUTOR));
                        active.set(active.get() + 1);
                        let active = active.clone();
                        Ok(ReferenceLease::new(move || active.set(active.get() - 1)))
                    })),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(
                journal
                    .decide_handoff(decision(A))
                    .await
                    .unwrap_err()
                    .to_string(),
                "synthetic journal write failure"
            );
            assert!(!journal.has_pending(A));
            assert!(!journal.blocks_executor_removal(EXECUTOR));
            assert_eq!(references.get(), 0);
            let (retry_entered, retry) = oneshot::channel();
            let (release, proceed) = oneshot::channel();
            writer.retry_gate.replace(Some((retry_entered, proceed)));
            let request = journal.clone();
            let request =
                tokio::task::spawn_local(async move { request.decide_handoff(decision(A)).await });
            retry.await.unwrap();
            assert!(
                !journal.has_pending(A),
                "unconfirmed candidate was published"
            );
            assert!(journal.blocks_executor_removal(EXECUTOR));
            assert_eq!(references.get(), 1);
            assert_eq!(registry.get_chat(A).unwrap().agent_id, "codex");
            assert_eq!(writer.candidates.borrow()[1], writer.candidates.borrow()[2]);
            release.send(()).unwrap();
            request.await.unwrap().unwrap();
            assert!(journal.has_pending(A));
            assert_eq!(references.get(), 0);
            let mut conflict = decision(A);
            conflict.watermark.ordinal += 1;
            let rejected = journal.decide_handoff(conflict).await.unwrap_err();
            assert_eq!(
                as_domain_error(rejected.as_ref()).unwrap().code.as_str(),
                "IDEMPOTENCY_CONFLICT"
            );
            assert_eq!(writer.candidates.borrow().len(), 3);
        })
        .await;
}

#[tokio::test]
async fn provider_release_does_not_delay_other_controller_deletes_or_touch_recreated_chats() {
    LocalSet::new()
        .run_until(async {
            let directory = workspace();
            let registry = ChatRegistry::open(directory.path()).await.unwrap();
            add(&registry, A, Some(EXECUTOR), "source-epoch");
            add(&registry, B, Some(OTHER_EXECUTOR), "source-epoch");
            registry.flush().await.unwrap();
            let agents = Rc::new(Directory::default());
            agents
                .online
                .borrow_mut()
                .extend([EXECUTOR.to_owned(), OTHER_EXECUTOR.to_owned()]);
            let ledger = Rc::new(Ledger::default());
            let (entered, started) = oneshot::channel();
            let (release, proceed) = oneshot::channel();
            agents.native.gate.replace(Some((entered, proceed)));
            let journal = AgentOwnershipJournal::open(
                directory.path(),
                registry.clone(),
                agents.clone(),
                ledger.clone(),
                Rc::new(|_| true),
                Default::default(),
            )
            .await
            .unwrap();
            journal.delete(A).await.unwrap();
            started.await.unwrap();
            add(&registry, A, Some(EXECUTOR), "replacement");
            journal.delete(B).await.unwrap();
            assert_eq!(*ledger.calls.borrow(), [A, B]);
            assert_eq!(agents.native.releases.borrow().len(), 1);
            assert_eq!(
                agents.native.releases.borrow()[0].reason,
                AgentNativeSessionReleaseReason::Deleted
            );
            release.send(()).unwrap();
            journal.wait_for_provider_cleanup().await;
            assert_eq!(agents.native.releases.borrow().len(), 2);
            assert_eq!(
                registry.get_chat(A).unwrap().agent_ownership_epoch,
                "replacement"
            );
            assert!(!registry.has_chat(B));
            assert_eq!(*ledger.calls.borrow(), [A, B]);
            assert_eq!(read(directory.path()).await, EMPTY);
        })
        .await;
}

#[tokio::test]
async fn failed_ledger_retirement_blocks_executor_removal_until_startup_recovers_it() {
    LocalSet::new()
        .run_until(async {
            let directory = workspace();
            let registry = ChatRegistry::open(directory.path()).await.unwrap();
            add(&registry, A, Some(EXECUTOR), "source-epoch");
            registry.flush().await.unwrap();
            let agents = Rc::new(Directory::default());
            let ledger = Rc::new(Ledger::default());
            ledger.fail.set(true);
            let journal = AgentOwnershipJournal::open(
                directory.path(),
                registry,
                agents.clone(),
                ledger.clone(),
                Rc::new(|_| false),
                Default::default(),
            )
            .await
            .unwrap();
            let error = journal.delete(A).await.unwrap_err();
            assert_eq!(error.to_string(), "synthetic ledger delete failure");
            assert!(journal.blocks_executor_removal(EXECUTOR));
            journal.retire_removed_executor(EXECUTOR).await.unwrap();
            assert!(journal.has_pending(A));
            assert!(agents.native.releases.borrow().is_empty());
            ledger.fail.set(false);
            let registry = ChatRegistry::open(directory.path()).await.unwrap();
            let reopened = AgentOwnershipJournal::open(
                directory.path(),
                registry,
                agents.clone(),
                ledger.clone(),
                Rc::new(|id| id == "local"),
                Default::default(),
            )
            .await
            .unwrap();
            reopened.wait_for_provider_cleanup().await;
            assert!(!reopened.blocks_executor_removal(EXECUTOR));
            assert_eq!(read(directory.path()).await, EMPTY);
            assert_eq!(*ledger.calls.borrow(), [A, A]);
            assert!(agents.native.releases.borrow().is_empty());
        })
        .await;
}

#[tokio::test]
async fn provider_timeout_aborts_release_and_retries_only_the_ready_executor() {
    LocalSet::new()
        .run_until(async {
            let directory = workspace();
            let registry = ChatRegistry::open(directory.path()).await.unwrap();
            add(&registry, A, Some(EXECUTOR), "source-epoch");
            add(&registry, B, Some(OTHER_EXECUTOR), "source-epoch");
            registry.flush().await.unwrap();
            let agents = Rc::new(Directory::default());
            agents.online.borrow_mut().insert(EXECUTOR.into());
            agents.native.wait_for_abort.set(true);
            let ledger = Rc::new(Ledger::default());
            let journal = AgentOwnershipJournal::open(
                directory.path(),
                registry,
                agents.clone(),
                ledger.clone(),
                Rc::new(|_| true),
                OwnershipJournalOptions {
                    release_timeout_ms: 30,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            journal.delete(A).await.unwrap();
            journal.delete(B).await.unwrap();
            journal.wait_for_provider_cleanup().await;
            tokio::time::timeout(
                Duration::from_secs(2),
                agents.native.abort_observed.notified(),
            )
            .await
            .unwrap();
            assert!(journal.has_pending(A));
            assert!(journal.has_pending(B));
            assert_eq!(agents.native.releases.borrow().len(), 1);
            agents.native.wait_for_abort.set(false);
            agents.native.fail.set(true);
            journal.retry_provider_cleanup(EXECUTOR).await.unwrap();
            assert!(journal.has_pending(A));
            agents.native.fail.set(false);
            let (left, right) = tokio::join!(
                journal.retry_provider_cleanup(EXECUTOR),
                journal.retry_provider_cleanup(EXECUTOR)
            );
            left.unwrap();
            right.unwrap();
            assert!(!journal.has_pending(A));
            assert!(journal.has_pending(B));
            assert_eq!(
                agents
                    .native
                    .releases
                    .borrow()
                    .iter()
                    .map(|request| request.request.chat.chat_id.as_str())
                    .collect::<Vec<_>>(),
                [A, A, A]
            );
            assert_eq!(*ledger.calls.borrow(), [A, B]);
        })
        .await;
}

#[tokio::test]
async fn only_empty_earlier_journals_are_adopted_and_corrupt_files_are_kept() {
    LocalSet::new()
        .run_until(async {
            let directory = workspace();
            let registry = ChatRegistry::open(directory.path()).await.unwrap();
            let agents = Rc::new(Directory::default());
            let ledger = Rc::new(Ledger::default());
            let file = directory.path().join(FILE);
            let earlier = r#"{"version":3,"ownershipIntents":[],"transferCleanup":[]}"#;
            tokio::fs::write(&file, earlier).await.unwrap();
            let journal = AgentOwnershipJournal::open(
                directory.path(),
                registry.clone(),
                agents.clone(),
                ledger.clone(),
                Rc::new(|_| true),
                Default::default(),
            )
            .await
            .unwrap();
            assert!(journal.pending_handoffs().is_empty());
            assert_eq!(read(directory.path()).await, earlier);
            for (raw, expected) in [
                ("{broken", "agent-ownership-journal.json is not valid JSON"),
                (
                    r#"{"version":3,"ownershipIntents":[{}]}"#,
                    "Invalid agent ownership journal",
                ),
            ] {
                tokio::fs::write(&file, raw).await.unwrap();
                let Err(error) = AgentOwnershipJournal::open(
                    directory.path(),
                    registry.clone(),
                    agents.clone(),
                    ledger.clone(),
                    Rc::new(|_| true),
                    Default::default(),
                )
                .await
                else {
                    panic!("corrupt journal opened")
                };
                assert_eq!(error.to_string(), expected);
                assert_eq!(read(directory.path()).await, raw);
            }
        })
        .await;
}
