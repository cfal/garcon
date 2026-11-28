use std::{
    cell::{Cell, RefCell},
    io,
    path::{Path, PathBuf},
    process::Command,
    rc::Rc,
};

use async_trait::async_trait;
use garcon_base::json_file_store::JsonFileStore;
use garcon_chats::{
    chat_id_allocator::{AllocationError, ChatIdAllocator},
    registry_contracts::{ChatRegistryEntry, ChatRegistrySnapshot},
    registry_entry_codec::normalize_chat_registry_entry,
    store::{
        ChatMutationDurability, ChatRegistry, ChatRegistryOptions, ChatRegistryPatch,
        ChatRemovalReason, NativeSessionLookupResult, NewChatRegistryEntry, ReconciledDurability,
        RegistryDurability, RegistryError, RegistryEvent, RegistryWriteFailure, RegistryWriter,
    },
};
use garcon_contract::{
    chat_id::{ChatId, parse_chat_id},
    ws_events::ChatProjectPathUpdatedPayload,
};
use garcon_js::{
    OptionalNullable,
    clock::ManualClock,
    json::{Opaque, from_str},
};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio::task::LocalSet;

const LOCAL: &str = "1783725900000200";
const REMOTE: &str = "1783725900000201";
const THIRD: &str = "1783725900000202";
const EXECUTOR: &str = "3502b645-222b-49d2-ac39-1c91f9fb1174";
const TIME: &str = "2026-01-01T00:00:00.000Z";

fn directory() -> tempfile::TempDir {
    let root = PathBuf::from(std::env::var_os("HOME").unwrap()).join("tmp/interface");
    std::fs::create_dir_all(&root).unwrap();
    tempfile::Builder::new()
        .prefix("chat-registry-")
        .tempdir_in(root)
        .unwrap()
}

fn id(chat: &str) -> ChatId {
    parse_chat_id(&json!(chat)).unwrap()
}

fn bun(workspace: &Path, mode: &str) -> Opaque {
    let response = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/registry-disk.ts"
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

fn fixture(chat: &str) -> ChatRegistryEntry {
    let opaque: Opaque =
        from_str(r#"{"b":1.0,"10":"ten","2":"two","big":9007199254740993,"exp21":1e21,"zero":-0}"#)
            .unwrap();
    let mut raw = json!({
        "agentId": "codex", "agentOwnershipEpoch": "fixture-epoch", "model": "fixture-model", "projectPath": "/workspace/project",
        "preambleSelection": { "revision": 0, "orderedPreambleIds": [] }, "parentChatId": null, "lineage": null,
        "agentSettingsById": { "codex": { "ownerId": "codex", "schemaVersion": 1 } }, "agentSessionId": "fixture-session",
        "carryOverSegments": [], "nativeSeedReceipt": null, "carryOverMigrationQuarantine": null,
    });
    raw["agentSettingsById"]["codex"]["values"] = (*opaque).clone();
    if chat == REMOTE {
        raw["executorId"] = json!(EXECUTOR);
        raw["parentChatId"] = json!(LOCAL);
        raw["lineage"] = json!({ "sourceChatId": LOCAL, "kind": "fork", "transcriptViewId": "fixture-view", "ordinal": 1 });
        raw["nativeSession"] = json!({ "ownerId": "codex", "schemaVersion": 1 });
        raw["nativeSession"]["value"] = (*opaque).clone();
        raw["apiProviderId"] = json!("fixture-provider");
        raw["modelEndpointId"] = json!("fixture-endpoint");
        raw["modelProtocol"] = json!("openai-compatible");
        raw["tags"] = json!(["fixture", "review"]);
        raw["permissionMode"] = json!("acceptEdits");
        raw["thinkingMode"] = json!("low");
        raw["pendingPreambleBoundary"] =
            json!({ "kind": "new-chat", "ownershipEpoch": "fixture-epoch" });
        raw["carryOverSegments"] = json!([{
            "id": "9df00801-0000-1000-9000-000000000009", "agentId": "codex", "model": "source-model",
            "capturedAt": TIME, "storedMessageCount": 2, "visibleMessageCount": 1, "trailingHandoff": null,
        }]);
    }
    normalize_chat_registry_entry(raw.as_object().unwrap(), chat).unwrap()
}

fn add(registry: &Rc<ChatRegistry>, chat: &str) {
    assert!(
        registry
            .add_chat(NewChatRegistryEntry {
                id: id(chat),
                entry: fixture(chat)
            })
            .unwrap()
    );
}

#[tokio::test]
async fn current_registries_interoperate_through_both_real_writers() {
    LocalSet::new()
        .run_until(async {
            let bun_directory = directory();
            let rust_directory = directory();
            let from_bun = bun(bun_directory.path(), "write");
            let bun_registry = ChatRegistry::open(bun_directory.path()).await.unwrap();
            assert!(bun_registry.loaded_from_disk());
            assert_eq!(bun_registry.list_chat_ids(), [id(LOCAL), id(REMOTE)]);
            assert!(bun_registry.has_chat(LOCAL));
            assert!(bun_registry.get_chat(REMOTE).is_some());
            assert!(!bun_registry.has_chat("toString"));
            assert!(bun_registry.get_chat("__proto__").is_none());
            assert_eq!(
                bun_registry.lookup_native_session("fixture-session", Some("codex"), None),
                NativeSessionLookupResult::Found { chat_id: id(LOCAL) }
            );
            assert_eq!(
                bun_registry.lookup_native_session(
                    "fixture-session",
                    Some("codex"),
                    Some(EXECUTOR)
                ),
                NativeSessionLookupResult::Found {
                    chat_id: id(REMOTE)
                }
            );

            let native = ChatRegistry::open(rust_directory.path()).await.unwrap();
            assert!(!native.loaded_from_disk());
            tokio::fs::write(
                rust_directory.path().join("workspace-version.json"),
                b"{\"version\":10}\n",
            )
            .await
            .unwrap();
            add(&native, LOCAL);
            add(&native, REMOTE);
            native
                .update_chat_flushed(
                    LOCAL,
                    ChatRegistryPatch {
                        last_read_at: Some(OptionalNullable::some(TIME.into())),
                        ..Default::default()
                    },
                )
                .await
                .unwrap()
                .unwrap();
            let rust_bytes = tokio::fs::read_to_string(native.path()).await.unwrap();
            assert_eq!(
                rust_bytes,
                from_bun["file"].as_str().unwrap(),
                "new entries through both writers"
            );
            let bun_reads_rust = bun(rust_directory.path(), "inspect");
            let reloaded_rust = ChatRegistry::open(rust_directory.path()).await.unwrap();
            let serialized = serde_json::to_string(&reloaded_rust.list_all_chats()).unwrap();
            assert_eq!(
                serialized,
                garcon_js::json::stringify(&bun_reads_rust["entries"])
            );
            assert_eq!(
                reloaded_rust.list_all_chats(),
                bun_registry.list_all_chats()
            );

            bun_registry
                .update_chat_phased(
                    REMOTE,
                    ChatRegistryPatch {
                        tags: Some(vec!["fixture".into(), "next".into()]),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            bun_registry.flush().await.unwrap();
            let bun_rewrites_rust = bun(rust_directory.path(), "rewrite");
            assert_eq!(
                tokio::fs::read_to_string(bun_registry.path())
                    .await
                    .unwrap(),
                bun_rewrites_rust["file"].as_str().unwrap(),
                "updated loaded entries in both directions"
            );
            let reloaded = ChatRegistry::open(rust_directory.path()).await.unwrap();
            assert_eq!(reloaded.get_chat(REMOTE).unwrap().tags, ["fixture", "next"]);
            assert_eq!(
                reloaded.get_chat(REMOTE).unwrap().parent_chat_id,
                Some(id(LOCAL))
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    reloaded.path().metadata().unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        })
        .await;
}

#[test]
fn allocation_is_monotonic_across_rollback_and_never_claims_an_existing_id() {
    let clock = Rc::new(ManualClock::new(1_783_725_900_000));
    let allocator = ChatIdAllocator::new(clock.clone());
    assert_eq!(
        allocator.allocate(|_| false).unwrap().as_str(),
        "1783725900000000"
    );
    assert_eq!(
        allocator
            .allocate(|candidate| candidate == "1783725900000001")
            .unwrap()
            .as_str(),
        "1783725900000002"
    );
    clock.advance(-1_000);
    assert!(matches!(
        allocator.allocate(|_| true),
        Err(AllocationError::Exhausted)
    ));
    assert_eq!(
        allocator.allocate(|_| false).unwrap().as_str(),
        "1783725900000003"
    );
}

#[derive(Clone, Copy)]
enum Fault {
    None,
    BeforeRename,
    AfterRename,
}

struct FaultWriter(Cell<Fault>);

#[async_trait(?Send)]
impl RegistryWriter for FaultWriter {
    async fn write(
        &self,
        path: &Path,
        snapshot: &ChatRegistrySnapshot,
    ) -> Result<(), RegistryWriteFailure> {
        let fault = self.0.replace(Fault::None);
        let fail = |renamed| RegistryWriteFailure {
            renamed,
            cause: Box::new(io::Error::other(if renamed {
                "synthetic sync failure"
            } else {
                "synthetic rename failure"
            })),
        };
        if matches!(fault, Fault::BeforeRename) {
            return Err(fail(false));
        }
        if matches!(fault, Fault::AfterRename) {
            let next = path.with_extension("fixture-tmp");
            let mut bytes = serde_json::to_vec_pretty(snapshot).unwrap();
            bytes.push(b'\n');
            tokio::fs::write(&next, bytes).await.unwrap();
            tokio::fs::rename(&next, path).await.unwrap();
            return Err(fail(true));
        }
        JsonFileStore::default().write(path, snapshot).await
    }
}

#[tokio::test]
async fn phased_faults_separate_rejected_intents_from_renamed_uncertain_candidates() {
    LocalSet::new().run_until(async {
        let directory = directory();
        let writer = Rc::new(FaultWriter(Cell::new(Fault::None)));
        let options = ChatRegistryOptions { writer: writer.clone(), ..Default::default() };
        let registry = ChatRegistry::open_with_options(directory.path(), options).await.unwrap();
        add(&registry, REMOTE);
        registry.flush().await.unwrap();
        let events = Rc::new(RefCell::new(Vec::new()));
        let sink = events.clone();
        registry.subscribe(Rc::new(move |event| { sink.borrow_mut().push(event.clone()); Ok(()) }));
        let patch = || ChatRegistryPatch { tags: Some(vec!["new-tag".into()]), api_provider_id: Some(Some("candidate-provider".into())), ..Default::default() };
        writer.0.set(Fault::BeforeRename);
        assert!(matches!(registry.update_chat_phased(REMOTE, patch()).await, Err(RegistryError::Write(error)) if !error.renamed));
        assert_eq!(registry.get_chat(REMOTE).unwrap().tags, ["fixture", "review"]);
        assert!(!registry.references_api_provider("candidate-provider"));
        assert!(events.borrow().is_empty());

        writer.0.set(Fault::AfterRename);
        assert_eq!(registry.update_chat_phased(REMOTE, patch()).await.unwrap().unwrap().durability, RegistryDurability::Unknown);
        assert_eq!(registry.chat_mutation_durability(REMOTE), ChatMutationDurability::Unknown);
        assert!(registry.references_api_provider("fixture-provider"));
        assert!(registry.references_api_provider("candidate-provider"));
        assert!(matches!(registry.update_chat_phased(REMOTE, patch()).await, Err(RegistryError::DurabilityUnknown(_))));
        assert!(matches!(&events.borrow()[..], [RegistryEvent::ChatTagsUpdated(_)]));
        assert_eq!(registry.reconcile_unknown_durability(REMOTE).await, ReconciledDurability::Confirmed);
        assert!(!registry.references_api_provider("fixture-provider"));
        assert!(registry.references_api_provider("candidate-provider"));

        writer.0.set(Fault::AfterRename);
        let observed = ChatProjectPathUpdatedPayload { chat_id: REMOTE.into(), project_path: "/workspace/next".into(), effective_project_key: "/workspace/next".into(), previous_project_path: "/workspace/project".into() };
        assert_eq!(registry.update_observed_project_path(REMOTE, observed).await.unwrap().unwrap().durability, RegistryDurability::Unknown);
        assert_eq!(registry.get_chat(REMOTE).unwrap().project_path, "/workspace/project");
        let disk: Value = from_str(&tokio::fs::read_to_string(registry.path()).await.unwrap()).unwrap();
        assert_eq!(disk["sessions"][REMOTE]["projectPath"], "/workspace/next");
        assert_eq!(events.borrow().len(), 1);
        assert_eq!(registry.reconcile_unknown_durability(REMOTE).await, ReconciledDurability::Confirmed);
        registry.remove_chat(REMOTE, ChatRemovalReason::UserDeletion).unwrap();
        assert!(registry.references_api_provider("candidate-provider"));
        registry.flush().await.unwrap();
        assert!(!registry.references_api_provider("candidate-provider"));
    }).await;
}

#[tokio::test]
async fn parent_cycles_are_rejected_and_never_rewrite_lineage_or_native_lookups() {
    LocalSet::new().run_until(async {
        let directory = directory();
        let registry = ChatRegistry::open(directory.path()).await.unwrap();
        add(&registry, LOCAL);
        add(&registry, REMOTE);
        add(&registry, THIRD);
        assert_eq!(registry.lookup_native_session("fixture-session", None, None), NativeSessionLookupResult::Ambiguous);
        let error = registry.set_delegation_parent_phased(LOCAL, Some(id(REMOTE))).await.unwrap_err();
        assert!(matches!(error, RegistryError::Domain(error) if error.code.as_str() == "CHAT_PARENT_CYCLE"));
        registry.set_delegation_parent_phased(REMOTE, None).await.unwrap().unwrap();
        let entry = registry.get_chat(REMOTE).unwrap();
        assert_eq!(entry.parent_chat_id, None);
        assert_eq!(entry.lineage.unwrap().source_chat_id, id(LOCAL));
        registry.remove_chat(THIRD, ChatRemovalReason::UserDeletion).unwrap();
        assert_eq!(registry.lookup_native_session("fixture-session", None, None), NativeSessionLookupResult::Found { chat_id: id(LOCAL) });
        registry.flush().await.unwrap();
    }).await;
}

type RenameGate = (oneshot::Sender<()>, oneshot::Receiver<()>);

#[derive(Default)]
struct PausedWriter(RefCell<Option<RenameGate>>);

#[async_trait(?Send)]
impl RegistryWriter for PausedWriter {
    async fn write(
        &self,
        path: &Path,
        snapshot: &ChatRegistrySnapshot,
    ) -> Result<(), RegistryWriteFailure> {
        let gate = self.0.take();
        if let Some((entered, proceed)) = gate {
            entered.send(()).unwrap();
            proceed.await.unwrap();
            return Err(RegistryWriteFailure {
                renamed: false,
                cause: Box::new(io::Error::other("synthetic refused rename")),
            });
        }
        JsonFileStore::default().write(path, snapshot).await
    }
}

#[tokio::test]
async fn a_late_rename_failure_cannot_roll_back_a_newer_chat_revision() {
    LocalSet::new()
        .run_until(async {
            let dir = directory();
            let writer = Rc::new(PausedWriter::default());
            let registry = ChatRegistry::open_with_options(
                dir.path(),
                ChatRegistryOptions {
                    writer: writer.clone(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            add(&registry, LOCAL);
            registry.flush().await.unwrap();
            let (entered, at_rename) = oneshot::channel();
            let (release, proceed) = oneshot::channel();
            writer.0.replace(Some((entered, proceed)));
            let updating = registry.clone();
            let rejected = tokio::task::spawn_local(async move {
                updating
                    .update_chat_flushed(
                        LOCAL,
                        ChatRegistryPatch {
                            model: Some("earlier".into()),
                            ..Default::default()
                        },
                    )
                    .await
            });
            at_rename.await.unwrap();
            assert_eq!(registry.get_chat(LOCAL).unwrap().model, "earlier");
            registry
                .update_chat(
                    LOCAL,
                    ChatRegistryPatch {
                        model: Some("newer".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
            release.send(()).unwrap();
            assert!(matches!(
                rejected.await.unwrap(),
                Err(RegistryError::Write(_))
            ));
            assert_eq!(registry.get_chat(LOCAL).unwrap().model, "newer");
            registry.flush().await.unwrap();
            assert_eq!(
                ChatRegistry::open(dir.path())
                    .await
                    .unwrap()
                    .get_chat(LOCAL)
                    .unwrap()
                    .model,
                "newer"
            );
        })
        .await;
}

#[tokio::test]
async fn malformed_or_legacy_registry_files_are_not_rewritten() {
    let dir = directory();
    let file = dir.path().join("chats.json");
    for (bytes, message) in [
        ("{invalid", "chats.json is not valid JSON"),
        (
            r#"{"version":5,"sessions":{}}"#,
            "Unsupported chat registry version: 5",
        ),
        (
            r#"{"version":6,"sessions":[]}"#,
            "Invalid chats.json: sessions must be an object",
        ),
    ] {
        tokio::fs::write(&file, bytes).await.unwrap();
        let Err(error) = ChatRegistry::open(dir.path()).await else {
            panic!("invalid registry opened")
        };
        assert_eq!(error.to_string(), message);
        assert_eq!(tokio::fs::read_to_string(&file).await.unwrap(), bytes);
    }
}
