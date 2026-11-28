use std::{
    cell::{Cell, RefCell},
    error::Error,
    io,
    path::{Path, PathBuf},
    rc::Rc,
};

use async_trait::async_trait;
use futures::FutureExt;
use garcon_base::{
    domain_error::{DomainError, as_domain_error},
    json_file_store::JsonFileStore,
    keyed_lock::KeyedLock,
    ticket_error::TicketDomainError,
};
use garcon_chats::{
    chat_parent_mutation_service::ChatParentMutationService,
    chat_tag_mutation_service::{
        ChatBoardDomainError, ChatTagMutationService, TagArchiveState, TagBoardCatalog,
        TagCatalogLease,
    },
    registry_contracts::ChatRegistrySnapshot,
    store::{
        ChatRegistry, ChatRegistryOptions, ChatRemovalReason, NewChatRegistryEntry, RegistryEvent,
        RegistryWriteFailure, RegistryWriter,
    },
};
use garcon_contract::{
    chat_boards::{
        ChatBoard, ChatBoardCatalog, ChatBoardColumn, ChatBoardColumnRule, ChatBoardMatchMode,
    },
    chat_id::{ChatId, parse_chat_id},
    chat_parent_contracts::SetChatParentRequest,
    chat_tag_mutations::{
        ApplyChatTagDeltaRequest, ChatTagTransitionTarget, ReplaceChatTagsRequest,
        TransitionChatTagsRequest,
    },
    chat_tags_contracts::SetChatTagsRequest,
    error_codes::ErrorCode,
    preambles::ChatPreambleSelection,
    project_resolution::ProjectUnavailableReason,
    tickets::TicketErrorCode,
};
use serde_json::json;
use tokio::{
    sync::{Mutex, MutexGuard, oneshot},
    task::LocalSet,
};

const A: &str = "1783725900000200";
const B: &str = "1783725900000201";
const C: &str = "1783725900000202";
const D: &str = "1783725900000203";
const MISSING: &str = "1783725900000204";

type BoxError = Box<dyn Error>;
type WriteGate = (oneshot::Sender<()>, oneshot::Receiver<()>);

fn id(chat_id: &str) -> ChatId {
    parse_chat_id(&json!(chat_id)).unwrap()
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).into()).collect()
}

fn add(registry: &Rc<ChatRegistry>, chat_id: &str, parent: Option<&str>, tags: &[&str]) {
    let mut new = NewChatRegistryEntry::new(
        id(chat_id),
        "codex".into(),
        "fixture-model".into(),
        "/workspace/project".into(),
        ChatPreambleSelection {
            revision: 0,
            ordered_preamble_ids: Vec::new(),
        },
    );
    new.entry.parent_chat_id = parent.map(id);
    new.entry.tags = strings(tags);
    registry.add_chat(new).unwrap();
}

#[derive(Default)]
struct Writer {
    fault: Cell<Option<bool>>,
    gate: RefCell<Option<WriteGate>>,
    writes: Cell<usize>,
}

#[async_trait(?Send)]
impl RegistryWriter for Writer {
    async fn write(
        &self,
        path: &Path,
        snapshot: &ChatRegistrySnapshot,
    ) -> Result<(), RegistryWriteFailure> {
        self.writes.set(self.writes.get() + 1);
        let gate = self.gate.borrow_mut().take();
        if let Some((entered, proceed)) = gate {
            entered.send(()).unwrap();
            proceed.await.unwrap();
        }
        let renamed = self.fault.get();
        if renamed != Some(false) {
            JsonFileStore::default().write(path, snapshot).await?;
        }
        match renamed {
            None => Ok(()),
            Some(renamed) => Err(RegistryWriteFailure {
                renamed,
                cause: Box::new(io::Error::other("synthetic write fault")),
            }),
        }
    }
}

struct Fixture {
    workspace: tempfile::TempDir,
    registry: Rc<ChatRegistry>,
    lock: Rc<KeyedLock>,
    writer: Rc<Writer>,
}

impl Fixture {
    async fn new() -> Self {
        let root = PathBuf::from(std::env::var_os("HOME").unwrap()).join("tmp/interface");
        std::fs::create_dir_all(&root).unwrap();
        let workspace = tempfile::Builder::new()
            .prefix("chat-mutation-")
            .tempdir_in(root)
            .unwrap();
        let writer = Rc::new(Writer::default());
        let registry = ChatRegistry::open_with_options(
            workspace.path(),
            ChatRegistryOptions {
                writer: writer.clone(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        Self {
            workspace,
            registry,
            lock: Rc::new(KeyedLock::new()),
            writer,
        }
    }

    fn tag_service(&self, boards: Rc<Boards>, archive: Rc<Archive>) -> Rc<ChatTagMutationService> {
        ChatTagMutationService::new(self.registry.clone(), self.lock.clone(), boards, archive)
    }

    fn parent_service(&self) -> Rc<ChatParentMutationService> {
        Rc::new(ChatParentMutationService::new(
            self.registry.clone(),
            self.lock.clone(),
        ))
    }

    fn hold_write(&self) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (entered, at_write) = oneshot::channel();
        let (release, proceed) = oneshot::channel();
        self.writer.gate.replace(Some((entered, proceed)));
        (at_write, release)
    }
}

struct Boards(Mutex<ChatBoardCatalog>);

impl Boards {
    fn new(target: ChatBoardMatchMode) -> Rc<Self> {
        Rc::new(Self(Mutex::new(ChatBoardCatalog {
            revision: 4,
            boards: vec![ChatBoard {
                id: "board".into(),
                name: "Delivery".into(),
                columns: vec![
                    ChatBoardColumn {
                        id: "source".into(),
                        name: "Queue".into(),
                        rule: ChatBoardColumnRule {
                            r#match: ChatBoardMatchMode::Any,
                            tags: strings(&["ready", "triage"]),
                        },
                    },
                    ChatBoardColumn {
                        id: "target".into(),
                        name: "Review".into(),
                        rule: ChatBoardColumnRule {
                            r#match: target,
                            tags: strings(&["review", "testing"]),
                        },
                    },
                ],
            }],
        })))
    }
}

struct Lease<'a>(MutexGuard<'a, ChatBoardCatalog>);

impl TagCatalogLease for Lease<'_> {
    fn catalog(&self) -> &ChatBoardCatalog {
        &self.0
    }
}

#[async_trait(?Send)]
impl TagBoardCatalog for Boards {
    async fn acquire_revision(
        &self,
        expected: u64,
    ) -> Result<Box<dyn TagCatalogLease + '_>, BoxError> {
        let guard = self.0.lock().await;
        if guard.revision != expected {
            let mut error = ChatBoardDomainError::new(
                "CHAT_BOARD_REVISION_CONFLICT",
                "stale catalog",
                409,
                true,
            );
            error.catalog = Some(guard.clone());
            return Err(error.into());
        }
        Ok(Box::new(Lease(guard)))
    }
}

#[derive(Default)]
struct Archive {
    archived: Cell<bool>,
    uncertain: Cell<bool>,
}

#[async_trait(?Send)]
impl TagArchiveState for Archive {
    async fn confirm_archive_state(&self, _chat_id: &str) -> Result<bool, BoxError> {
        if self.uncertain.get() {
            return Err(io::Error::other("unarchive unconfirmed").into());
        }
        Ok(self.archived.get())
    }
}

fn domain(error: BoxError) -> Box<ChatBoardDomainError> {
    error.downcast().unwrap()
}

fn parent_code(error: BoxError) -> ErrorCode {
    as_domain_error(error.as_ref()).unwrap().code
}

fn transition(tags: &[&str], target: ChatTagTransitionTarget) -> TransitionChatTagsRequest {
    TransitionChatTagsRequest {
        chat_id: A.into(),
        board_id: "board".into(),
        source_column_id: "source".into(),
        target,
        expected_catalog_revision: 4,
        expected_tags: strings(tags),
    }
}

fn column(selected: Option<&[&str]>) -> ChatTagTransitionTarget {
    ChatTagTransitionTarget::Column {
        column_id: "target".into(),
        selected_target_tags: selected.map(strings),
    }
}

fn set_tags(tags: &[&str]) -> SetChatTagsRequest {
    SetChatTagsRequest {
        chat_id: A.into(),
        tags: strings(tags),
    }
}

fn parent(chat_id: &str, parent_id: Option<&str>) -> SetChatParentRequest {
    SetChatParentRequest {
        chat_id: id(chat_id),
        parent_chat_id: parent_id.map(id),
    }
}

#[tokio::test]
async fn tag_updates_converge_and_compare_the_latest_locked_baseline() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            add(&fixture.registry, A, None, &["project", "ready"]);
            fixture.registry.flush().await.unwrap();
            let service = fixture.tag_service(
                Boards::new(ChatBoardMatchMode::All),
                Rc::new(Archive::default()),
            );
            let fault = domain(
                service
                    .replace(ReplaceChatTagsRequest {
                        chat_id: A.into(),
                        expected_tags: strings(&["stale"]),
                        tags: strings(&["review"]),
                    })
                    .await
                    .unwrap_err(),
            );
            assert_eq!(fault.code, "CHAT_TAG_REVISION_CONFLICT");
            assert_eq!(fault.current_tags.unwrap(), ["project", "ready"]);

            let (first, second) = tokio::join!(
                service.apply_delta(ApplyChatTagDeltaRequest {
                    chat_id: A.into(),
                    add_tags: Some(strings(&["urgent"])),
                    remove_tags: None,
                }),
                service.apply_delta(ApplyChatTagDeltaRequest {
                    chat_id: A.into(),
                    add_tags: Some(strings(&["review"])),
                    remove_tags: Some(strings(&["ready"])),
                })
            );
            first.unwrap();
            second.unwrap();
            assert_eq!(
                fixture.registry.get_chat(A).unwrap().tags,
                ["project", "review", "urgent"]
            );

            let (x, y, z) = tokio::join!(
                service.set(set_tags(&["Other"])),
                service.set(set_tags(&["Review"])),
                service.set(set_tags(&["review"]))
            );
            assert_eq!(
                [x.unwrap().changed, y.unwrap().changed, z.unwrap().changed],
                [true, true, false]
            );
            assert_eq!(fixture.writer.writes.get(), 5);
            let opened = ChatRegistry::open(fixture.workspace.path()).await.unwrap();
            assert_eq!(opened.get_chat(A).unwrap().tags, ["review"]);
        })
        .await;
}

#[tokio::test]
async fn transition_requires_the_catalog_baseline_exact_any_tags_and_confirmed_archive_state() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            let before = ["project", "ready", "triage"];
            add(&fixture.registry, A, None, &before);
            fixture.registry.flush().await.unwrap();
            let archive = Rc::new(Archive::default());
            let service =
                fixture.tag_service(Boards::new(ChatBoardMatchMode::Any), archive.clone());
            let mut stale = transition(&before, column(Some(&["review"])));
            stale.expected_catalog_revision -= 1;
            let error = domain(service.transition(stale).await.unwrap_err());
            assert_eq!(error.code, "CHAT_BOARD_REVISION_CONFLICT");
            assert_eq!(error.catalog.unwrap().revision, 4);
            assert_eq!(error.current_tags.unwrap(), before);
            let error = domain(
                service
                    .transition(transition(&["stale"], column(Some(&["review"]))))
                    .await
                    .unwrap_err(),
            );
            assert_eq!(error.code, "CHAT_TAG_REVISION_CONFLICT");
            assert_eq!(error.catalog.unwrap().revision, 4);
            for invalid in [
                None,
                Some(&["Review"][..]),
                Some(&["outside"][..]),
                Some(&["testing", "review"][..]),
            ] {
                let error = domain(
                    service
                        .transition(transition(&before, column(invalid)))
                        .await
                        .unwrap_err(),
                );
                assert_eq!(error.code, "CHAT_BOARD_TRANSITION_INVALID");
            }
            archive.uncertain.set(true);
            assert_eq!(
                service
                    .transition(transition(&before, column(Some(&["review"]))))
                    .await
                    .unwrap_err()
                    .to_string(),
                "unarchive unconfirmed"
            );
            archive.uncertain.set(false);
            archive.archived.set(true);
            let error = domain(
                service
                    .transition(transition(&before, column(Some(&["review"]))))
                    .await
                    .unwrap_err(),
            );
            assert_eq!(error.code, "CHAT_BOARD_TRANSITION_CHAT_ARCHIVED");
            assert_eq!(fixture.writer.writes.get(), 1);

            archive.archived.set(false);
            let result = service
                .transition(transition(&before, column(Some(&["review"]))))
                .await
                .unwrap();
            assert_eq!(result.tags, ["project", "review"]);
            assert_eq!(result.added_tags, ["review"]);
            assert_eq!(result.removed_tags, ["ready", "triage"]);
            service.set(set_tags(&before)).await.unwrap();
            assert_eq!(
                service
                    .transition(transition(&before, ChatTagTransitionTarget::None))
                    .await
                    .unwrap()
                    .tags,
                ["project"]
            );
            service.set(set_tags(&before)).await.unwrap();
            let all = fixture.tag_service(Boards::new(ChatBoardMatchMode::All), archive);
            let result = all
                .transition(transition(&before, column(Some(&["ignored"]))))
                .await
                .unwrap();
            assert_eq!(result.tags, ["project", "review", "testing"]);
            assert_eq!(result.removed_tags, ["ready", "triage"]);
        })
        .await;
}

#[tokio::test]
async fn tag_durability_fences_even_noops_until_explicit_recovery() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            add(&fixture.registry, A, None, &["ready"]);
            fixture.registry.flush().await.unwrap();
            let service = fixture.tag_service(
                Boards::new(ChatBoardMatchMode::All),
                Rc::new(Archive::default()),
            );
            fixture.writer.fault.set(Some(false));
            let error = domain(service.set(set_tags(&["review"])).await.unwrap_err());
            assert_eq!(error.code, "CHAT_TAG_SAVE_FAILED");
            assert!(error.retryable);
            assert_eq!(fixture.registry.get_chat(A).unwrap().tags, ["ready"]);
            fixture.writer.fault.set(Some(true));
            let error = domain(service.set(set_tags(&["review"])).await.unwrap_err());
            assert_eq!(error.code, "CHAT_TAG_SAVE_UNKNOWN");
            assert!(!error.retryable);
            let writes = fixture.writer.writes.get();
            assert_eq!(
                domain(service.set(set_tags(&["review"])).await.unwrap_err()).code,
                "CHAT_TAG_SAVE_UNKNOWN"
            );
            assert_eq!(fixture.writer.writes.get(), writes);
            let error = domain(service.recover(A).await.unwrap_err());
            assert_eq!(error.code, "CHAT_TAG_SAVE_UNKNOWN");
            assert!(error.retryable);
            fixture.writer.fault.set(None);
            assert_eq!(service.recover(A).await.unwrap().tags, ["review"]);
            assert!(!service.set(set_tags(&["review"])).await.unwrap().changed);
        })
        .await;
}

#[tokio::test]
async fn cancelled_transition_keeps_the_catalog_and_chat_locks_until_the_write_settles() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            add(&fixture.registry, A, None, &["ready"]);
            fixture.registry.flush().await.unwrap();
            let boards = Boards::new(ChatBoardMatchMode::All);
            let service = fixture.tag_service(boards.clone(), Rc::new(Archive::default()));
            let (at_write, release) = fixture.hold_write();
            let request = tokio::task::spawn_local(async move {
                service
                    .transition(transition(&["ready"], column(None)))
                    .await
            });
            at_write.await.unwrap();
            request.abort();
            assert!(request.await.unwrap_err().is_cancelled());
            assert!(
                boards.0.try_lock().is_err(),
                "catalog changed while the registry write was paused"
            );
            let lock = fixture.lock.clone();
            let (attempted, waiting) = oneshot::channel();
            let mut deletion = tokio::task::spawn_local(async move {
                attempted.send(()).unwrap();
                lock.run_exclusive_many(&[&format!("chat:{A}")], || async {})
                    .await;
            });
            waiting.await.unwrap();
            assert!(
                (&mut deletion).now_or_never().is_none(),
                "chat lock released while the registry write was paused"
            );
            release.send(()).unwrap();
            deletion.await.unwrap();
            assert_eq!(boards.0.lock().await.revision, 4);
            assert_eq!(
                fixture.registry.get_chat(A).unwrap().tags,
                ["review", "testing"]
            );
        })
        .await;
}

#[tokio::test]
async fn parent_updates_report_durability_then_recover_and_emit_only_retained_changes() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            add(&fixture.registry, A, Some(MISSING), &[]);
            add(&fixture.registry, B, None, &[]);
            add(&fixture.registry, C, None, &[]);
            fixture.registry.flush().await.unwrap();
            let events = Rc::new(RefCell::new(Vec::new()));
            let listener = events.clone();
            fixture.registry.subscribe(Rc::new(move |event| {
                if let RegistryEvent::ChatParentUpdated(id) = event {
                    listener.borrow_mut().push(id.clone());
                }
                Ok(())
            }));
            let service = fixture.parent_service();
            assert!(!service.set(parent(A, Some(MISSING))).await.unwrap().changed);
            assert_eq!(
                parent_code(service.set(parent(MISSING, Some(A))).await.unwrap_err()).as_str(),
                "SESSION_NOT_FOUND"
            );
            fixture.writer.fault.set(Some(false));
            let rejected = service.set(parent(A, Some(B))).await.unwrap_err();
            let rejected = as_domain_error(rejected.as_ref()).unwrap();
            assert_eq!(rejected.code.as_str(), "CHAT_PARENT_SAVE_FAILED");
            assert!(rejected.retryable);
            assert_eq!(
                fixture.registry.get_chat(A).unwrap().parent_chat_id,
                Some(id(MISSING))
            );
            assert!(events.borrow().is_empty());

            fixture.writer.fault.set(Some(true));
            for target in [B, C] {
                assert_eq!(
                    parent_code(service.set(parent(A, Some(target))).await.unwrap_err()).as_str(),
                    "CHAT_PARENT_SAVE_UNKNOWN"
                );
            }
            assert_eq!(
                fixture.registry.get_chat(A).unwrap().parent_chat_id,
                Some(id(B))
            );
            assert_eq!(*events.borrow(), [id(A)]);
            fixture.writer.fault.set(None);
            assert!(!service.set(parent(A, Some(B))).await.unwrap().changed);
            assert!(service.set(parent(A, Some(C))).await.unwrap().changed);
            let opened = ChatRegistry::open(fixture.workspace.path()).await.unwrap();
            assert_eq!(opened.get_chat(A).unwrap().parent_chat_id, Some(id(C)));
            assert!(service.set(parent(A, None)).await.unwrap().changed);
            assert_eq!(*events.borrow(), [id(A), id(A), id(A)]);
        })
        .await;
}

#[tokio::test]
async fn parent_validation_runs_inside_endpoint_locks_and_serializes_longer_cycles() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            add(&fixture.registry, A, None, &[]);
            add(&fixture.registry, B, Some(C), &[]);
            add(&fixture.registry, C, None, &[]);
            add(&fixture.registry, D, Some(A), &[]);
            fixture.registry.flush().await.unwrap();
            let service = fixture.parent_service();
            let (at_write, release) = fixture.hold_write();
            let first = service.clone();
            let first =
                tokio::task::spawn_local(async move { first.set(parent(A, Some(B))).await });
            at_write.await.unwrap();
            let second = service.clone();
            let second =
                tokio::task::spawn_local(async move { second.set(parent(C, Some(D))).await });
            release.send(()).unwrap();
            assert!(first.await.unwrap().unwrap().changed);
            assert_eq!(
                parent_code(second.await.unwrap().unwrap_err()).as_str(),
                "CHAT_PARENT_CYCLE"
            );
            assert!(
                fixture
                    .registry
                    .get_chat(C)
                    .unwrap()
                    .parent_chat_id
                    .is_none()
            );

            let (entered, in_lock) = oneshot::channel();
            let (release, proceed) = oneshot::channel();
            let lock = fixture.lock.clone();
            let registry = fixture.registry.clone();
            let deletion = tokio::task::spawn_local(async move {
                lock.run_exclusive_many(&[&format!("chat:{D}")], || async move {
                    entered.send(()).unwrap();
                    proceed.await.unwrap();
                    registry
                        .remove_chat(D, ChatRemovalReason::UserDeletion)
                        .unwrap();
                })
                .await;
            });
            in_lock.await.unwrap();
            let pending =
                tokio::task::spawn_local(async move { service.set(parent(C, Some(D))).await });
            release.send(()).unwrap();
            deletion.await.unwrap();
            assert_eq!(
                parent_code(pending.await.unwrap().unwrap_err()).as_str(),
                "PARENT_CHAT_NOT_FOUND"
            );
        })
        .await;
}

#[tokio::test]
async fn service_errors_preserve_domain_subclasses_thrown_by_a_registry_listener() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new().await;
            add(&fixture.registry, A, None, &[]);
            add(&fixture.registry, B, None, &[]);
            let next = Rc::new(RefCell::new(None::<BoxError>));
            let listener = next.clone();
            fixture.registry.subscribe(Rc::new(move |event| {
                if matches!(
                    event,
                    RegistryEvent::ChatParentUpdated(_) | RegistryEvent::ChatTagsUpdated(_)
                ) && let Some(error) = listener.borrow_mut().take()
                {
                    return Err(error);
                }
                Ok(())
            }));
            let service = fixture.parent_service();
            let errors: [(BoxError, _); 4] = [
                (
                    DomainError::new(ErrorCode::SESSION_BUSY, "busy", 409, false).into(),
                    ErrorCode::SESSION_BUSY,
                ),
                (
                    DomainError::new_validation("invalid").into(),
                    ErrorCode::VALIDATION_FAILED,
                ),
                (
                    DomainError::new_project_unavailable(
                        "/project",
                        ProjectUnavailableReason::NotFound,
                    )
                    .into(),
                    ErrorCode::PROJECT_UNAVAILABLE,
                ),
                (
                    TicketDomainError::new(
                        TicketErrorCode::try_from(ErrorCode::TICKET_NOT_FOUND).unwrap(),
                        "missing ticket",
                        None,
                        None,
                    )
                    .into(),
                    ErrorCode::TICKET_NOT_FOUND,
                ),
            ];
            for ((thrown, expected), target) in
                errors.into_iter().zip([Some(B), None, Some(B), None])
            {
                let name = as_domain_error(thrown.as_ref()).unwrap().kind.name();
                next.replace(Some(thrown));
                let error = service.set(parent(A, target)).await.unwrap_err();
                let actual = as_domain_error(error.as_ref()).unwrap();
                assert_eq!(actual.code, expected);
                assert_eq!(actual.kind.name(), name);
                assert_eq!(
                    error.is::<TicketDomainError>(),
                    expected == ErrorCode::TICKET_NOT_FOUND
                );
                assert_eq!(
                    fixture.registry.get_chat(A).unwrap().parent_chat_id,
                    target.map(id)
                );
            }
            next.replace(Some(
                ChatBoardDomainError::new(
                    "CHAT_BOARD_REVISION_CONFLICT",
                    "board listener",
                    409,
                    true,
                )
                .into(),
            ));
            let tags = fixture.tag_service(
                Boards::new(ChatBoardMatchMode::All),
                Rc::new(Archive::default()),
            );
            let error = domain(tags.set(set_tags(&["review"])).await.unwrap_err());
            assert_eq!(error.message, "board listener");
            assert_eq!(fixture.registry.get_chat(A).unwrap().tags, ["review"]);
        })
        .await;
}
