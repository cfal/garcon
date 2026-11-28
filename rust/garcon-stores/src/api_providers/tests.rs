use std::cell::Cell;
use std::path::Path;
use std::rc::Rc;

use garcon_base::{domain_error::as_domain_error, json_file_store::JsonFileStore};
use garcon_contract::{
    agent_execution::{AgentCredentialReference, AgentCredentialReferenceKind},
    api_providers::ApiProviderAssignmentStatus,
    error_codes::ErrorCode,
};
use garcon_interface::errors::{AgentCallError, AgentIntegrationErrorCode};
use garcon_js::SystemClock;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::{sync::Notify, task::LocalSet};

use super::access::ApiProviderAccess;
use super::assignments::{ApiProviderAssignmentStore, RetainExecutorReferences};
use super::endpoint_resolver::{
    ApiProviderEndpointResolver, ModelSelectionInput, PreviousModelSelectionInput,
};
use super::service::{ApiProviderService, PreparedDiscovery};
use super::store::{ApiProviderStore, UpdateApiProviderInput};
use super::{Result, SnapshotWriter, UncertainWrite};

const REMOTE: &str = "11111111-1111-4111-8111-111111111111";

fn create_input() -> Value {
    json!({"label":" Fixture ","templateId":"custom","endpoint":{
        "protocol":"openai-compatible","baseUrl":"provider.example.invalid/v1/",
        "apiKey":"RustSyntheticKey","defaultModel":"base","models":[{"value":"other","label":"Other"}]
    }})
}

#[tokio::test]
async fn provider_storage_failure_omits_model_options_but_denies_selection_and_reference_checks() {
    LocalSet::new()
        .run_until(async {
            for profile_failure in [true, false] {
                let root = tempfile::tempdir().unwrap();
                let dir = root.path().to_str().unwrap();
                seed_assignments(root.path()).await;
                let profile_writer = Rc::new(FaultWriter::default());
                let assignment_writer = Rc::new(FaultWriter::default());
                let profiles = ApiProviderStore::open_with_writer(
                    dir,
                    Rc::new(SystemClock),
                    profile_writer.clone(),
                )
                .await
                .unwrap();
                let assignments =
                    ApiProviderAssignmentStore::open_with_writer(dir, assignment_writer.clone())
                        .await
                        .unwrap();
                let access =
                    ApiProviderAccess::new(profiles, assignments, Rc::new(|id| id == "local"));
                let service = ApiProviderService::new(access.clone());
                let provider = service
                    .create(create_input(), "local", retain_local())
                    .await
                    .unwrap()
                    .entry;
                let resolver = ApiProviderEndpointResolver::new(
                    access,
                    Rc::new(|_, _| {
                        vec![garcon_contract::api_providers::ApiProtocol::OpenAiCompatible]
                    }),
                );
                let input = ModelSelectionInput {
                    executor_id: None,
                    agent_id: Some("codex"),
                    model: "base",
                    api_provider_id: Some(&provider.id),
                    model_endpoint_id: Some(&provider.endpoints[0].id),
                };
                let captured = resolver.resolve_selection(input).unwrap();
                assert_eq!(resolver.get_model_options("codex", None).unwrap().len(), 2);
                if profile_failure {
                    profile_writer.fail.set(Some(true));
                    assert!(
                        service
                            .update(
                                provider.id.clone(),
                                json!({"label":"After rename"}),
                                retain_local()
                            )
                            .await
                            .is_err()
                    );
                } else {
                    assignment_writer.fail.set(Some(true));
                    assert!(
                        service
                            .unassign("local".into(), provider.id.clone(), retain_local(), None)
                            .await
                            .is_err()
                    );
                }
                assert!(
                    resolver
                        .get_model_options("codex", None)
                        .unwrap()
                        .is_empty()
                );
                for error in [
                    resolver.resolve_selection(input).err().unwrap(),
                    resolver.model_supports_images(input).unwrap_err(),
                    resolver
                        .resolve_endpoint_reference(&captured)
                        .err()
                        .unwrap(),
                ] {
                    assert_eq!(
                        as_domain_error(error.as_ref()).unwrap().code,
                        ErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE
                    );
                }
                let native = resolver
                    .resolve_selection(ModelSelectionInput {
                        api_provider_id: None,
                        model_endpoint_id: None,
                        ..input
                    })
                    .unwrap();
                assert_eq!(native.model, "base");
                assert!(native.endpoint.is_none());
                let historical = resolver.describe_previous(PreviousModelSelectionInput {
                    model: input.model,
                    api_provider_id: input.api_provider_id,
                    model_endpoint_id: input.model_endpoint_id,
                });
                if profile_failure {
                    assert_eq!(
                        as_domain_error(historical.err().unwrap().as_ref())
                            .unwrap()
                            .code,
                        ErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE
                    );
                } else {
                    assert!(!historical.unwrap().is_local);
                }
            }
        })
        .await;
}

fn retain_local() -> RetainExecutorReferences {
    Rc::new(|ids, current| {
        assert!(ids.iter().all(|id| *id == Some("local")));
        assert!(current.is_empty());
        Ok(Box::new(|| {}))
    })
}

async fn seed_assignments(root: &Path) {
    ApiProviderAssignmentStore::initialize_fresh_workspace(root)
        .await
        .unwrap();
}

async fn oracle(mode: &str, config: &Path, workspace: &Path) -> Value {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/api_provider_oracle.ts");
    let output = tokio::process::Command::new("bun")
        .arg(script)
        .arg(mode)
        .arg(config)
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
async fn original_and_rust_round_trip_both_provider_files() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let config = root.path().join("config");
            let workspace = root.path().join("workspace");
            let seeded = oracle("seed", &config, &workspace).await;
            let id = seeded["id"].as_str().unwrap();
            let profiles = ApiProviderStore::open(config.to_str().unwrap(), Rc::new(SystemClock))
                .await
                .unwrap();
            let assignments = ApiProviderAssignmentStore::open(workspace.to_str().unwrap())
                .await
                .unwrap();
            let profile = profiles.get_api_provider(id).unwrap().unwrap();
            assert_eq!(profile.endpoints[0].api_key, "BunSyntheticKey");
            assert_eq!(profile.endpoints[0].models[0].value, "default");
            assert_eq!(
                profile.endpoints[0].headers.as_ref().unwrap()["X-OpenRouter-Title"],
                "Garcon"
            );
            assert_eq!(
                serde_json::to_value(assignments.snapshot().unwrap()).unwrap(),
                seeded["assignments"]
            );
            profiles
                .update_api_provider(
                    id.into(),
                    UpdateApiProviderInput {
                        label: Some("Rust renamed".into()),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
            assignments
                .unassign("local".into(), id.into(), retain_local(), None)
                .await
                .unwrap();
            let reread = oracle("check-and-change", &config, &workspace).await;
            assert_eq!(reread["bytesMatch"], true);
            let profiles = ApiProviderStore::open(config.to_str().unwrap(), Rc::new(SystemClock))
                .await
                .unwrap();
            let assignments = ApiProviderAssignmentStore::open(workspace.to_str().unwrap())
                .await
                .unwrap();
            let profile = profiles.get_api_provider(id).unwrap().unwrap();
            assert_eq!(profile.label, "Bun renamed");
            assert_eq!(profile.revision, 3);
            assert!(profile.endpoints[0].api_key.is_empty());
            assert_eq!(
                serde_json::to_value(profiles.redacted_list().unwrap()).unwrap(),
                reread["profiles"]
            );
            assert_eq!(
                serde_json::to_value(assignments.snapshot().unwrap()).unwrap(),
                reread["assignments"]
            );
            #[cfg(unix)]
            for file in [
                config.join("api-providers.json"),
                workspace.join("api-provider-assignments.json"),
            ] {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    tokio::fs::metadata(file)
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
async fn migration_grants_only_the_legacy_seed_once_and_missing_current_policy_fails_closed() {
    LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().to_str().unwrap();
        tokio::fs::write(root.path().join("api-providers.json"), br#"{
          "version": 1,
          "apiProviders": [{"id":"legacy_profile","label":"Legacy","endpoints":[
            {"id":"legacy_openai","protocol":"openai-compatible","baseUrl":"legacy.example.invalid/v1","defaultModel":"base"}
          ]}]
        }"#).await.unwrap();
        let profiles = ApiProviderStore::open(dir, Rc::new(SystemClock)).await.unwrap();
        assert_eq!(profiles.legacy_provider_ids().unwrap(), ["legacy_profile"]);
        assert_eq!(profiles.get_api_provider("legacy_profile").unwrap().unwrap().revision, 1);
        let missing = ApiProviderAssignmentStore::open(dir).await.err().unwrap();
        assert_eq!(missing.to_string(), "Provider assignments are missing. Restore api-provider-assignments.json.");
        ApiProviderAssignmentStore::migrate(dir, &["local".into()], &profiles.legacy_provider_ids().unwrap()).await.unwrap();
        ApiProviderAssignmentStore::migrate(dir, &["local".into(), REMOTE.into()], &["new_profile".into()]).await.unwrap();
        let assignments = ApiProviderAssignmentStore::open(dir).await.unwrap();
        assert!(assignments.allows("local", "legacy_profile").unwrap());
        assert!(!assignments.allows("local", "new_profile").unwrap());
        assert!(!assignments.allows(REMOTE, "legacy_profile").unwrap());

        let path = root.path().join("api-provider-assignments.json");
        tokio::fs::write(&path, br#"{"version":1,"revision":0,"assignments":{"local":["legacy_profile","legacy_profile"]}}"#).await.unwrap();
        let corrupt = ApiProviderAssignmentStore::open(dir).await.err().unwrap();
        assert!(corrupt.to_string().starts_with("State file api-provider-assignments.json is corrupt."));
        assert!(ApiProviderAssignmentStore::migrate(dir, &["local".into()], &["legacy_profile".into()]).await.is_err());
        assert!(!path.exists());
    }).await;
}

#[tokio::test]
async fn metadata_revision_assignment_and_provider_identity_are_checked_at_credential_release() {
    LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().to_str().unwrap();
        seed_assignments(root.path()).await;
        let profiles = ApiProviderStore::open(dir, Rc::new(SystemClock)).await.unwrap();
        let assignments = ApiProviderAssignmentStore::open(dir).await.unwrap();
        let access = ApiProviderAccess::new(profiles, assignments, Rc::new(|id| matches!(id, "local" | REMOTE)));
        let service = ApiProviderService::new(access.clone());
        let created = service.create(create_input(), "local", retain_local()).await.unwrap();
        assert_eq!(created.assignment.status, ApiProviderAssignmentStatus::Assigned);
        let id = created.entry.id;
        let reference = AgentCredentialReference {
            kind: AgentCredentialReferenceKind::ApiProviderEndpoint,
            api_provider_id: id.clone(), endpoint_id: created.entry.endpoints[0].id.clone(), revision: 1,
        };
        assert_eq!(access.resolve_credential("local", &reference).unwrap().value, "RustSyntheticKey");
        let denied = access.resolve_credential(REMOTE, &reference).err().unwrap();
        assert_eq!(denied.downcast_ref::<AgentCallError>().unwrap().code, AgentIntegrationErrorCode::API_PROVIDER_UNAVAILABLE);
        let mut wrong_endpoint = reference.clone();
        wrong_endpoint.endpoint_id = "other_openai".into();
        assert!(access.resolve_credential("local", &wrong_endpoint).is_err());

        let discovery = json!({"protocol":"openai-compatible","baseUrl":"https://different.example.invalid/",
            "apiProviderId":id,"endpointId":reference.endpoint_id,"revision":1});
        let PreparedDiscovery::Answer(answer) = service.prepare_discovery(&discovery, "local").unwrap() else { panic!("stored key changed destination") };
        assert_eq!(answer.error.as_deref(), Some("Enter the API key for this base URL before fetching models."));
        let mut discovery = discovery;
        discovery["baseUrl"] = json!("https://provider.example.invalid/alternate");
        let PreparedDiscovery::Request(request) = service.prepare_discovery(&discovery, "local").unwrap() else { panic!("same-origin key denied") };
        assert_eq!(request.api_key.as_deref(), Some("RustSyntheticKey"));
        assert!(service.prepare_discovery(&discovery, REMOTE).is_err());

        let updated = service.update(id.clone(), json!({"revision":1,"endpoint":{"clearApiKey":true}}), retain_local()).await.unwrap();
        assert_eq!(updated.entry.revision, 2);
        let stale = access.resolve_credential("local", &reference).err().unwrap();
        assert_eq!(stale.downcast_ref::<AgentCallError>().unwrap().code, AgentIntegrationErrorCode::API_PROVIDER_CONFIGURATION_CHANGED);
        let mut reference = reference;
        reference.revision = 2;
        assert!(access.resolve_credential("local", &reference).unwrap().value.is_empty());
        service.unassign("local".into(), id, retain_local(), None).await.unwrap();
        assert!(access.resolve_credential("local", &reference).is_err());
    }).await;
}

#[derive(Default)]
struct FaultWriter {
    disk: JsonFileStore,
    fail: Cell<Option<bool>>,
}

#[async_trait::async_trait(?Send)]
impl<T: Serialize> SnapshotWriter<T> for FaultWriter {
    async fn write(&self, path: &str, value: &T) -> Result<()> {
        if let Some(renamed) = self.fail.take() {
            let source = "synthetic provider disk failure".into();
            return if renamed {
                self.disk.write(path, value).await?;
                Err(UncertainWrite(source).into())
            } else {
                Err(source)
            };
        }
        self.disk.write(path, value).await
    }
}

#[tokio::test]
async fn create_distinguishes_an_uncertain_assignment_from_a_definite_unassigned_profile() {
    LocalSet::new()
        .run_until(async {
            for (renamed, expected) in [
                (false, ApiProviderAssignmentStatus::NotAssigned),
                (true, ApiProviderAssignmentStatus::Unknown),
            ] {
                let root = tempfile::tempdir().unwrap();
                let dir = root.path().to_str().unwrap();
                seed_assignments(root.path()).await;
                let profiles = ApiProviderStore::open(dir, Rc::new(SystemClock))
                    .await
                    .unwrap();
                let writer = Rc::new(FaultWriter::default());
                let assignments = ApiProviderAssignmentStore::open_with_writer(dir, writer.clone())
                    .await
                    .unwrap();
                let notified = Rc::new(Cell::new(0));
                let _off = assignments.on_changed({
                    let notified = notified.clone();
                    Rc::new(move || {
                        notified.set(notified.get() + 1);
                        Ok(())
                    })
                });
                let access =
                    ApiProviderAccess::new(profiles, assignments, Rc::new(|id| id == "local"));
                let service = ApiProviderService::new(access.clone());
                writer.fail.set(Some(renamed));
                let made = service
                    .create(create_input(), "local", retain_local())
                    .await
                    .unwrap();
                assert_eq!(made.assignment.status, expected);
                assert_eq!(notified.get(), usize::from(renamed));
                assert!(
                    access
                        .store
                        .get_api_provider(&made.entry.id)
                        .unwrap()
                        .is_some()
                );
                assert!(service.get_catalog("local").unwrap().is_empty());
                if renamed {
                    let error = service.management().err().unwrap();
                    assert_eq!(
                        as_domain_error(error.as_ref()).unwrap().code,
                        ErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE
                    );
                } else {
                    assert!(
                        service
                            .management()
                            .unwrap()
                            .assignments
                            .assignments
                            .is_empty()
                    );
                }
                let reopened = ApiProviderAssignmentStore::open(dir).await.unwrap();
                assert_eq!(reopened.allows("local", &made.entry.id).unwrap(), renamed);
            }
        })
        .await;
}

#[tokio::test]
async fn queued_assignment_changes_recheck_authority_and_hold_references_through_publication() {
    #[derive(Default)]
    struct PausedWriter {
        started: Notify,
        resume: Notify,
    }

    #[async_trait::async_trait(?Send)]
    impl<T: Serialize> SnapshotWriter<T> for PausedWriter {
        async fn write(&self, path: &str, value: &T) -> Result<()> {
            self.started.notify_one();
            self.resume.notified().await;
            JsonFileStore::default().write(path, value).await
        }
    }

    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            seed_assignments(root.path()).await;
            let writer = Rc::new(PausedWriter::default());
            let store = ApiProviderAssignmentStore::open_with_writer(
                root.path().to_str().unwrap(),
                writer.clone(),
            )
            .await
            .unwrap();
            let protected = Rc::new(Cell::new(false));
            let retain: RetainExecutorReferences = Rc::new({
                let protected = protected.clone();
                move |ids, current| {
                    assert_eq!(ids, [Some("local"), Some(REMOTE)]);
                    assert!(current.is_empty());
                    assert!(!protected.replace(true));
                    let protected = protected.clone();
                    Ok(Box::new(move || assert!(protected.replace(false))))
                }
            });
            let notifications = Rc::new(Cell::new(0));
            let _off = store.on_changed({
                let protected = protected.clone();
                let notifications = notifications.clone();
                Rc::new(move || {
                    assert!(protected.get());
                    notifications.set(notifications.get() + 1);
                    Ok(())
                })
            });
            let first = tokio::task::spawn_local({
                let store = store.clone();
                let retain = retain.clone();
                async move {
                    store
                        .set_provider_executors(
                            "provider_a".into(),
                            vec!["local".into(), REMOTE.into()],
                            retain,
                        )
                        .await
                }
            });
            writer.started.notified().await;
            assert!(protected.get());
            assert_eq!(store.snapshot().unwrap().revision, 0);

            let current = Rc::new(Cell::new(true));
            let checked = Rc::new(Cell::new(0));
            let second = tokio::task::spawn_local({
                let store = store.clone();
                let current = current.clone();
                let checked = checked.clone();
                async move {
                    store
                        .assign(
                            "local".into(),
                            "provider_b".into(),
                            retain,
                            Some(Box::new(move || {
                                checked.set(checked.get() + 1);
                                if current.get() {
                                    Ok(())
                                } else {
                                    Err("delegated authority retired".into())
                                }
                            })),
                        )
                        .await
                }
            });
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
            assert_eq!(checked.get(), 0);
            current.set(false);
            writer.resume.notify_one();
            first.await.unwrap().unwrap();
            assert!(!protected.get());
            let error = second.await.unwrap().unwrap_err();
            assert_eq!(error.to_string(), "delegated authority retired");
            assert_eq!(checked.get(), 1);
            assert_eq!(notifications.get(), 1);
            let snapshot = store.snapshot().unwrap();
            assert_eq!(snapshot.revision, 1);
            assert_eq!(snapshot.assignments[REMOTE], ["provider_a"]);
        })
        .await;
}

#[tokio::test]
async fn reference_writes_block_deletion_and_uncertain_profiles_are_not_published() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let dir = root.path().to_str().unwrap();
            seed_assignments(root.path()).await;
            let writer = Rc::new(FaultWriter::default());
            let store =
                ApiProviderStore::open_with_writer(dir, Rc::new(SystemClock), writer.clone())
                    .await
                    .unwrap();
            let assignments = ApiProviderAssignmentStore::open(dir).await.unwrap();
            let service = ApiProviderService::new(ApiProviderAccess::new(
                store.clone(),
                assignments,
                Rc::new(|id| id == "local"),
            ));
            let made = service
                .create(create_input(), "local", retain_local())
                .await
                .unwrap();
            let id = made.entry.id;
            let release = store
                .retain_references(std::slice::from_ref(&id), &[])
                .unwrap();
            let error = service.delete(id.clone(), |_| Ok(false)).await.unwrap_err();
            assert_eq!(
                as_domain_error(error.as_ref()).unwrap().code,
                ErrorCode::API_PROVIDER_IN_USE
            );
            release();

            let count = Rc::new(Cell::new(0));
            let _off = store.on_changed({
                let count = count.clone();
                Rc::new(move || {
                    count.set(count.get() + 1);
                    Ok(())
                })
            });
            writer.fail.set(Some(false));
            assert!(
                service
                    .update(id.clone(), json!({"label":"definite"}), retain_local())
                    .await
                    .is_err()
            );
            assert_eq!(
                store.get_api_provider(&id).unwrap().unwrap().label,
                "Fixture"
            );
            writer.fail.set(Some(true));
            assert!(
                service
                    .update(id.clone(), json!({"label":"uncertain"}), retain_local())
                    .await
                    .is_err()
            );
            assert!(store.get_api_provider(&id).is_err());
            assert_eq!(count.get(), 2);
            let reopened = ApiProviderStore::open(dir, Rc::new(SystemClock))
                .await
                .unwrap();
            assert_eq!(
                reopened.get_api_provider(&id).unwrap().unwrap().label,
                "uncertain"
            );
        })
        .await;
}
