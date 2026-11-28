use std::cell::Cell;
use std::path::Path;

use async_trait::async_trait;
use futures::TryStreamExt;
use garcon_contract::agent_integration::AgentSettingsEnvelope;
use garcon_contract::chat_types::ChatMessage;
use garcon_contract::file_mention_context::FILE_CONTEXT_SEPARATOR;
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::host::AgentLegacyDirectoryClaim;
use garcon_interface::native_history::{
    AgentHistoryImport, AgentHistoryImportRequest, AgentNativeSessionAccess,
    AgentNativeSessionReleaseReason, AgentNativeSessionReleaseRequest,
};
use garcon_interface::transcript::{AgentChatReference, AgentTranscriptSourceLocation};
use tokio::task::LocalSet;

use super::*;
use crate::direct::native_session::DirectNativeSessions;

const NOW: &str = "2026-01-02T03:04:05.678Z";
const ID: &str = "12345678-1234-4234-8234-123456789abc";
const OTHER_ID: &str = "67891234-1234-4234-8234-123456789abc";
const OWNER: &str = "synthetic-provider";

struct Storage {
    root: String,
    opens: Cell<usize>,
    fail_once: Cell<bool>,
}

#[async_trait(?Send)]
impl AgentScopedStorage for Storage {
    fn root_directory(&self) -> &str {
        &self.root
    }
    async fn directory(&self, namespace: &str) -> ExecutorResult<String> {
        self.opens.set(self.opens.get() + 1);
        assert_eq!(namespace, DIRECT_SESSION_NAMESPACE);
        if self.fail_once.replace(false) {
            return Err("temporary storage failure".into());
        }
        let path = native::join(&[&self.root, namespace]);
        fs::create_dir_all(&path).await?;
        Ok(path)
    }
    async fn claim_legacy_workspace_directory(
        &self,
        _: &str,
    ) -> ExecutorResult<AgentLegacyDirectoryClaim> {
        Err("unexpected legacy claim".into())
    }
}

pub(in crate::direct) struct Fixture {
    _root: tempfile::TempDir,
    pub store: DirectSessionStore,
    file: String,
    reads: Rc<Cell<usize>>,
    syncs: Rc<Cell<usize>>,
    storage: Rc<Storage>,
}

impl Fixture {
    pub(in crate::direct) fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let storage = Rc::new(Storage {
            root: root.path().to_str().unwrap().into(),
            opens: Cell::new(0),
            fail_once: Cell::new(false),
        });
        let file = session_file_path(
            &native::join(&[&storage.root, DIRECT_SESSION_NAMESPACE]),
            ID,
        );
        let reads = Rc::new(Cell::new(0));
        let syncs = Rc::new(Cell::new(0));
        let store = DirectSessionStore::new(DirectSessionStoreOptions {
            agent_id: OWNER.into(),
            storage: storage.clone(),
            now: Some(Rc::new(|| Ok(NOW.into()))),
            read_file: Some(Rc::new({
                let reads = reads.clone();
                move |file| {
                    reads.set(reads.get() + 1);
                    Box::pin(async move {
                        let mut contents = Vec::new();
                        file.read_to_end(&mut contents).await?;
                        Ok(contents)
                    })
                }
            })),
            sync_directory: Some(Rc::new({
                let syncs = syncs.clone();
                move |path| {
                    syncs.set(syncs.get() + 1);
                    Box::pin(async move { Ok(sync_directory(path).await?) })
                }
            })),
        });
        Self {
            _root: root,
            store,
            file,
            reads,
            syncs,
            storage,
        }
    }

    async fn create(&self) -> DirectSessionSnapshot {
        self.store.create(user("run-1", "first")).await.unwrap()
    }
}

fn user(run: &str, content: &str) -> DirectUserInput {
    DirectUserInput {
        session_id: ID.into(),
        run_id: run.into(),
        content: content.into(),
        attachments: Vec::new(),
    }
}

fn answer(run: &str) -> DirectAssistantInput {
    DirectAssistantInput {
        session_id: ID.into(),
        run_id: run.into(),
        content: "answer".into(),
        checkpoint: None,
    }
}

fn checkpoint() -> DirectResponsesCheckpointV1 {
    DirectResponsesCheckpointV1 {
        response_id: "response".into(),
        endpoint_id: "endpoint".into(),
        endpoint_fingerprint: "a".repeat(64),
        model: "model".into(),
    }
}

#[tokio::test]
async fn creates_private_jsonl_and_round_trips_turns_and_responses_checkpoint() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new();
        let initial = fixture.create().await;
        assert_eq!(fixture.syncs.get(), 1);
        assert_eq!(initial.path, fixture.file);
        assert_eq!(initial.header.created_at, NOW);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&fixture.file).await.unwrap().permissions().mode() & 0o777, 0o600);
        }
        let data = fs::read_to_string(&fixture.file).await.unwrap();
        assert_eq!(data, format!("{{\"type\":\"session\",\"schemaVersion\":1,\"ownerId\":\"{OWNER}\",\"sessionId\":\"{ID}\",\"createdAt\":\"{NOW}\"}}\n{{\"type\":\"user\",\"at\":\"{NOW}\",\"runId\":\"run-1\",\"content\":\"first\",\"attachments\":[]}}\n"));
        let assistant = fixture.store.append_assistant(DirectAssistantInput { checkpoint: Some(checkpoint()), ..answer("run-1") }).await.unwrap();
        let next = fixture.store.append_user(user("run-2", "second")).await.unwrap();
        assert_eq!(fixture.reads.get(), 0);
        assert_eq!(fixture.syncs.get(), 1);
        let snapshot = fixture.store.load(ID).await.unwrap();
        assert_eq!(fixture.reads.get(), 1);
        assert_eq!(snapshot.records, [initial.records[0].clone(), DirectSessionRecordV1::Assistant(assistant), DirectSessionRecordV1::User(next)]);
        assert!(fixture.store.create(user("other", "should never replace")).await.is_err());
        assert_eq!(fixture.store.load(ID).await.unwrap(), snapshot);
    }).await;
}

#[tokio::test]
async fn revalidates_append_state_after_the_file_is_replaced() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            fixture.create().await;
            let before = fs::read_to_string(&fixture.file).await.unwrap();
            fs::rename(&fixture.file, format!("{}.old", fixture.file))
                .await
                .unwrap();
            fs::write(&fixture.file, before.replace("run-1", "run-z"))
                .await
                .unwrap();
            let error = fixture
                .store
                .append_assistant(answer("run-1"))
                .await
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                "Direct assistant record has no preceding user record"
            );
            fixture
                .store
                .append_assistant(answer("run-z"))
                .await
                .unwrap();
            assert_eq!(fixture.reads.get(), 1);
            assert_eq!(fixture.store.load(ID).await.unwrap().records.len(), 2);
        })
        .await;
}

#[tokio::test]
async fn separates_a_valid_unterminated_record_and_truncates_an_invalid_tail_only_on_append() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new();
        fixture.create().await;
        let original = fs::read_to_string(&fixture.file).await.unwrap();
        let valid_tail = format!("{original}{{\"type\":\"assistant\",\"at\":\"{NOW}\",\"runId\":\"run-1\",\"content\":\"answer\",\"checkpoint\":null}}");
        fs::write(&fixture.file, &valid_tail).await.unwrap();
        assert_eq!(fixture.store.load(ID).await.unwrap().records.len(), 2);
        fixture.store.append_user(user("run-2", "second")).await.unwrap();
        assert!(fs::read_to_string(&fixture.file).await.unwrap().starts_with(&format!("{valid_tail}\n")));
        for tail in ["{partial", valid_tail.strip_prefix(&original).unwrap()] {
            let bytes = format!("{original}{}{tail}", if tail == "{partial" { String::new() } else { format!("{tail}\n") });
            let expected_count = if tail == "{partial" { 1 } else { 2 };
            fs::write(&fixture.file, &bytes).await.unwrap();
            assert_eq!(fixture.store.load(ID).await.unwrap().records.len(), expected_count);
            assert_eq!(fs::read_to_string(&fixture.file).await.unwrap(), bytes);
            fixture.store.append_user(user("rewrite", "third")).await.unwrap();
            assert_eq!(fixture.store.load(ID).await.unwrap().records.len(), expected_count + 1);
            assert!(!fs::read_to_string(&fixture.file).await.unwrap().contains("{partial"));
        }
    }).await;
}

#[tokio::test]
async fn fails_closed_on_invalid_complete_records_and_keeps_genuine_replacement_characters() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new();
        fixture.create().await;
        let original = fs::read_to_string(&fixture.file).await.unwrap();
        let (header, user_line) = original.split_once('\n').unwrap();
        let extras = user_line.replacen("\"attachments\":[]", "\"attachments\":[{\"kind\":\"image\",\"data\":\"data\",\"name\":\"\\udc00\",\"mimeType\":\"image/png\"}]", 1);
        for (bytes, message) in [
            (format!("{original}{{malformed}}\n"), "Direct session record 3 is malformed"),
            (format!("{header}\n{}", user_line.replace("first", "\\ud800")), "Direct session content is invalid"),
            (format!("{header}\n{extras}"), "Direct user attachment name contains malformed Unicode"),
            (format!("{header}\n{}", user_line.replace(NOW, "yesterday")), "Direct session at is invalid"),
            (format!("{original}{user_line}"), "Direct session contains a duplicate user run"),
        ] {
            fs::write(&fixture.file, &bytes).await.unwrap();
            assert_eq!(fixture.store.load(ID).await.unwrap_err().to_string(), message);
            assert_eq!(fixture.store.append_user(user("next", "next")).await.unwrap_err().to_string(), message);
            assert_eq!(fs::read_to_string(&fixture.file).await.unwrap(), bytes);
        }
        fs::write(&fixture.file, original.replace("first", "\u{fffd}")).await.unwrap();
        assert_eq!(fixture.store.load(ID).await.unwrap().records.len(), 1);
    }).await;
}

#[tokio::test]
async fn bounds_inspection_and_repairs_neither_ownership_nor_a_complete_bad_record() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            fixture.create().await;
            let original = fs::read_to_string(&fixture.file).await.unwrap();
            let header = original.lines().next().unwrap();
            fs::write(&fixture.file, format!("{header}\ncorrupt\n"))
                .await
                .unwrap();
            assert_eq!(fixture.store.inspect(ID).await.unwrap(), fixture.file);
            assert_eq!(fixture.reads.get(), 0);
            assert_eq!(
                fixture.store.load(ID).await.unwrap_err().to_string(),
                "Direct session record 2 is malformed"
            );
            fs::write(
                &fixture.file,
                format!("{}\n", header.replace(OWNER, "other")),
            )
            .await
            .unwrap();
            assert_eq!(
                fixture.store.inspect(ID).await.unwrap_err().to_string(),
                "Direct session header does not match the selected session"
            );
            fs::write(
                &fixture.file,
                format!("{}\n", "x".repeat(DIRECT_SESSION_HEADER_MAX_BYTES + 1)),
            )
            .await
            .unwrap();
            assert_eq!(
                fixture.store.inspect(ID).await.unwrap_err().to_string(),
                "Direct session header exceeds the maximum size"
            );
        })
        .await;
}

#[tokio::test]
async fn binds_native_reference_to_the_exact_session_and_retries_directory_resolution() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            let reference = fixture.store.native_reference(ID).unwrap();
            assert_eq!(
                fixture
                    .store
                    .session_id_from_reference(Some(&reference), Some(ID))
                    .unwrap(),
                ID
            );
            let invalid = AgentNativeSessionRef {
                value: serde_json::json!({"sessionId": ID, "extra":true}).into(),
                ..reference.clone()
            };
            assert_eq!(
                fixture
                    .store
                    .session_id_from_reference(Some(&invalid), Some(ID))
                    .unwrap_err()
                    .to_string(),
                "Direct native session reference is invalid"
            );
            assert_eq!(
                fixture
                    .store
                    .session_id_from_reference(Some(&reference), Some(OTHER_ID))
                    .unwrap_err()
                    .to_string(),
                "Direct native session reference does not match the selected session"
            );
            assert!(fixture.store.native_reference("../escape").is_err());
            fixture.storage.fail_once.set(true);
            assert_eq!(
                fixture
                    .store
                    .create(user("run-1", "first"))
                    .await
                    .unwrap_err()
                    .to_string(),
                "temporary storage failure"
            );
            fixture.create().await;
            fixture.store.delete(ID).await.unwrap();
            fixture.store.delete(ID).await.unwrap();
            assert!(!Path::new(&fixture.file).exists());
            assert_eq!(fixture.syncs.get(), 2);
            assert_eq!(fixture.storage.opens.get(), 2);
        })
        .await;
}

#[cfg(unix)]
#[tokio::test]
async fn does_not_load_or_write_through_a_link_or_accept_a_directory() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            fixture.create().await;
            let target = format!("{}.target", fixture.file);
            fs::rename(&fixture.file, &target).await.unwrap();
            fs::symlink(&target, &fixture.file).await.unwrap();
            let before = fs::read(&target).await.unwrap();
            assert!(fixture.store.load(ID).await.is_err());
            assert!(
                fixture
                    .store
                    .append_assistant(answer("run-1"))
                    .await
                    .is_err()
            );
            assert_eq!(fs::read(&target).await.unwrap(), before);
            fs::remove_file(&fixture.file).await.unwrap();
            fs::create_dir(&fixture.file).await.unwrap();
            assert_eq!(
                fixture.store.load(ID).await.unwrap_err().to_string(),
                "Direct session source is not a regular file"
            );
        })
        .await;
}

async fn bun_snapshot(root: &str, command: &str, id: &str) -> Value {
    let output = tokio::process::Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/direct-session-file.ts"
        ))
        .args([root, command, id])
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn bun_and_rust_share_exact_session_rows_and_file_bytes() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            let original = bun_snapshot(&fixture.storage.root, "write", ID).await;
            let ours = fixture.store.load(ID).await.unwrap();
            let header = serde_json::to_value(&ours.header).unwrap();
            assert_eq!(header, original["header"]);
            assert_eq!(
                serde_json::to_value(&ours.records).unwrap(),
                original["records"]
            );
            fixture
                .store
                .append_assistant(DirectAssistantInput {
                    checkpoint: Some(checkpoint()),
                    ..answer("run-1")
                })
                .await
                .unwrap();
            let records = fixture.store.load(ID).await.unwrap().records;
            let reopened = bun_snapshot(&fixture.storage.root, "read", ID).await;
            assert_eq!(serde_json::to_value(&records).unwrap(), reopened["records"]);
            let expected_bytes = format!(
                "{}\n{}\n{}\n",
                serde_json::to_string(&header).unwrap(),
                serde_json::to_string(&records[0]).unwrap(),
                serde_json::to_string(&records[1]).unwrap()
            );
            assert_eq!(reopened["bytes"].as_str(), Some(expected_bytes.as_str()));
            assert!(
                reopened["bytes"]
                    .as_str()
                    .unwrap()
                    .starts_with(original["bytes"].as_str().unwrap())
            );
        })
        .await;
}

#[tokio::test]
async fn steps_the_parse_of_a_long_session_before_all_rows_are_ready() {
    let header = DirectSessionHeaderV1 {
        schema_version: 1,
        owner_id: OWNER.into(),
        session_id: ID.into(),
        created_at: NOW.into(),
    };
    let mut raw = serde_json::to_vec(&header).unwrap();
    raw.push(b'\n');
    for index in 0..32_000 {
        serde_json::to_writer(
            &mut raw,
            &DirectUserRecordV1 {
                at: NOW.into(),
                run_id: format!("run-{index}"),
                content: "synthetic".into(),
                attachments: Vec::new(),
            },
        )
        .unwrap();
        raw.push(b'\n');
    }
    let mut parse = std::pin::pin!(parse_session_file(&raw, OWNER, ID));
    assert!(
        futures::poll!(parse.as_mut()).is_pending(),
        "the long parse did not yield to the event loop"
    );
    assert_eq!(parse.await.unwrap().records.len(), 32_000);
}

fn import_request(store: &DirectSessionStore, id: &str) -> AgentHistoryImportRequest {
    AgentHistoryImportRequest {
        chat: AgentChatReference {
            chat_id: "synthetic-chat".into(),
            agent_id: OWNER.into(),
            agent_session_id: Some(id.into()),
            project_path: "/synthetic".into(),
            model: "model".into(),
            native_session: Some(store.native_reference(id).unwrap()),
            carry_over_revision: "seed".into(),
            native_seed_receipt: None,
            settings: AgentSettingsEnvelope {
                owner_id: OWNER.into(),
                schema_version: 1,
                values: serde_json::json!({}).into(),
            },
        },
        signal: Default::default(),
    }
}

#[tokio::test]
async fn imports_native_rows_with_attachments_and_describes_the_selected_source() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            fixture
                .store
                .create(DirectUserInput {
                    content: format!("first{FILE_CONTEXT_SEPARATOR}synthetic-file-context"),
                    attachments: vec![AgentAttachment {
                        kind: AgentAttachmentKind::Image,
                        data: "data:image/png;base64,Zml4dHVyZQ==".into(),
                        name: None,
                        mime_type: "image/png".into(),
                    }],
                    ..user("run-1", "first")
                })
                .await
                .unwrap();
            fixture
                .store
                .append_assistant(answer("run-1"))
                .await
                .unwrap();
            let facets = DirectNativeSessions(fixture.store.clone());
            let request = import_request(&fixture.store, ID);
            assert_eq!(
                facets
                    .resolve_native_session(request.clone())
                    .await
                    .unwrap(),
                request.chat.native_session
            );
            assert_eq!(
                facets.describe_source(request.clone()).await.unwrap(),
                Some(AgentTranscriptSourceLocation::FilesystemPath {
                    value: fixture.file.clone()
                })
            );
            let batches: Vec<_> = facets.load(request, None).try_collect().await.unwrap();
            assert_eq!(batches.len(), 1);
            assert_eq!(batches[0].len(), 2);
            let ChatMessage::User(row) = &batches[0][0].message else {
                panic!("expected first user row")
            };
            assert_eq!(row.timestamp, NOW);
            assert_eq!(row.content, "first");
            let image = &row.images.as_ref().unwrap()[0];
            assert_eq!(image.name, "");
            assert_eq!(image.mime_type.as_deref(), Some("image/png"));
            assert!(image.data.ends_with("Zml4dHVyZQ=="));
            let ChatMessage::Assistant(row) = &batches[0][1].message else {
                panic!("expected assistant row")
            };
            assert_eq!(row.timestamp, NOW);
            assert_eq!(row.content, "answer");
        })
        .await;
}

#[tokio::test]
async fn describes_a_corrupt_history_but_import_fails_without_echoing_and_release_is_exact() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            fixture.create().await;
            fixture
                .store
                .create(DirectUserInput {
                    session_id: OTHER_ID.into(),
                    ..user("run-2", "other")
                })
                .await
                .unwrap();
            let original = fs::read_to_string(&fixture.file).await.unwrap();
            fs::write(&fixture.file, format!("{original}{{SYNTHETIC_SENTINEL}}\n"))
                .await
                .unwrap();
            let request = import_request(&fixture.store, ID);
            let facets = DirectNativeSessions(fixture.store.clone());
            assert!(
                facets
                    .describe_source(request.clone())
                    .await
                    .unwrap()
                    .is_some()
            );
            let error = facets
                .load(request.clone(), None)
                .try_collect::<Vec<_>>()
                .await
                .unwrap_err();
            let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
            assert_eq!(
                error.code,
                AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE
            );
            assert_eq!(error.details.as_ref().unwrap()["causeName"], "TypeError");
            assert_eq!(
                error.details.as_ref().unwrap()["causeCode"],
                "INVALID_HISTORY"
            );
            assert!(!format!("{error:?}").contains("SYNTHETIC_SENTINEL"));
            let mut mismatch = request.clone();
            mismatch.chat.agent_session_id = Some(OTHER_ID.into());
            assert!(
                facets
                    .release(AgentNativeSessionReleaseRequest {
                        request: mismatch,
                        reason: AgentNativeSessionReleaseReason::Deleted
                    })
                    .await
                    .is_err()
            );
            let release = AgentNativeSessionReleaseRequest {
                request,
                reason: AgentNativeSessionReleaseReason::Deleted,
            };
            facets.release(release.clone()).await.unwrap();
            facets.release(release).await.unwrap();
            assert!(!Path::new(&fixture.file).exists());
            assert!(fixture.store.inspect(OTHER_ID).await.is_ok());
        })
        .await;
}
