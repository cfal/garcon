use std::{cell::Cell, path::Path, process::Command, rc::Rc};

use garcon_cases::{CaseError, replay};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::fs;

use super::*;
use crate::settings::SettingsStoreOptions;

const ORACLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/oracles/settings-order-reconciliation.ts"
);
const IDS: [&str; 4] = [
    "1000000000000001",
    "1000000000000002",
    "1000000000000003",
    "1000000000000004",
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Order {
    pinned_chat_ids: Vec<String>,
    normal_chat_ids: Vec<String>,
    archived_chat_ids: Vec<String>,
}

#[test]
fn reconciles_the_original_recorded_order_cases() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/settings-order-reconciliation"
        ),
        |function, args| {
            if function != "reconcileOrder" {
                return Err(CaseError::unhandled(function));
            }
            let [before, ids] = args else {
                return Err(CaseError::undeliverable(
                    "expected settings and registered IDs",
                ));
            };
            let before: Order = serde_json::from_value(before.clone())
                .map_err(|error| CaseError::undeliverable(error.to_string()))?;
            let ids: Vec<String> = serde_json::from_value(ids.clone())
                .map_err(|error| CaseError::undeliverable(error.to_string()))?;
            serde_json::to_value(reconcile_order(
                &before.pinned_chat_ids,
                &before.normal_chat_ids,
                &before.archived_chat_ids,
                &ids,
            ))
            .map_err(|error| CaseError::undeliverable(error.to_string()))
        },
    );
}

fn run_bun(action: &str, directory: &Path) -> Value {
    let version = Command::new("bun").arg("--version").output().unwrap();
    assert_eq!(String::from_utf8_lossy(&version.stdout).trim(), "1.4.3");
    let output = Command::new("bun")
        .env("GARCON_LOG_LEVEL", "error")
        .arg(ORACLE)
        .arg(action)
        .arg(directory)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    json::from_slice(&output.stdout).unwrap()
}

fn settings_order(settings: &ProjectSettings) -> Value {
    json!({
        "pinnedChatIds": settings.pinned_chat_ids,
        "normalChatIds": settings.normal_chat_ids,
        "archivedChatIds": settings.archived_chat_ids,
        "remoteSettingsVersion": settings.remote_settings_version,
        "title": settings.chat_names[IDS[0]],
    })
}

#[tokio::test]
async fn bun_and_rust_reconcile_each_others_durable_order_without_notifying() {
    let bun_root = tempfile::tempdir().unwrap();
    let rust_root = tempfile::tempdir().unwrap();
    let [a, b, c, d] = IDS;
    let known = IDS.map(str::to_owned);
    let bun_before = run_bun("write", bun_root.path());
    let store = SettingsStore::open(
        bun_root.path().to_str().unwrap(),
        SettingsStoreOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(settings_order(&store.snapshot()), bun_before);
    let notifications = Rc::new(Cell::new(0));
    let _unsubscribe = store.on_change(Rc::new({
        let notifications = notifications.clone();
        move |_| {
            notifications.set(notifications.get() + 1);
            Ok(())
        }
    }));
    store.reconcile_with_registry(&known).await.unwrap();
    let expected = json!({
        "pinnedChatIds":[a], "normalChatIds":[d,b], "archivedChatIds":[c],
        "remoteSettingsVersion":8, "title":"Fixture title",
    });
    assert_eq!(settings_order(&store.snapshot()), expected);
    assert_eq!(notifications.get(), 0);
    let persisted: Value = json::from_slice(
        &fs::read(bun_root.path().join("project-settings.json"))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(persisted["normalChatIds"], expected["normalChatIds"]);
    assert_eq!(persisted["remoteSettingsVersion"], 8);

    let directory = rust_root.path().to_str().unwrap();
    let store = SettingsStore::open(directory, SettingsStoreOptions::default())
        .await
        .unwrap();
    store.save_settings(&json!({
        "pinnedChatIds":[a,"gone",a], "normalChatIds":[a,b], "archivedChatIds":[b,c,"gone-archived"],
        "remoteSettingsVersion":7, "chatNames":{ (a): "Fixture title" },
    })).await.unwrap();
    assert_eq!(settings_order(&store.snapshot()), bun_before);
    assert_eq!(run_bun("reconcile", rust_root.path()), expected);
    let reopened = SettingsStore::open(directory, SettingsStoreOptions::default())
        .await
        .unwrap();
    assert_eq!(settings_order(&reopened.snapshot()), expected);
}

#[tokio::test]
async fn duplicates_within_one_group_do_not_alone_trigger_a_write() {
    let root = tempfile::tempdir().unwrap();
    let store = SettingsStore::open(
        root.path().to_str().unwrap(),
        SettingsStoreOptions::default(),
    )
    .await
    .unwrap();
    store
        .save_settings(
            &json!({"pinnedChatIds":["a","a"],"normalChatIds":["b"],"remoteSettingsVersion":9}),
        )
        .await
        .unwrap();
    let file = root.path().join("project-settings.json");
    let before = fs::read(&file).await.unwrap();
    store
        .reconcile_with_registry(&["a".into(), "b".into()])
        .await
        .unwrap();
    assert_eq!(store.snapshot().pinned_chat_ids, ["a", "a"]);
    assert_eq!(store.snapshot().remote_settings_version, 9);
    assert_eq!(fs::read(&file).await.unwrap(), before);
}
