use std::{
    cell::{Cell, RefCell},
    error::Error,
    io,
    path::{Path, PathBuf},
    process::Command,
    rc::Rc,
};

use async_trait::async_trait;
use futures::stream;
use garcon_base::json_file_store::JsonFileStore;
use garcon_chats::{
    chat_activity_outcomes::ChatActivityOutcomes,
    chat_list_projector::{ChatListProjector, ChatListProjectorDeps, ChatListSettings},
    metadata_store::{
        AgentPreviewMetadata, ExistingTranscriptPreview, MetadataIndex, MetadataIndexOptions,
        MetadataOutcomeReader, MetadataSnapshot, MetadataTranscriptSource, MetadataWriter,
    },
    registry_contracts::ChatRegistryEntry,
    registry_entry_codec::normalize_chat_registry_entry,
    store::{ChatRegistry, ChatRegistryPatch, ChatRemovalReason, NewChatRegistryEntry},
};
use garcon_contract::{
    chat_activity::{ChatActivityStatus, ChatRunOutcome},
    chat_id::{ChatId, parse_chat_id},
    chat_list::ChatOrderGroup,
    chat_types::{AssistantMessage, ChatMessage, ChatProcessingPhase, UserMessage},
};
use garcon_js::{OptionalNullable, clock::ManualClock, date_parse::date_parse, json::Opaque};
use serde_json::json;
use tokio::{sync::oneshot, task::LocalSet};

const LOCAL: &str = "1783725900000200";
const REMOTE: &str = "1783725900000201";
const MISSING: &str = "1783725900000202";
const EXECUTOR: &str = "3502b645-222b-49d2-ac39-1c91f9fb1174";
const EARLY: &str = "2026-07-10T08:00:00.000Z";
const LATE: &str = "2026-07-10T09:00:00.000Z";
const FIRST: &str = "  First title  \nLong first message";
const LAST: &str = "Last line\nSecond line";

type BoxError = Box<dyn Error>;

fn workspace() -> tempfile::TempDir {
    let root = PathBuf::from(std::env::var_os("HOME").unwrap()).join("tmp/interface");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::Builder::new()
        .prefix("chat-metadata-")
        .tempdir_in(root)
        .unwrap()
}

fn id(chat_id: &str) -> ChatId {
    parse_chat_id(&json!(chat_id)).unwrap()
}

fn view(chat_id: &str) -> String {
    format!("view-{chat_id}")
}

fn user(content: &str, timestamp: &str) -> ChatMessage {
    ChatMessage::User(UserMessage {
        timestamp: timestamp.into(),
        content: content.into(),
        images: None,
        metadata: None,
        presentation: None,
    })
}

fn assistant(content: &str, timestamp: &str) -> ChatMessage {
    ChatMessage::Assistant(AssistantMessage {
        timestamp: timestamp.into(),
        content: content.into(),
        questions: None,
    })
}

fn bun(workspace: &Path, mode: &str) -> Opaque {
    let response = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/metadata-disk.ts"
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

async fn registry(workspace: &Path) -> Rc<ChatRegistry> {
    let registry = ChatRegistry::open(workspace).await.unwrap();
    for chat in [LOCAL, REMOTE] {
        let mut value = json!({
            "agentId": "codex", "agentOwnershipEpoch": "fixture-epoch", "model": "fixture-model",
            "projectPath": "/workspace/project", "agentSettingsById": {}, "tags": ["review", "review", "work"],
            "agentSessionId": null, "carryOverSegments": [], "nativeSeedReceipt": null,
            "carryOverMigrationQuarantine": null,
            "parentChatId": null, "lineage": null,
        });
        if chat == REMOTE {
            value["executorId"] = json!(EXECUTOR);
            value["parentChatId"] = json!(LOCAL);
        }
        let entry = normalize_chat_registry_entry(value.as_object().unwrap(), chat).unwrap();
        registry
            .add_chat(NewChatRegistryEntry {
                id: id(chat),
                entry,
            })
            .unwrap();
    }
    registry
        .update_chat_flushed(
            LOCAL,
            ChatRegistryPatch {
                last_read_at: Some(OptionalNullable::some(EARLY.into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    registry
}

#[derive(Default)]
struct Transcript {
    unavailable: Cell<bool>,
    replaced: Cell<bool>,
    previews: RefCell<Vec<ChatId>>,
}

impl MetadataTranscriptSource for Transcript {
    fn existing_view_id(&self, chat_id: &ChatId) -> Result<Option<String>, BoxError> {
        if self.unavailable.get() {
            return Err(io::Error::other("unavailable view").into());
        }
        Ok(Some(if self.replaced.get() && chat_id.as_str() == LOCAL {
            "replacement".into()
        } else {
            view(chat_id)
        }))
    }

    fn existing_preview(
        &self,
        _session: &ChatRegistryEntry,
        chat_id: &ChatId,
    ) -> Result<Option<ExistingTranscriptPreview>, BoxError> {
        self.previews.borrow_mut().push(chat_id.clone());
        Ok(
            (chat_id.as_str() == REMOTE).then(|| ExistingTranscriptPreview {
                preview: Some(AgentPreviewMetadata {
                    created_at: Some(EARLY.into()),
                    last_activity: Some(LATE.into()),
                    first_message: "From ledger".into(),
                    last_message: Some("Ledger tail".into()),
                }),
            }),
        )
    }
}

struct Settings;

impl ChatListSettings for Settings {
    fn pinned_chat_ids(&self) -> Vec<String> {
        vec![LOCAL.into()]
    }
    fn normal_chat_ids(&self) -> Vec<String> {
        vec![LOCAL.into(), REMOTE.into()]
    }
    fn archived_chat_ids(&self) -> Vec<String> {
        vec![LOCAL.into()]
    }
    fn chat_name(&self, chat_id: &ChatId) -> Option<String> {
        (chat_id.as_str() == LOCAL).then(|| "  \nIgnored title".into())
    }
}

#[tokio::test]
async fn metadata_and_list_projection_match_bun_bytes_in_both_directions() {
    LocalSet::new()
        .run_until(async {
            let rust_dir = workspace();
            let bun_dir = workspace();
            let original = bun(bun_dir.path(), "write");
            let file = |directory: &Path| directory.join("chat-metadata.json");
            let source = Rc::new(Transcript::default());
            let bun_registry = ChatRegistry::open(bun_dir.path()).await.unwrap();
            let read = MetadataIndex::open(
                bun_registry,
                source.clone(),
                MetadataIndexOptions {
                    path: Some(file(bun_dir.path())),
                    ..Default::default()
                },
            )
            .await;
            assert!(read.list_all_chat_metadata().is_empty());
            read.repair().await;
            assert!(
                source.previews.borrow().is_empty(),
                "matching cold previews need no reread"
            );
            assert_eq!(
                serde_json::to_string(&read.list_all_chat_metadata()).unwrap(),
                original["all"].as_str().unwrap()
            );

            let registry = registry(rust_dir.path()).await;
            let native = MetadataIndex::open(
                registry.clone(),
                source.clone(),
                MetadataIndexOptions {
                    path: Some(file(rust_dir.path())),
                    ..Default::default()
                },
            )
            .await;
            native
                .update_from_appended_messages(
                    &id(LOCAL),
                    &view(LOCAL),
                    &[user(FIRST, EARLY), assistant(LAST, LATE)],
                    None,
                )
                .unwrap();
            native.repair().await;
            native.flush().await.unwrap();
            let rust_bytes = tokio::fs::read_to_string(file(rust_dir.path()))
                .await
                .unwrap();
            assert_eq!(rust_bytes, original["file"].as_str().unwrap());
            let bun_reads_rust = bun(rust_dir.path(), "inspect");
            assert_eq!(bun_reads_rust, original);
            assert_eq!(*source.previews.borrow(), [id(REMOTE)]);

            let projector = ChatListProjector::new(ChatListProjectorDeps {
                registry: registry.clone(),
                metadata: native,
                settings: Rc::new(Settings),
                processing_phase: Rc::new(|id| {
                    (id.as_str() == LOCAL).then_some(ChatProcessingPhase::Reconnecting)
                }),
                has_pending_user_action: Rc::new(|id| id.as_str() == LOCAL),
                can_reload_from_native_history: Rc::new(|id, _| id.as_str() == REMOTE),
            });
            let summary = projector.build_summary(&id(LOCAL)).unwrap().unwrap();
            assert_eq!(
                serde_json::to_string(&summary).unwrap(),
                original["summary"].as_str().unwrap()
            );
            let list = projector.build_many(&registry.list_all_chats()).unwrap();
            assert_eq!(
                serde_json::to_string(&list).unwrap(),
                original["list"].as_str().unwrap()
            );
            let single = projector.build_one(&id(LOCAL)).unwrap().unwrap();
            assert_eq!(&single, &list[&id(LOCAL)]);
            assert_eq!(single.title, "New Session");
            assert_eq!(single.order_group, ChatOrderGroup::Pinned);
            assert!(single.is_unread);
            assert_eq!(
                single.activity_status,
                Some(ChatActivityStatus::PendingUserAction)
            );
            assert_eq!(list[&id(REMOTE)].parent_chat_id.as_ref(), Some(&id(LOCAL)));
            assert!(projector.build_summary(&id(MISSING)).unwrap().is_none());
        })
        .await;
}

#[tokio::test]
async fn paced_replacement_discards_failed_or_obsolete_pages_and_preserves_utf16_cutoffs() {
    LocalSet::new()
        .run_until(async {
            let directory = workspace();
            let registry = registry(directory.path()).await;
            let source = Rc::new(Transcript::default());
            let index = MetadataIndex::open(
                registry,
                source.clone(),
                MetadataIndexOptions {
                    clock: Rc::new(ManualClock::new(date_parse(EARLY).unwrap())),
                    ..Default::default()
                },
            )
            .await;
            let chat = id(LOCAL);
            index.add_new_chat_metadata(&chat, "old").unwrap();
            source.replaced.set(true);
            index.invalidate_transcript_view(&chat);
            assert!(index.get_chat_metadata(&chat).is_none());
            let error = index
                .replace_from_transcript_view(
                    &chat,
                    "replacement",
                    stream::iter([
                        Ok(vec![user("would leak partial", EARLY)]),
                        Err(io::Error::other("paged read failed").into()),
                    ]),
                )
                .await
                .unwrap_err();
            assert_eq!(error.to_string(), "paged read failed");
            assert!(index.get_chat_metadata(&chat).is_none());
            index
                .replace_from_transcript_view(
                    &chat,
                    &view(LOCAL),
                    stream::iter([Ok(vec![user("obsolete", LATE)])]),
                )
                .await
                .unwrap();
            assert!(index.get_chat_metadata(&chat).is_none());
            let content = format!("{}\u{1f603}tail", "a".repeat(4095));
            let last = format!("{}\u{1f603}tail", "z".repeat(511));
            index
                .replace_from_transcript_view(
                    &chat,
                    "replacement",
                    stream::iter([
                        Ok(vec![assistant("before first user", LATE)]),
                        Ok(vec![user(&content, EARLY), assistant(&last, EARLY)]),
                    ]),
                )
                .await
                .unwrap();
            let preview = index.get_chat_metadata(&chat).unwrap();
            assert_eq!(preview.created_at.as_deref(), Some(EARLY));
            assert_eq!(preview.last_activity.as_deref(), Some(LATE));
            assert_eq!(
                preview.first_message,
                format!("{}\u{2026}", "a".repeat(4095))
            );
            assert_eq!(preview.last_message, format!("{}\u{2026}", "z".repeat(511)));
            index
                .replace_from_transcript_view(&chat, "replacement", stream::empty())
                .await
                .unwrap();
            assert_eq!(index.get_chat_metadata(&chat).unwrap().first_message, "");
        })
        .await;
}

struct OutcomeGate {
    channels: RefCell<Option<(oneshot::Sender<()>, oneshot::Receiver<()>)>>,
}

#[async_trait(?Send)]
impl MetadataOutcomeReader for OutcomeGate {
    async fn read_run_outcome(
        &self,
        _chat_id: &ChatId,
        _transcript_view_id: &str,
    ) -> Result<Option<ChatRunOutcome>, BoxError> {
        let channels = self.channels.borrow_mut().take();
        if let Some((entered, proceed)) = channels {
            entered.send(()).unwrap();
            proceed.await.unwrap();
        }
        Ok(Some(ChatRunOutcome::Finished))
    }
}

#[tokio::test]
async fn slow_outcome_repair_neither_delays_other_previews_nor_overwrites_a_live_failure() {
    LocalSet::new()
        .run_until(async {
            let directory = workspace();
            let registry = registry(directory.path()).await;
            let source = Rc::new(Transcript::default());
            let (entered, at_read) = oneshot::channel();
            let (release, proceed) = oneshot::channel();
            let index = MetadataIndex::open(
                registry.clone(),
                source.clone(),
                MetadataIndexOptions {
                    outcome_reader: Some(Rc::new(OutcomeGate {
                        channels: RefCell::new(Some((entered, proceed))),
                    })),
                    ..Default::default()
                },
            )
            .await;
            let task_index = index.clone();
            let repair = tokio::task::spawn_local(async move { task_index.repair().await });
            at_read.await.unwrap();
            let chat = id(LOCAL);
            assert!(index.get_chat_metadata(&chat).is_none());
            assert!(index.get_chat_metadata(&id(REMOTE)).is_some());
            index.begin_run_attempt(&chat, "live");
            assert!(index.record_failed_attempt(
                index.capture_failure_attempt(&chat, Some("live")).as_ref()
            ));
            release.send(()).unwrap();
            repair.await.unwrap();
            assert_eq!(index.get_run_outcome(&chat), Some(ChatRunOutcome::Failed));
            assert_eq!(
                index.get_run_outcome(&id(REMOTE)),
                Some(ChatRunOutcome::Finished)
            );
            source.unavailable.set(true);
            assert!(index.capture_failure_attempt(&chat, Some("live")).is_none());
            assert_eq!(index.get_run_outcome(&chat), Some(ChatRunOutcome::Failed));
            registry
                .remove_chat(REMOTE, ChatRemovalReason::UserDeletion)
                .unwrap();
            assert!(index.get_chat_metadata(&id(REMOTE)).is_none());
            assert!(index.get_run_outcome(&id(REMOTE)).is_none());
            index.close().await;
        })
        .await;
}

#[derive(Clone, Copy)]
enum Fault {
    Rename,
    DirectorySync,
}

#[derive(Default)]
struct FileFault(Cell<Option<Fault>>);

#[async_trait(?Send)]
impl MetadataWriter for FileFault {
    async fn write(&self, path: &Path, snapshot: &MetadataSnapshot) -> Result<(), BoxError> {
        let fault = self.0.take();
        if matches!(fault, Some(Fault::Rename)) {
            return Err(io::Error::other("refused rename").into());
        }
        JsonFileStore::default().write(path, snapshot).await?;
        if matches!(fault, Some(Fault::DirectorySync)) {
            return Err(io::Error::other("directory sync unconfirmed").into());
        }
        Ok(())
    }
}

#[tokio::test]
async fn metadata_save_failures_do_not_certify_a_write_or_discard_the_live_preview() {
    LocalSet::new()
        .run_until(async {
            let directory = workspace();
            let registry = registry(directory.path()).await;
            let writer = Rc::new(FileFault::default());
            let path = directory.path().join("chat-metadata.json");
            let index = MetadataIndex::open(
                registry,
                Rc::new(Transcript::default()),
                MetadataIndexOptions {
                    path: Some(path.clone()),
                    writer: writer.clone(),
                    ..Default::default()
                },
            )
            .await;
            let chat = id(LOCAL);
            index
                .update_from_appended_messages(&chat, &view(LOCAL), &[user("initial", EARLY)], None)
                .unwrap();
            index.flush().await.unwrap();
            let initial = tokio::fs::read(&path).await.unwrap();
            index
                .update_from_appended_messages(&chat, &view(LOCAL), &[assistant("new", LATE)], None)
                .unwrap();
            writer.0.set(Some(Fault::Rename));
            assert_eq!(
                index.flush().await.unwrap_err().to_string(),
                "refused rename"
            );
            assert_eq!(tokio::fs::read(&path).await.unwrap(), initial);
            assert_eq!(index.get_chat_metadata(&chat).unwrap().last_message, "new");
            writer.0.set(Some(Fault::DirectorySync));
            assert_eq!(
                index.flush().await.unwrap_err().to_string(),
                "directory sync unconfirmed"
            );
            let installed = tokio::fs::read(&path).await.unwrap();
            assert_ne!(installed, initial);
            index.flush().await.unwrap();
            assert_eq!(tokio::fs::read(&path).await.unwrap(), installed);
        })
        .await;
}

#[test]
fn terminal_authority_survives_clear_and_fences_late_failure_and_ledger_repair() {
    let chat = id(LOCAL);
    for outcome in [
        ChatRunOutcome::Finished,
        ChatRunOutcome::Failed,
        ChatRunOutcome::Interrupted,
    ] {
        for publish_before_clear in [false, true] {
            let outcomes = ChatActivityOutcomes::new(|_| Some("view".into()));
            let repair = outcomes.capture_repair(&chat).unwrap();
            outcomes.begin(&chat, "run");
            let failure = outcomes.capture_failure(&chat, Some("run")).unwrap();
            let terminal = outcomes.capture_terminal(&chat, "view", "run").unwrap();
            assert!(!outcomes.restore(&repair, Some(ChatRunOutcome::Failed)));
            assert!(!outcomes.fail(Some(&failure)));
            if publish_before_clear {
                assert!(outcomes.commit(Some(&terminal), outcome));
            }
            outcomes.clear(&chat, Some("run"));
            assert!(!outcomes.commit(Some(&terminal), outcome));
            assert!(outcomes.capture_failure(&chat, Some("run")).is_none());
            assert_eq!(outcomes.get(&chat), None);
        }
    }
}

#[test]
fn replacement_retires_runs_and_late_publication_cannot_replace_the_successor() {
    let chat = id(LOCAL);
    let view = Rc::new(RefCell::new(None));
    let source = view.clone();
    let outcomes = ChatActivityOutcomes::new(move |_| source.borrow().clone());
    outcomes.begin(&chat, "not-adopted");
    outcomes.invalidate_view(&chat);
    view.replace(Some("view-1".into()));
    assert!(
        outcomes
            .capture_failure(&chat, Some("not-adopted"))
            .is_none()
    );
    outcomes.begin(&chat, "first");
    outcomes.clear(&chat, None);
    assert!(outcomes.fail(outcomes.capture_failure(&chat, Some("first")).as_ref()));
    let original = outcomes.capture_terminal(&chat, "view-1", "first").unwrap();
    view.replace(Some("view-2".into()));
    outcomes.invalidate_view(&chat);
    outcomes.begin(&chat, "first");
    assert!(
        outcomes
            .capture_terminal(&chat, "view-2", "first")
            .is_none()
    );
    outcomes.begin(&chat, "second");
    let successor = outcomes
        .capture_terminal(&chat, "view-2", "second")
        .unwrap();
    assert!(outcomes.commit(Some(&successor), ChatRunOutcome::Finished));
    assert!(!outcomes.commit(Some(&original), ChatRunOutcome::Failed));
    assert!(outcomes.capture_failure(&chat, Some("first")).is_none());
    assert_eq!(outcomes.get(&chat), Some(ChatRunOutcome::Finished));
    outcomes.delete(&chat);
    assert!(!outcomes.commit(Some(&successor), ChatRunOutcome::Finished));
    assert!(outcomes.fail(outcomes.capture_failure(&chat, Some("new")).as_ref()));
}
