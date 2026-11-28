use std::cell::Cell;

use garcon_contract::settings::TranscriptSearchFeatureSettings;
use serde_json::json;

use super::super::SettingsFeaturePatch;
use super::*;

#[derive(Default)]
struct FaultWriter {
    failure: Cell<Option<bool>>,
    real: JsonFileStore,
}

#[async_trait::async_trait(?Send)]
impl SettingsWriter for FaultWriter {
    async fn write(&self, path: &str, settings: &ProjectSettings) -> Result<(), WriteFailure> {
        if let Some(renamed) = self.failure.get() {
            if renamed {
                self.real.write(path, settings).await?;
            }
            return Err(WriteFailure {
                renamed,
                source: "synthetic write failure".into(),
            });
        }
        self.real.write(path, settings).await
    }
}

#[tokio::test]
async fn fences_provider_references_and_holds_events_until_an_uncertain_write_is_confirmed() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().to_str().unwrap();
    let writer = Rc::new(FaultWriter::default());
    let store =
        SettingsStore::open_with_writer(workspace, SettingsStoreOptions::default(), writer.clone())
            .await
            .unwrap();
    let select = |id| json!({ "chatTitle": { "apiProviderId": id } });
    store
        .set_ui_settings(select("old").as_object().unwrap())
        .await
        .unwrap();
    let notifications = Rc::new(RefCell::new(Vec::new()));
    let stop = store.on_change({
        let notifications = Rc::clone(&notifications);
        Rc::new(move |event| {
            notifications.borrow_mut().push(event.clone());
            Ok(())
        })
    });
    writer.failure.set(Some(false));
    assert!(
        store
            .set_ui_settings(select("never").as_object().unwrap())
            .await
            .is_err()
    );
    assert!(!store.references_api_provider("never"));
    assert!(store.references_api_provider("old"));
    writer.failure.set(Some(true));
    assert!(
        store
            .set_ui_settings(select("candidate").as_object().unwrap())
            .await
            .is_err()
    );
    assert_eq!(
        store.ui_settings()["chatTitle"]["apiProviderId"],
        "candidate"
    );
    assert!(store.references_api_provider("old"));
    assert!(store.references_api_provider("candidate"));
    assert!(notifications.borrow().is_empty());
    assert!(store.confirm_durability().await.is_err());
    assert!(notifications.borrow().is_empty());
    writer.failure.set(None);
    store.confirm_durability().await.unwrap();
    assert_eq!(&*notifications.borrow(), &[SettingsChange::RemoteSettings]);
    assert!(!store.references_api_provider("old"));
    assert!(store.references_api_provider("candidate"));
    store.confirm_durability().await.unwrap();
    stop();
    store
        .set_feature_settings(SettingsFeaturePatch::default())
        .await
        .unwrap();
    assert_eq!(notifications.borrow().len(), 1);
}

#[tokio::test]
async fn serializes_settings_writes_on_one_cache_and_preserves_unrelated_fields() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().to_str().unwrap();
    let store = SettingsStore::open(workspace, SettingsStoreOptions::default())
        .await
        .unwrap();
    assert!(!root.path().join("project-settings.json").exists());
    let patch = json!({"arbitraryUiPreference":{"1":1.0,"0":false},"appIdentity":{"title":" Tool & Team "}});
    let (ui, features) = tokio::join!(
        store.set_ui_settings(patch.as_object().unwrap()),
        store.set_feature_settings(SettingsFeaturePatch {
            transcript_search: Some(TranscriptSearchFeatureSettings { enabled: true }),
            ..Default::default()
        })
    );
    ui.unwrap();
    features.unwrap();
    let stored = SettingsStore::open(workspace, SettingsStoreOptions::default())
        .await
        .unwrap();
    assert!(stored.feature_settings().transcript_search.enabled);
    assert_eq!(stored.snapshot().remote_settings_version, 2);
    assert_eq!(stored.ui_settings()["appIdentity"]["title"], "Tool & Team");
    assert_eq!(
        stored.ui_settings()["arbitraryUiPreference"]["1"].as_f64(),
        Some(1.0)
    );
    let source_text = tokio::fs::read_to_string(root.path().join("project-settings.json"))
        .await
        .unwrap();
    assert!(source_text.contains("\"0\": false,\n      \"1\": 1\n"));
}

#[tokio::test]
async fn corrupt_settings_are_quarantined_instead_of_replaced_with_defaults() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().to_str().unwrap();
    let file = root.path().join("project-settings.json");
    tokio::fs::write(&file, b"[]").await.unwrap();
    assert!(
        SettingsStore::open(workspace, SettingsStoreOptions::default())
            .await
            .is_err()
    );
    assert!(!file.exists());
    assert!(
        SettingsStore::open(workspace, SettingsStoreOptions::default())
            .await
            .is_err()
    );
    let mut files = tokio::fs::read_dir(workspace).await.unwrap();
    let error_copy = files.next_entry().await.unwrap().unwrap();
    assert!(
        error_copy
            .file_name()
            .to_string_lossy()
            .starts_with("project-settings.json.corrupt-")
    );
    assert_eq!(tokio::fs::read(error_copy.path()).await.unwrap(), b"[]");
}

#[tokio::test]
async fn only_pinned_order_changes_bump_remote_settings_and_chat_names_use_byte_limits() {
    let root = tempfile::tempdir().unwrap();
    let store = SettingsStore::open(
        root.path().to_str().unwrap(),
        SettingsStoreOptions::default(),
    )
    .await
    .unwrap();
    let events = Rc::new(RefCell::new(Vec::new()));
    let _stop = store.on_change({
        let events = events.clone();
        Rc::new(move |change| {
            events.borrow_mut().push(change.clone());
            Ok(())
        })
    });
    let chat = "1000000000000001";
    store.ensure_in_normal(chat).await.unwrap();
    assert_eq!(store.snapshot().remote_settings_version, 0);
    assert!(store.toggle_pin(chat).await.unwrap());
    assert_eq!(store.snapshot().remote_settings_version, 1);
    assert!(store.toggle_archive(chat).await.unwrap());
    assert!(store.confirm_archive_state(chat).await.unwrap());
    assert_eq!(store.snapshot().remote_settings_version, 2);
    assert!(!store.toggle_archive(chat).await.unwrap());
    assert_eq!(store.snapshot().remote_settings_version, 2);
    assert_eq!(
        events
            .borrow()
            .iter()
            .filter(|event| **event == SettingsChange::RemoteSettings)
            .count(),
        2,
    );
    let limit = garcon_contract::chat_title_contracts::CHAT_TITLE_MAX_BYTES;
    let at_limit = "\u{e9}".repeat(limit / 2);
    let invalid = format!("{at_limit}a");
    assert!(
        store
            .set_session_name(chat, &at_limit)
            .await
            .unwrap()
            .changed
    );
    assert!(store.set_session_name(chat, &invalid).await.is_err());
    assert_eq!(store.chat_name(chat).as_deref(), Some(at_limit.as_str()));
}

#[tokio::test]
async fn merges_executor_path_patches_and_preserves_recents_and_other_executors() {
    let root = tempfile::tempdir().unwrap();
    let store = SettingsStore::open(
        root.path().to_str().unwrap(),
        SettingsStoreOptions::default(),
    )
    .await
    .unwrap();
    let executor = "11111111-1111-4111-8111-111111111111";
    let other = "22222222-2222-4222-8222-222222222222";
    store.record_chat_startup(&json!({"executorId":executor,"projectPath":" /preserve/spaces ","agentId":"codex","model":"m"})).await;
    let patch = json!({"byExecutor":{
        (executor): {"defaultPath":"/chosen","pinnedPaths":["/one"]},
        (other): {"pinnedPaths":["/two"]},
    }});
    store
        .set_path_settings(patch.as_object().unwrap())
        .await
        .unwrap();
    assert_eq!(
        store.path_settings()["byExecutor"][executor],
        json!({
            "defaultPath":"/chosen","recentPaths":[" /preserve/spaces "],"pinnedPaths":["/one"],
        })
    );
    let bad = json!({"byExecutor":{(executor):{"recentPaths":[]}}});
    assert!(
        store
            .set_path_settings(bad.as_object().unwrap())
            .await
            .is_err()
    );
    store.forget_executor(executor).await.unwrap();
    assert!(store.path_settings()["byExecutor"].get(executor).is_none());
    assert_eq!(
        store.path_settings()["byExecutor"][other]["pinnedPaths"],
        json!(["/two"])
    );
    assert!(store.snapshot().recent_agent_settings.is_empty());
}

#[tokio::test]
async fn bun_and_rust_mutate_each_others_settings_without_losing_owned_fields() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().to_str().unwrap();
    let oracle = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/oracles/settings-disk.ts"
    );
    let run_bun = |action| async move {
        let output = tokio::process::Command::new("bun")
            .args([oracle, action, workspace])
            .kill_on_drop(true)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{action}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    run_bun("write").await;
    let store = SettingsStore::open(workspace, SettingsStoreOptions::default())
        .await
        .unwrap();
    assert_eq!(store.ui_settings()["appIdentity"]["title"], "Bun Title");
    assert_eq!(
        store.snapshot().chat_names["1000000000000001"],
        "Original chat"
    );
    assert_eq!(
        store.snapshot().recent_agent_settings[0].model,
        "fixture-model"
    );
    assert_eq!(
        store.snapshot().chat_folders[0].filter.tags,
        ["fixture-tag"]
    );
    assert_eq!(
        store.snapshot().saved_chat_searches[0].query,
        "fixture search"
    );
    assert_eq!(
        store.path_settings()["recentProjectPaths"],
        json!(["/fixture/project"])
    );
    let patch = json!({"appIdentity":{"title":" Rust Title "}});
    store
        .set_ui_settings(patch.as_object().unwrap())
        .await
        .unwrap();
    assert!(
        store
            .set_session_name("1000000000000002", "  Rust chat  ")
            .await
            .unwrap()
            .changed
    );
    assert!(
        !store
            .set_session_name("1000000000000002", "Rust chat")
            .await
            .unwrap()
            .changed
    );
    assert!(
        !store
            .set_session_name_if_absent("1000000000000002", "Other")
            .await
            .unwrap()
    );
    assert!(store.toggle_pin("1000000000000002").await.unwrap());
    store
        .record_chat_startup(&json!({
            "agentId":"codex", "model":"rust-model", "projectPath":"/fixture/rust",
            "permissionMode":"acceptEdits", "thinkingMode":"high",
        }))
        .await;
    drop(store);
    run_bun("verify-and-update").await;
    let store = SettingsStore::open(workspace, SettingsStoreOptions::default())
        .await
        .unwrap();
    assert_eq!(store.ui_settings()["appIdentity"]["title"], "Rust Title");
    assert!(store.feature_settings().transcript_search.enabled);
    assert_eq!(store.snapshot().remote_settings_version, 5);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = tokio::fs::metadata(root.path().join("project-settings.json"))
            .await
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
