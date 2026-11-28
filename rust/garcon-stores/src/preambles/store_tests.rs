use std::{path::Path, process::Command};

use garcon_contract::preambles::{
    PreambleTagFilter, PreambleTagMatchMode, normalize_preamble_definition_input,
};
use garcon_js::ManualClock;
use serde_json::json;
use tokio::{sync::Notify, task::LocalSet};

use super::*;
use crate::preambles::{bundled, setup::initialize_preamble_store};

const EPOCH: &str = "2026-11-28T09:10:11.123Z";
const LOCAL: &str = "d36d22a1-49e9-4de3-b7ab-80668e845559";
const REMOTE: &str = "11111111-1111-4111-8111-111111111111";
const ORACLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/oracles/preambles-disk.ts"
);

fn preamble(id: &str) -> Preamble {
    Preamble {
        id: id.into(),
        definition: PreambleDefinition {
            enabled: true,
            title: "Fixture".into(),
            snippet_short_name: None,
            content: "Content".into(),
            scope: PreambleScope::Global,
            agent_ids: Vec::new(),
            tag_filter: PreambleTagFilter {
                mode: PreambleTagMatchMode::Any,
                tags: Vec::new(),
            },
        },
        created_at: EPOCH.into(),
        updated_at: EPOCH.into(),
    }
}

fn scoped(path: &str, executor: Option<&str>, nested: bool, body: &str) -> PreambleDefinition {
    normalize_preamble_definition_input(&json!({
        "enabled":true, "title":"Scoped", "content":body,
        "scope":{"type":"project-paths", "rules":[{
            "projectPath":path,"executorId":executor,"includeNested":nested
        }]}
    }))
    .unwrap()
}

fn no_references() -> RetainExecutorReferences {
    Rc::new(|next, current| {
        assert!(next.is_empty());
        assert!(current.is_empty());
        Ok(Box::new(|| {}))
    })
}

fn code(error: Box<dyn Error>) -> PreambleErrorCode {
    error.downcast_ref::<PreambleDomainError>().unwrap().code
}

fn run_bun(operation: &str, directory: Option<&Path>) -> Vec<u8> {
    let version = Command::new("bun").arg("--version").output().unwrap();
    assert_eq!(String::from_utf8_lossy(&version.stdout).trim(), "1.4.3");
    let output = Command::new("bun")
        .arg(ORACLE)
        .arg(operation)
        .args(directory)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

#[test]
fn reads_the_exact_original_bundled_definitions() {
    assert_eq!(run_bun("bundles", None), include_bytes!("bundled.json"));
}

const V1_SURROGATE_PATH: &str = r#"{"version":1,"revision":7,"preambles":[{"id":"d36d22a1-49e9-4de3-b7ab-80668e845559","enabled":true,"title":"Fixture","content":"Synthetic body","scope":{"type":"project-paths","rules":[{"projectPath":"/work/\ud800","includeNested":false}]},"createdAt":"2026-11-28T09:10:11.123Z","updatedAt":"2026-11-28T09:10:11.123Z"}]}"#;

#[tokio::test]
async fn does_not_migrate_an_ill_formed_v1_project_path() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("preambles.json");
    fs::write(&path, V1_SURROGATE_PATH).await.unwrap();
    let bun: Value = json::from_slice(&run_bun("open-error", Some(root.path()))).unwrap();
    assert_eq!(
        bun["message"],
        "preambles.json contains a non-canonical project path"
    );
    assert_eq!(fs::read_to_string(&path).await.unwrap(), V1_SURROGATE_PATH);
    let error = PreambleStore::open(root.path().to_str().unwrap())
        .await
        .err()
        .unwrap();
    assert_eq!(error.to_string(), bun["message"].as_str().unwrap());
    assert_eq!(fs::read_to_string(&path).await.unwrap(), V1_SURROGATE_PATH);
}

#[tokio::test]
async fn v1_migration_keeps_genuine_project_path_replacement_characters_and_last_duplicates() {
    let original = tempfile::tempdir().unwrap();
    let rust = tempfile::tempdir().unwrap();
    let source = V1_SURROGATE_PATH.replace(
        r#""projectPath":"/work/\ud800""#,
        r#""projectPath":"/work/\ud800","projectPath":"/work/\ufffd""#,
    );
    let original_path = original.path().join("preambles.json");
    let rust_path = rust.path().join("preambles.json");
    fs::write(&original_path, &source).await.unwrap();
    fs::write(&rust_path, &source).await.unwrap();
    let recorded: Value = json::from_slice(&run_bun("read", Some(original.path()))).unwrap();
    let store = PreambleStore::open(rust.path().to_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(store.snapshot()).unwrap(),
        recorded["snapshot"]
    );
    assert_eq!(
        fs::read(&original_path).await.unwrap(),
        fs::read(&rust_path).await.unwrap()
    );
    assert_eq!(
        recorded["snapshot"]["preambles"][0]["scope"]["rules"][0]["projectPath"],
        "/work/\u{fffd}"
    );
}

#[tokio::test]
async fn rejects_invalid_disk_state_without_rewriting_it() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("preambles.json");
    let mut relative = preamble(LOCAL);
    relative.definition = scoped("relative", None, false, "Content");
    for (file, message) in [
        (
            json!({"version":1,"revision":5,"preambles":[relative]}),
            "preambles.json contains a non-canonical project path",
        ),
        (
            json!({"version":2,"revision":5,"preambles":[preamble(LOCAL)],"retiredPreambleIds":[LOCAL]}),
            "preambles.json contains an ID that is both active and retired",
        ),
        (
            json!({"version":2,"revision":5,"preambles":[],"retiredPreambleIds":[LOCAL,LOCAL]}),
            "preambles.json contains an invalid retired preamble ID",
        ),
    ] {
        let original = serde_json::to_vec(&file).unwrap();
        fs::write(&path, &original).await.unwrap();
        let error = PreambleStore::open(root.path().to_str().unwrap())
            .await
            .err()
            .unwrap();
        assert_eq!(error.to_string(), message);
        assert_eq!(fs::read(&path).await.unwrap(), original);
    }
}

#[tokio::test]
async fn exhausted_active_capacity_defers_bundles_in_source_order() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("preambles.json");
            let entries: Vec<_> = (0..PREAMBLE_MAX_COUNT - 1)
                .map(|index| preamble(&format!("00000000-0000-4000-8000-{index:012}")))
                .collect();
            fs::write(
                &path,
                serde_json::to_vec(
                    &json!({"version":2,"revision":9,"preambles":entries,"retiredPreambleIds":[]}),
                )
                .unwrap(),
            )
            .await
            .unwrap();
            let store = PreambleStore::open(root.path().to_str().unwrap())
                .await
                .unwrap();
            let bundles = bundled::definitions().unwrap();
            let now = date_parse(EPOCH).unwrap();
            let install = store.install_bundled(&bundles, now, None).await.unwrap();
            assert_eq!(
                (install.installed, install.deferred),
                (1, bundles.len() - 1)
            );
            assert_eq!(store.snapshot().revision, 10);
            assert_eq!(store.snapshot().preambles.last().unwrap().id, bundles[0].id);
            let full = store.install_bundled(&bundles, now, None).await.unwrap();
            assert_eq!((full.installed, full.deferred), (0, bundles.len() - 1));
            assert_eq!(
                code(
                    store
                        .create(preamble(LOCAL), 10, no_references())
                        .await
                        .unwrap_err()
                ),
                PreambleErrorCode::LIMIT_REACHED
            );
            assert_eq!(store.snapshot().revision, 10);
        })
        .await;
}

#[tokio::test]
async fn composition_rejection_leaves_the_snapshot_and_disk_unchanged() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("preambles.json");
            let store = PreambleStore::open(root.path().to_str().unwrap())
                .await
                .unwrap();
            let mut first = preamble(LOCAL);
            first.definition.content = "x".repeat(32_000);
            store.create(first, 0, no_references()).await.unwrap();
            let snapshot = store.snapshot();
            let bytes = fs::read(&path).await.unwrap();
            for (content, expected) in [
                (
                    "x".repeat(32_000),
                    PreambleErrorCode::COMBINED_LIMIT_EXCEEDED,
                ),
                (
                    "Referenced file contents from @file mentions:\n\nSynthetic".into(),
                    PreambleErrorCode::VALIDATION_FAILED,
                ),
            ] {
                let mut second = preamble(REMOTE);
                second.definition.content = content;
                let error = store.create(second, 1, no_references()).await.unwrap_err();
                assert_eq!(code(error), expected);
                assert_eq!(store.snapshot(), snapshot);
                assert_eq!(fs::read(&path).await.unwrap(), bytes);
            }
        })
        .await;
}

#[tokio::test]
async fn bun_and_rust_read_each_others_catalog_writes() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let write = run_bun("write", Some(root.path()));
            let original: Value = json::from_slice(&write).unwrap();
            let store = PreambleStore::open(root.path().to_str().unwrap())
                .await
                .unwrap();
            let before = store.snapshot();
            assert_eq!(serde_json::to_value(&before).unwrap(), original["snapshot"]);
            assert_eq!(
                store.lifetime_id_count(),
                original["lifetimeIdCount"].as_u64().unwrap() as usize
            );
            assert_eq!(
                store.get_by_snippet_short_name("interop").unwrap().id,
                LOCAL
            );
            let retain: RetainExecutorReferences = Rc::new(|next, current| {
                assert!(next.is_empty());
                assert_eq!(current, [None, Some(REMOTE)]);
                Ok(Box::new(|| {}))
            });
            store
                .remove(LOCAL.into(), before.revision, retain)
                .await
                .unwrap();
            store
                .create(preamble(REMOTE), before.revision + 1, no_references())
                .await
                .unwrap();
            let read = run_bun("read", Some(root.path()));
            let reread: Value = json::from_slice(&read).unwrap();
            assert_eq!(
                serde_json::to_value(store.snapshot()).unwrap(),
                reread["snapshot"]
            );
            assert_eq!(
                store.lifetime_id_count(),
                reread["lifetimeIdCount"].as_u64().unwrap() as usize
            );
            let disk = fs::read_to_string(root.path().join("preambles.json"))
                .await
                .unwrap();
            assert_eq!(disk, reread["file"].as_str().unwrap());
            assert!(disk.ends_with("}\n"));
            assert_eq!(
                json::parse(&disk).unwrap()["retiredPreambleIds"],
                json!([LOCAL])
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = fs::metadata(root.path().join("preambles.json"))
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
async fn migrates_version_one_and_never_reinstalls_a_retired_bundle() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("preambles.json");
            let bundle = bundled::definitions().unwrap().remove(0);
            let mut original = preamble(&bundle.id);
            original.definition.title = "User-edited title".into();
            fs::write(
                &path,
                serde_json::to_vec(&json!({"version":1,"revision":42,"preambles":[original]}))
                    .unwrap(),
            )
            .await
            .unwrap();
            let workspace = root.path().to_str().unwrap();
            let store = PreambleStore::open(workspace).await.unwrap();
            let migrated = json::parse(&fs::read_to_string(&path).await.unwrap()).unwrap();
            assert_eq!(json::as_number(&migrated["version"]), Some(2.0));
            assert_eq!(migrated["retiredPreambleIds"], json!([]));
            assert_eq!(store.snapshot().revision, 42);
            assert_eq!(store.snapshot().preambles[0], original);
            let timestamp = date_parse(EPOCH).unwrap();
            assert_eq!(
                store
                    .install_bundled(std::slice::from_ref(&bundle), timestamp, None)
                    .await
                    .unwrap()
                    .installed,
                0
            );
            store
                .remove(bundle.id.clone(), 42, no_references())
                .await
                .unwrap();
            assert_eq!(store.snapshot().revision, 43);
            assert_eq!(store.lifetime_id_count(), 1);
            let restart = initialize_preamble_store(workspace, &ManualClock::new(timestamp), None)
                .await
                .unwrap();
            assert_eq!(restart.snapshot().revision, 44);
            assert_eq!(
                restart.lifetime_id_count(),
                bundled::definitions().unwrap().len()
            );
            assert!(
                !restart
                    .snapshot()
                    .preambles
                    .iter()
                    .any(|entry| entry.id == bundle.id)
            );
            assert_eq!(
                code(
                    restart
                        .create(original, 44, no_references())
                        .await
                        .unwrap_err()
                ),
                PreambleErrorCode::ID_COLLISION
            );
        })
        .await;
}

#[tokio::test]
async fn stale_create_checks_revision_before_generating_and_rejects_reused_ids() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let store = PreambleStore::open(root.path().to_str().unwrap())
                .await
                .unwrap();
            let error = store
                .create_with_generated_id(
                    9,
                    || panic!("must not generate"),
                    |_| panic!("must not build"),
                    || Ok(()),
                    no_references(),
                )
                .await
                .unwrap_err();
            let error = error.downcast_ref::<PreambleDomainError>().unwrap();
            assert_eq!(error.code, PreambleErrorCode::REVISION_CONFLICT);
            assert!(error.retryable);
            store
                .create_with_generated_id(0, || LOCAL.into(), preamble, || Ok(()), no_references())
                .await
                .unwrap();
            store
                .remove(LOCAL.into(), 1, no_references())
                .await
                .unwrap();
            assert_eq!(
                code(
                    store
                        .create_with_generated_id(
                            2,
                            || LOCAL.into(),
                            |_| panic!("must not build"),
                            || Ok(()),
                            no_references()
                        )
                        .await
                        .unwrap_err()
                ),
                PreambleErrorCode::ID_COLLISION
            );
            assert_eq!(store.snapshot().revision, 2);
        })
        .await;
}

#[tokio::test]
async fn updates_a_preamble_monotonically_and_checks_short_name_after_revision() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let store = PreambleStore::open(root.path().to_str().unwrap())
                .await
                .unwrap();
            store
                .create(preamble(LOCAL), 0, no_references())
                .await
                .unwrap();
            let mut new = preamble(LOCAL).definition;
            new.snippet_short_name = Some("short".into());
            assert_eq!(
                code(
                    store
                        .update(
                            LOCAL.into(),
                            new.clone(),
                            EPOCH.into(),
                            0,
                            || panic!("must not validate"),
                            no_references()
                        )
                        .await
                        .unwrap_err()
                ),
                PreambleErrorCode::REVISION_CONFLICT
            );
            store
                .update(
                    LOCAL.into(),
                    new,
                    EPOCH.into(),
                    1,
                    || Ok(()),
                    no_references(),
                )
                .await
                .unwrap();
            let p = store.get_by_snippet_short_name("short").unwrap();
            assert_eq!(p.created_at, EPOCH);
            assert_eq!(p.updated_at, "2026-11-28T09:10:11.124Z");
            let mut duplicate = preamble(REMOTE);
            duplicate.definition.snippet_short_name = Some("short".into());
            assert_eq!(
                code(
                    store
                        .create(duplicate, 2, no_references())
                        .await
                        .unwrap_err()
                ),
                PreambleErrorCode::SNIPPET_NAME_CONFLICT
            );
            assert_eq!(store.snapshot().revision, 2);
        })
        .await;
}

struct FaultWriter {
    rename: bool,
    write_started: Notify,
    release_write: Notify,
}

#[async_trait::async_trait(?Send)]
impl CatalogWriter for FaultWriter {
    async fn write(&self, path: &str, payload: &[u8]) -> Result<()> {
        self.write_started.notify_one();
        self.release_write.notified().await;
        if self.rename {
            JsonFileStore::default().write(path, payload).await?;
            Err(PreambleCatalogCommittedUnknownError("simulated sync failure".into()).into())
        } else {
            Err("simulated rename failure".into())
        }
    }
}

#[tokio::test]
async fn cancelled_waiter_keeps_reference_guard_until_publication_and_unknown_commit_fences_new_writes()
 {
    LocalSet::new()
        .run_until(async {
            for rename in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let writer = Rc::new(FaultWriter {
                    rename,
                    write_started: Notify::new(),
                    release_write: Notify::new(),
                });
                let store =
                    PreambleStore::open_with_writer(root.path().to_str().unwrap(), writer.clone())
                        .await
                        .unwrap();
                let active = Rc::new(Cell::new(false));
                let retain: RetainExecutorReferences = Rc::new({
                    let active = active.clone();
                    let store = store.clone();
                    move |next, current| {
                        assert_eq!(next, [Some(REMOTE)]);
                        assert!(current.is_empty());
                        assert!(!active.replace(true));
                        let active = active.clone();
                        let store = store.clone();
                        Ok(Box::new(move || {
                            assert_eq!(store.snapshot().revision, u64::from(rename));
                            assert!(active.replace(false));
                        }))
                    }
                });
                let mut created = preamble(LOCAL);
                created.definition = scoped("/srv/fixture", Some(REMOTE), false, "Hello");
                let waiting = tokio::task::spawn_local({
                    let store = store.clone();
                    async move { store.create(created, 0, retain).await }
                });
                writer.write_started.notified().await;
                assert!(active.get());
                waiting.abort();
                assert!(waiting.await.unwrap_err().is_cancelled());
                assert!(active.get());
                assert_eq!(store.snapshot().revision, 0);
                writer.release_write.notify_one();
                store.drain().await;
                assert!(!active.get());
                let restarted = PreambleStore::open(root.path().to_str().unwrap())
                    .await
                    .unwrap();
                assert_eq!(store.snapshot(), restarted.snapshot());
                assert_eq!(store.snapshot().revision, u64::from(rename));
                if rename {
                    assert_eq!(
                        code(
                            store
                                .remove(LOCAL.into(), 0, no_references())
                                .await
                                .unwrap_err()
                        ),
                        PreambleErrorCode::CATALOG_SAVE_UNKNOWN
                    );
                }
            }
        })
        .await;
}
