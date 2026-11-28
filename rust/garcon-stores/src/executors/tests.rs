use std::path::Path;

use garcon_base::domain_error::as_domain_error;
use garcon_contract::error_codes::ErrorCode;
use serde_json::{Value, json};
use tokio::task::LocalSet;

use super::config_store::ExecutorConfigStore;

fn create(label: &str) -> Value {
    json!({"direction":"executor-connects","label":label})
}

async fn oracle(mode: &str, workspace: &Path) -> Value {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/executor_config_oracle.ts");
    let output = tokio::process::Command::new("bun")
        .arg(script)
        .arg(mode)
        .arg(workspace)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    garcon_js::json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn original_and_rust_read_and_write_each_others_private_executor_configuration() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().to_str().unwrap();
            let path = root.path().join("executors.json");
            let seeded = oracle("seed", root.path()).await;
            let id = seeded["id"].as_str().unwrap().to_owned();
            let store = ExecutorConfigStore::open(workspace).await.unwrap();
            let executor = store.require(&id).unwrap();
            assert_eq!(serde_json::to_value(executor).unwrap(), seeded);
            assert_eq!(
                store.connection(&id, None).unwrap().connection_url,
                format!(
                    "wss://fixture.invalid/executor/{id}?tag=a&tag=b#secret={}",
                    seeded["secret"].as_str().unwrap()
                )
            );
            let updated = store
                .update(
                    id.clone(),
                    json!({"label":"Rust renamed","allowControllerCli":true}),
                    None,
                )
                .await
                .unwrap();
            assert!(updated.allow_controller_cli);
            assert!(updated.allow_executor_management);
            let rust_bytes = tokio::fs::read(&path).await.unwrap();
            let original = oracle("check-bytes-and-update", root.path()).await;
            assert_eq!(original["preservedBytes"], true);
            let reopened = ExecutorConfigStore::open(workspace).await.unwrap();
            let mutated_by_bun = reopened.require(&id).unwrap();
            assert_eq!(
                serde_json::to_value(&mutated_by_bun).unwrap(),
                original["mutated"]
            );
            assert_eq!(mutated_by_bun.label, "Bun renamed");
            assert!(mutated_by_bun.allow_controller_cli);
            assert!(!mutated_by_bun.allow_executor_management);
            assert!(rust_bytes.ends_with(b"\n"));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    tokio::fs::metadata(path)
                        .await
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        })
        .await;
}

#[tokio::test]
async fn serializes_conflicting_names_and_validates_connector_changes_before_writes() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("executors.json");
            let store = ExecutorConfigStore::open(root.path().to_str().unwrap())
                .await
                .unwrap();
            assert!(store.list().is_empty());
            assert!(!path.exists());
            let (first, conflict) = tokio::join!(
                store.create(create(" Build executor "), None),
                store.create(create("BUILD EXECUTOR"), None),
            );
            let first = first.unwrap();
            assert!(
                conflict
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("label already exists")
            );
            assert_eq!(first.label, "Build executor");
            assert!(!first.allow_controller_cli && !first.allow_executor_management);
            assert!(
                store
                    .create(create("lOcAl"), None)
                    .await
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("reserved")
            );
            assert_eq!(
                store
                    .connection(&first.id, Some(""))
                    .unwrap()
                    .connection_url,
                ""
            );
            let before = tokio::fs::read(&path).await.unwrap();
            let changed = store
                .update(
                    first.id.clone(),
                    json!({"connection":{"direction":"controller-connects","noTls":true}}),
                    None,
                )
                .await;
            assert_eq!(
                changed.err().unwrap().to_string(),
                "Changing connection direction requires a connection URL"
            );
            let guard = Box::new(|_: &_, _: &_| Err("Active work owns this connector".into()));
            let changed = store
                .update(
                    first.id.clone(),
                    json!({"allowControllerCli":true}),
                    Some(guard),
                )
                .await;
            assert_eq!(
                changed.err().unwrap().to_string(),
                "Active work owns this connector"
            );
            assert_eq!(tokio::fs::read(&path).await.unwrap(), before);
            let disabled = store
                .update(
                    first.id.clone(),
                    json!({"label":"BUILD EXECUTOR","enabled":false}),
                    None,
                )
                .await
                .unwrap();
            assert!(!disabled.enabled);
            store.remove(first.id.clone()).await.unwrap();
            assert!(store.list().is_empty());
            let error = store.require(&first.id).err().unwrap();
            assert_eq!(
                as_domain_error(error.as_ref()).unwrap().code,
                ErrorCode::EXECUTOR_NOT_FOUND
            );
        })
        .await;
}

#[tokio::test]
async fn retains_legacy_grant_defaults_and_quarantines_retired_schema_without_exposing_secret() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().to_str().unwrap();
            let path = root.path().join("executors.json");
            let store = ExecutorConfigStore::open(workspace).await.unwrap();
            let executor = store.create(create("Fixture"), None).await.unwrap();
            let mut stored: Value =
                garcon_js::json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
            let entry = stored["executors"][0].as_object_mut().unwrap();
            entry.shift_remove("allowControllerCli");
            entry.shift_remove("allowExecutorManagement");
            tokio::fs::write(&path, stored.to_string()).await.unwrap();
            let loaded = ExecutorConfigStore::open(workspace)
                .await
                .unwrap()
                .require(&executor.id)
                .unwrap();
            assert!(!loaded.allow_controller_cli && !loaded.allow_executor_management);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
                    .await
                    .unwrap();
                assert!(
                    ExecutorConfigStore::open(workspace)
                        .await
                        .err()
                        .unwrap()
                        .to_string()
                        .contains("OS account")
                );
                tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                    .await
                    .unwrap();
            }
            let entry = stored["executors"][0].as_object_mut().unwrap();
            let retired = entry.shift_remove("noTls").unwrap();
            entry.insert("allowInsecureDevelopment".into(), retired);
            let broken = stored.to_string();
            tokio::fs::write(&path, &broken).await.unwrap();
            let error = ExecutorConfigStore::open(workspace).await.err().unwrap();
            assert!(
                error
                    .to_string()
                    .contains("rename it to noTls, preserving its boolean value")
            );
            assert!(!error.to_string().contains(&executor.secret));
            let quarantine = error
                .source()
                .unwrap()
                .downcast_ref::<garcon_base::json_file_store::CorruptStateFileError>()
                .unwrap()
                .quarantine_path
                .as_ref()
                .unwrap();
            assert!(error.to_string().contains(quarantine));
            assert_eq!(tokio::fs::read_to_string(quarantine).await.unwrap(), broken);
            assert!(!path.exists());
        })
        .await;
}

#[tokio::test]
async fn validates_url_expansion_transport_policy_and_canonical_credentials() {
    LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().to_str().unwrap();
        let store = ExecutorConfigStore::open(workspace).await.unwrap();
        let secret = "A".repeat(43);
        let connection_url = format!("wss://worker.invalid/worker?tag=a&tag=b#secret={secret}");
        let config = json!({"direction":"controller-connects","label":"Fixture","connectionUrl":connection_url,"allowUnverifiedTls":true});
        let first = store.create(config.clone(), None).await.unwrap();
        assert!(store.connection(&first.id, Some("invalid base")).unwrap().allow_unverified_tls);
        let mut conflict = config;
        conflict["label"] = json!("Another");
        assert!(store.create(conflict, None).await.err().unwrap().to_string().contains("unique IDs and shared secrets"));
        let oversized = json!({"direction":"executor-connects","label":"Oversized","advertisedUrl":format!("wss://fixture.invalid/{}", "{executorId}".repeat(150))});
        assert!(store.create(oversized, None).await.err().unwrap().to_string().contains("exceeds 4096"));
        let no_tls_url = connection_url.replace("wss:", "ws:");
        let replace = json!({"connection":{"direction":"controller-connects","connectionUrl":no_tls_url,"noTls":true,"allowUnverifiedTls":true}});
        store.update(first.id.clone(), replace, None).await.unwrap();
        let reopened = ExecutorConfigStore::open(workspace).await.unwrap();
        let connection = reopened.connection(&first.id, None).unwrap();
        assert!(connection.no_tls);
        assert!(!connection.allow_unverified_tls);
        assert_eq!(connection.connection_url, no_tls_url);
        let policy_only = json!({"connection":{"direction":"controller-connects","noTls":false}});
        assert!(reopened.update(first.id, policy_only, None).await.err().unwrap().to_string().contains("require TLS"));
    }).await;
}

#[tokio::test]
async fn policy_only_updates_preserve_inherited_public_urls_across_restart_and_public_base_changes()
{
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().to_str().unwrap();
            let store = ExecutorConfigStore::open(workspace).await.unwrap();
            let executor = store
                .create(create("Inherited"), Some("https://old.test".into()))
                .await
                .unwrap();
            let id = executor.id;
            store
                .update(
                    id.clone(),
                    json!({"connection":{"direction":"executor-connects","noTls":true}}),
                    None,
                )
                .await
                .unwrap();
            let reloaded = ExecutorConfigStore::open(workspace).await.unwrap();
            assert!(matches!(
                reloaded.require(&id).unwrap().connection,
                super::config_store::RemoteExecutorConnection::ExecutorConnects {
                    advertised_url: None
                }
            ));
            let connection = reloaded
                .connection(&id, Some("https://new.test/base"))
                .unwrap();
            assert_eq!(
                connection.connection_url,
                format!(
                    "wss://new.test/base/executor/{id}#secret={}",
                    executor.secret
                )
            );
            assert!(connection.no_tls);
        })
        .await;
}

#[tokio::test]
async fn existing_duplicate_labels_stay_readable_and_configurable_while_a_rename_repairs_them() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().to_str().unwrap();
            let store = ExecutorConfigStore::open(workspace).await.unwrap();
            let first = store.create(create("First"), None).await.unwrap();
            let second = store.create(create("Second"), None).await.unwrap();
            let path = root.path().join("executors.json");
            let mut stored: Value =
                garcon_js::json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
            stored["executors"][0]["label"] = json!("Duplicate");
            stored["executors"][1]["label"] = json!(" Duplicate ");
            tokio::fs::write(&path, stored.to_string()).await.unwrap();
            let store = ExecutorConfigStore::open(workspace).await.unwrap();
            let first = store
                .update(first.id, json!({"label":"Duplicate","enabled":false}), None)
                .await
                .unwrap();
            let second = store
                .update(
                    second.id,
                    json!({"label":"Duplicate","allowExecutorManagement":true}),
                    None,
                )
                .await
                .unwrap();
            assert!(!first.enabled);
            assert!(second.allow_executor_management);
            let before = tokio::fs::read(&path).await.unwrap();
            assert!(
                store
                    .update(
                        second.id.clone(),
                        json!({"label":"DUPLICATE","allowControllerCli":true}),
                        None
                    )
                    .await
                    .is_err()
            );
            assert_eq!(tokio::fs::read(&path).await.unwrap(), before);
            assert!(!store.require(&second.id).unwrap().allow_controller_cli);
            let updated = store
                .update(second.id, json!({"label":"Repaired"}), None)
                .await
                .unwrap();
            assert_eq!(updated.label, "Repaired");
            assert_eq!(updated.secret, second.secret);
        })
        .await;
}
