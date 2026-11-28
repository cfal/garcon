use std::{path::Path, process::Command};

use serde_json::json;
use tokio::{sync::Notify, task::LocalSet};

use super::*;

const EPOCH: &str = "2026-11-28T10:20:30.000Z";
const ORACLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/oracles/snippets-disk.ts"
);

fn snippet(id: &str, short_name: &str) -> Snippet {
    Snippet {
        id: id.into(),
        definition: SnippetDefinitionInput {
            short_name: short_name.into(),
            template: "Synthetic {{arguments}}".into(),
            default_arguments: "default".into(),
        },
        created_at: EPOCH.into(),
        updated_at: EPOCH.into(),
    }
}

fn code(error: Box<dyn Error>) -> SnippetErrorCode {
    error.downcast_ref::<SnippetDomainError>().unwrap().code
}

fn run_bun(operation: &str, workspace: &Path) -> Value {
    let version = Command::new("bun").arg("--version").output().unwrap();
    assert_eq!(String::from_utf8_lossy(&version.stdout).trim(), "1.4.3");
    let output = Command::new("bun")
        .arg(ORACLE)
        .arg(operation)
        .arg(workspace)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn original_and_rust_read_each_others_sorted_catalog_writes() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let bun = run_bun("write", root.path());
            let store = SnippetStore::open(root.path().to_str().unwrap())
                .await
                .unwrap();
            let snapshot = store.snapshot();
            assert_eq!(serde_json::to_value(&snapshot).unwrap(), bun["snapshot"]);
            assert_eq!(snapshot.snippets[0].id, "original-2");
            assert_eq!(snapshot.snippets[1].id, "original-10");
            store.remove("original-2".into(), 2).await.unwrap();
            store
                .create(snippet("rust", "example3"), 3, || Ok(()))
                .await
                .unwrap();
            assert_eq!(store.snapshot().snippets[0].id, "rust");
            let mut definition = store.get_by_short_name("example3").unwrap().definition;
            definition.short_name = "example12".into();
            store
                .update("rust".into(), definition, EPOCH.into(), 4, || Ok(()))
                .await
                .unwrap();
            let rust = store.snapshot();
            assert_eq!(rust.revision, 5);
            assert_eq!(rust.snippets[0].id, "original-10");
            assert_eq!(rust.snippets[1].updated_at, "2026-11-28T10:20:30.001Z");
            let read = run_bun("read", root.path());
            assert_eq!(serde_json::to_value(rust).unwrap(), read["snapshot"]);
            let disk = fs::read_to_string(root.path().join("snippets.json"))
                .await
                .unwrap();
            assert!(disk.ends_with("}\n"));
            assert_eq!(disk, read["disk"].as_str().unwrap());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(root.path().join("snippets.json"))
                    .await
                    .unwrap()
                    .permissions()
                    .mode();
                assert_eq!(mode & 0o777, 0o600);
            }
        })
        .await;
}

#[tokio::test]
async fn migration_skips_invalid_and_duplicate_entries_and_initializes_blank_arguments() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("snippets.json");
    let old = json!({"version":1,"revision":9,"snippets":[
        {"id":"old","shortName":"old10","template":"Synthetic","createdAt":EPOCH,"updatedAt":EPOCH},
        {"id":"new","shortName":"old2","template":"Echo {{arguments}}","defaultArguments":"discard me","createdAt":EPOCH,"updatedAt":EPOCH},
        {"id":"dup","shortName":"old10","template":"Ignored","createdAt":EPOCH,"updatedAt":EPOCH},
        {"id":"old","shortName":"xyz","template":"Ignored","createdAt":EPOCH,"updatedAt":EPOCH},
        {"id":"invalid","shortName":"BAD NAME","template":"Ignored","createdAt":EPOCH,"updatedAt":EPOCH},
        null,
    ]});
    fs::write(&path, serde_json::to_vec(&old).unwrap())
        .await
        .unwrap();
    let store = SnippetStore::open(root.path().to_str().unwrap())
        .await
        .unwrap();
    let snapshot = store.snapshot();
    assert_eq!(snapshot.revision, 9);
    assert_eq!(snapshot.snippets.len(), 2);
    assert_eq!(snapshot.snippets[0].id, "new");
    assert_eq!(snapshot.snippets[1].id, "old");
    assert!(
        snapshot
            .snippets
            .iter()
            .all(|snippet| snippet.definition.default_arguments.is_empty())
    );
    let disk: Value = json::from_slice(&fs::read(&path).await.unwrap()).unwrap();
    assert_eq!(disk["version"], 2);
    assert_eq!(disk["revision"], 9);
    assert_eq!(
        disk["snippets"],
        serde_json::to_value(snapshot.snippets).unwrap()
    );
}

#[tokio::test]
async fn migration_never_accepts_a_malformed_short_name_after_projection() {
    let original = tempfile::tempdir().unwrap();
    let rust = tempfile::tempdir().unwrap();
    let source = r#"{"version":1,"revision":3,"snippets":[{"id":"bad","shortName":"bad\ud800","template":"Synthetic","createdAt":"2026-11-28T10:20:30.000Z","updatedAt":"2026-11-28T10:20:30.000Z"},{"id":"good","shortName":"valid","template":"Fixture","createdAt":"2026-11-28T10:20:30.000Z","updatedAt":"2026-11-28T10:20:30.000Z"}]}"#;
    let original_path = original.path().join("snippets.json");
    let rust_path = rust.path().join("snippets.json");
    fs::write(&original_path, source).await.unwrap();
    fs::write(&rust_path, source).await.unwrap();
    let bun = run_bun("read", original.path());
    let store = SnippetStore::open(rust.path().to_str().unwrap())
        .await
        .unwrap();
    let snapshot = store.snapshot();
    assert_eq!(snapshot.snippets.len(), 1);
    assert_eq!(snapshot.snippets[0].id, "good");
    assert_eq!(serde_json::to_value(snapshot).unwrap(), bun["snapshot"]);
    assert_eq!(
        fs::read(&original_path).await.unwrap(),
        fs::read(&rust_path).await.unwrap()
    );
}

#[tokio::test]
async fn count_and_revision_limits_do_not_rewrite_the_catalog() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("snippets.json");
            let entries: Vec<_> = (0..SNIPPET_MAX_COUNT)
                .map(|number| {
                    let name = format!("snippet{number}");
                    snippet(&name, &name)
                })
                .collect();
            for (revision, error) in [
                (0, SnippetErrorCode::LIMIT_REACHED),
                (MAX_REVISION, SnippetErrorCode::REVISION_EXHAUSTED),
            ] {
                let mut value = json!({"version":2,"revision":revision,"snippets":entries});
                let original = serde_json::to_vec(&value).unwrap();
                fs::write(&path, &original).await.unwrap();
                let store = SnippetStore::open(root.path().to_str().unwrap())
                    .await
                    .unwrap();
                assert_eq!(
                    code(
                        store
                            .create(snippet("new", "new"), revision, || Ok(()))
                            .await
                            .unwrap_err()
                    ),
                    error
                );
                assert_eq!(fs::read(&path).await.unwrap(), original);
                value["snippets"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::to_value(snippet("new", "new")).unwrap());
                fs::write(&path, serde_json::to_vec(&value).unwrap())
                    .await
                    .unwrap();
                let error = SnippetStore::open(root.path().to_str().unwrap())
                    .await
                    .err()
                    .unwrap();
                assert_eq!(
                    error.to_string(),
                    format!("snippets.json exceeds the maximum of {SNIPPET_MAX_COUNT} snippets")
                );
            }
        })
        .await;
}

#[tokio::test]
async fn revision_conflicts_precede_name_checks_and_rejected_writes_leave_disk_alone() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("snippets.json");
            let store = SnippetStore::open(root.path().to_str().unwrap())
                .await
                .unwrap();
            assert_eq!(store.snapshot().revision, 0);
            assert!(!path.exists());
            store
                .create(snippet("first", "catalog"), 0, || Ok(()))
                .await
                .unwrap();
            let bytes = fs::read(&path).await.unwrap();
            let first = store.get_by_short_name("catalog").unwrap();
            let error = store
                .create(snippet("second", "catalog"), 0, || {
                    panic!("do not check name for stale requests")
                })
                .await
                .unwrap_err();
            assert_eq!(
                error.downcast_ref::<SnippetDomainError>().unwrap().code,
                SnippetErrorCode::REVISION_CONFLICT
            );
            assert!(
                error
                    .downcast_ref::<SnippetDomainError>()
                    .unwrap()
                    .retryable
            );
            assert_eq!(
                code(
                    store
                        .create(snippet("second", "catalog"), 1, || panic!(
                            "do not check a locally used name"
                        ))
                        .await
                        .unwrap_err()
                ),
                SnippetErrorCode::NAME_CONFLICT
            );
            assert_eq!(
                code(
                    store
                        .create(snippet("first", "other"), 1, || Ok(()))
                        .await
                        .unwrap_err()
                ),
                SnippetErrorCode::VALIDATION_FAILED
            );
            assert_eq!(
                code(store.remove("absent".into(), 1).await.unwrap_err()),
                SnippetErrorCode::NOT_FOUND
            );
            assert_eq!(store.snapshot().snippets, [first]);
            assert_eq!(fs::read(&path).await.unwrap(), bytes);
        })
        .await;
}

struct FaultWriter {
    rename: bool,
    started: Notify,
    finished: Notify,
}

#[async_trait::async_trait(?Send)]
impl Writer for FaultWriter {
    async fn write(&self, path: &str, file: &SnippetsFile) -> Result<()> {
        self.started.notify_one();
        self.finished.notified().await;
        if self.rename {
            JsonFileStore::default().write(path, file).await?;
            Err(SnippetCatalogCommittedUnknownError("simulated sync failure".into()).into())
        } else {
            Err("simulated rename failure".into())
        }
    }
}

#[tokio::test]
async fn holds_the_mutation_lock_after_cancellation_and_fences_uncertain_writes() {
    LocalSet::new()
        .run_until(async {
            for rename in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let dir = root.path().to_str().unwrap();
                let writer = Rc::new(FaultWriter {
                    rename,
                    started: Notify::new(),
                    finished: Notify::new(),
                });
                let store = SnippetStore::open_with_writer(dir, writer.clone())
                    .await
                    .unwrap();
                let first = tokio::task::spawn_local({
                    let store = store.clone();
                    async move { store.create(snippet("new", "new"), 0, || Ok(())).await }
                });
                writer.started.notified().await;
                first.abort();
                assert!(first.await.unwrap_err().is_cancelled());
                let pending = tokio::task::spawn_local({
                    let store = store.clone();
                    async move { store.remove("absent".into(), 0).await }
                });
                tokio::task::yield_now().await;
                assert!(!pending.is_finished());
                writer.finished.notify_one();
                let expected_error = if rename {
                    SnippetErrorCode::CATALOG_SAVE_UNKNOWN
                } else {
                    SnippetErrorCode::NOT_FOUND
                };
                assert_eq!(code(pending.await.unwrap().unwrap_err()), expected_error);
                assert_eq!(store.snapshot().revision, u64::from(rename));
                let restarted = SnippetStore::open(dir).await.unwrap();
                assert_eq!(store.snapshot(), restarted.snapshot());
            }
        })
        .await;
}
