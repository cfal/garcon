use std::rc::Rc;

use async_trait::async_trait;
use garcon_chats::{
    registry_entry_codec::normalize_chat_registry_entry,
    store::{ChatRegistry, ChatRegistryPatch, NewChatRegistryEntry},
};
use garcon_contract::{
    agent_integration::{AgentDescriptor, AgentSettingsEnvelope},
    chat_id::parse_chat_id,
    executors::AgentExecutionTarget,
    transcript_seed::{NativeSeedPlacement, NativeSeedReceiptInput, create_native_seed_receipt},
};
use garcon_execution::{
    agent_registry::AdoptionChatRegistry,
    directory::{AgentDirectory, ExecutionIntegrationDirectory},
};
use garcon_interface::{
    execution::AgentRunningSession,
    execution_v5::{
        AgentExecutionHandle, AgentExecutionV5, AgentResumeRequestV5, AgentStartRequestV5,
    },
    integration::AgentIntegration,
    native_history::{AgentHistoryImport, AgentHistoryImportRequest, AgentHistoryStream},
    producer::{
        AgentPermissionRespondRequest, AgentPermissions, AgentProducerBindRequest,
        AgentProducerNotification, AgentProducers,
    },
    resources::{
        AgentInstanceCallOptions, AgentProducerBinding, AgentResourceScope, ExecutorCallOptions,
        ExecutorResult,
    },
    services::{
        AgentCatalog, AgentCatalogRequest, AgentCatalogSnapshot, AgentLifecycle, AgentMigration,
        AgentTranslateLegacyModelRequest, AgentTranslateLegacyNativeSessionRequest,
        AgentTranslateLegacySettingsRequest,
    },
    transcript::AgentNativeSessionRef,
    versioned_settings::VersionedSettings,
};
use garcon_js::json::Opaque;
use garcon_ledger::adoption::{
    TranscriptAdoptionIntegrations, TranscriptAdoptionRegistry, TranscriptSessionCache,
};
use serde_json::json;
use tokio::task::LocalSet;

const REMOTE: &str = "11111111-1111-4111-8111-111111111111";
const CHAT: &str = "1783725900000200";
const SEGMENT: &str = "9df00801-0000-1000-9000-000000000009";

#[tokio::test]
async fn captures_one_registry_entry_and_repairs_only_the_session_cache() {
    LocalSet::new().run_until(async {
        let root = tempfile::tempdir().unwrap();
        let registry = ChatRegistry::open(root.path()).await.unwrap();
        let raw = json!({
            "executorId": REMOTE, "agentId": "test", "agentOwnershipEpoch": "owner-a",
            "projectPath": "/project", "model": "test-model", "tags": ["keep"],
            "agentSettingsById": {"test": {"ownerId": "test", "schemaVersion": 3, "values": {}}},
            "agentSessionId": "chat-registry-session",
            "nativeSession": {"ownerId": "test", "schemaVersion": 1, "value": {"old": true}},
            "nativeSeedReceipt": null,
            "carryOverSegments": [{
                "id": SEGMENT, "agentId": "test", "model": "previous-model", "capturedAt": "2026-11-28T12:00:00.000Z",
                "storedMessageCount": 2, "visibleMessageCount": 1, "trailingHandoff": null,
            }],
            "carryOverMigrationQuarantine": {"artifactId": "synthetic-quarantine", "errorCode": "MIGRATION_FAILED"},
            "parentChatId": null, "lineage": null,
        });
        let entry = normalize_chat_registry_entry(raw.as_object().unwrap(), CHAT).unwrap();
        registry.add_chat(NewChatRegistryEntry { id: parse_chat_id(&json!(CHAT)).unwrap(), entry }).unwrap();
        let adapter = AdoptionChatRegistry::new(registry.clone());
        assert!(adapter.get_chat("absent").is_none());
        let captured = adapter.get_chat(CHAT).unwrap();
        assert_eq!(captured.agent_id, "test");
        assert_eq!(captured.executor_id.as_deref(), Some(REMOTE));
        assert_eq!(captured.ownership_epoch, "owner-a");
        assert_eq!(captured.project_path, "/project");
        assert_eq!(captured.model, "test-model");
        assert_eq!(captured.settings_by_agent["test"].schema_version, 3);
            assert_eq!(captured.carryover.len(), 1);
        assert_eq!(captured.carryover[0].id, SEGMENT);
        let quarantine = captured.quarantine.as_ref().unwrap();
        assert_eq!(quarantine.artifact_id, "synthetic-quarantine");
        assert_eq!(quarantine.error_code, "MIGRATION_FAILED");
        assert_eq!(captured.session.agent_session_id.as_deref(), Some("chat-registry-session"));

        let cache = TranscriptSessionCache {
            agent_session_id: Some("ledger-session".into()),
            native_session: Some(AgentNativeSessionRef {
                owner_id: "test".into(), schema_version: 1,
                value: Opaque::from_value(json!({"current": true})),
            }),
            native_seed_receipt: Some(create_native_seed_receipt(NativeSeedReceiptInput {
                agent_session_id: "ledger-session", placement: NativeSeedPlacement::UserPrefix,
                prefix: "synthetic", format: None,
            }).unwrap()),
        };
        adapter.update_session_cache(CHAT, cache.clone()).unwrap();
        let repaired = adapter.get_chat(CHAT).unwrap();
        assert_eq!(repaired.session, cache);
        assert_eq!(repaired.ownership_epoch, captured.ownership_epoch);
        assert_eq!(repaired.carryover, captured.carryover);
        assert_eq!(repaired.settings_by_agent, captured.settings_by_agent);
        assert_eq!(registry.get_chat(CHAT).unwrap().tags, ["keep"]);
        let invalid = TranscriptSessionCache { agent_session_id: Some("wrong-session".into()), ..cache.clone() };
        assert!(adapter.update_session_cache(CHAT, invalid).is_err());
        assert_eq!(adapter.get_chat(CHAT).unwrap().session, cache);

        registry.update_chat(CHAT, ChatRegistryPatch { carry_over_segments: Some(vec![]), ..Default::default() }).unwrap();
        adapter.update_session_cache(CHAT, TranscriptSessionCache::default()).unwrap();
        assert_eq!(adapter.get_chat(CHAT).unwrap().session, TranscriptSessionCache::default());
        assert!(adapter.get_chat(CHAT).unwrap().carryover.is_empty());
        assert_eq!(captured.carryover[0].id, SEGMENT);
        assert_eq!(captured.session.agent_session_id.as_deref(), Some("chat-registry-session"));
        registry.flush().await.unwrap();
    }).await;
}

struct IdleFacets;

fn unused<T>() -> ExecutorResult<T> {
    Err("fixture facet should not be called".into())
}

#[async_trait(?Send)]
impl AgentExecutionV5 for IdleFacets {
    async fn start(
        &self,
        _: AgentStartRequestV5,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        unused()
    }
    async fn resume(
        &self,
        _: AgentResumeRequestV5,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        unused()
    }
    async fn abort(
        &self,
        _: AgentExecutionHandle,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<bool> {
        unused()
    }
    async fn running_sessions(
        &self,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Vec<AgentRunningSession>> {
        unused()
    }
}

#[async_trait(?Send)]
impl AgentProducers for IdleFacets {
    fn scope(&self) -> ExecutorResult<AgentResourceScope> {
        unused()
    }
    async fn bind(
        &self,
        _: AgentProducerBindRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        unused()
    }
    async fn close(
        &self,
        _: AgentProducerBinding,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        unused()
    }
    fn detach(&self, _: AgentProducerBinding) {
        panic!("fixture producer must not detach");
    }
    fn subscribe(
        &self,
        _: Rc<dyn Fn(AgentProducerNotification) -> ExecutorResult<()>>,
    ) -> Box<dyn Fn()> {
        panic!("fixture producer must not subscribe");
    }
}

#[async_trait(?Send)]
impl AgentPermissions for IdleFacets {
    async fn respond(
        &self,
        _: AgentPermissionRespondRequest,
        _: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        unused()
    }
}

#[async_trait(?Send)]
impl AgentCatalog for IdleFacets {
    async fn snapshot(&self, _: AgentCatalogRequest) -> ExecutorResult<AgentCatalogSnapshot> {
        unused()
    }
}

#[async_trait(?Send)]
impl AgentLifecycle for IdleFacets {
    async fn start(&self) -> ExecutorResult<()> {
        unused()
    }
    async fn stop(&self) -> ExecutorResult<()> {
        unused()
    }
    async fn migrate_owned_storage(&self) -> ExecutorResult<()> {
        unused()
    }
}

#[async_trait(?Send)]
impl AgentMigration for IdleFacets {
    async fn translate_legacy_model(
        &self,
        _: AgentTranslateLegacyModelRequest,
    ) -> ExecutorResult<String> {
        unused()
    }
    async fn translate_legacy_native_session(
        &self,
        _: AgentTranslateLegacyNativeSessionRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        unused()
    }
    async fn translate_legacy_settings(
        &self,
        _: AgentTranslateLegacySettingsRequest,
    ) -> ExecutorResult<Option<AgentSettingsEnvelope>> {
        unused()
    }
}

struct History;

impl AgentHistoryImport for History {
    fn load(
        &self,
        _: AgentHistoryImportRequest,
        _: Option<AgentInstanceCallOptions>,
    ) -> AgentHistoryStream<'_> {
        panic!("the adapter must not load history");
    }
}

struct DirectoryFixture(Rc<AgentIntegration>);

impl ExecutionIntegrationDirectory for DirectoryFixture {
    fn require_integration(
        &self,
        target: &AgentExecutionTarget,
    ) -> ExecutorResult<Rc<AgentIntegration>> {
        assert_eq!(target.executor_id, REMOTE);
        assert_eq!(target.agent_id, "test");
        Ok(self.0.clone())
    }
    fn known_integration(&self, _: &AgentExecutionTarget) -> Option<Rc<AgentIntegration>> {
        None
    }
    fn integrations_for(&self, _: &str) -> ExecutorResult<Vec<Rc<AgentIntegration>>> {
        unused()
    }
    fn is_ready(&self, _: &str) -> bool {
        false
    }
}

#[test]
fn integration_adapter_passes_only_the_selected_executors_legacy_importer() {
    let idle = Rc::new(IdleFacets);
    let native: Rc<dyn AgentHistoryImport> = Rc::new(History);
    let legacy: Rc<dyn AgentHistoryImport> = Rc::new(History);
    let settings: Rc<dyn garcon_interface::services::AgentSettings> =
        Rc::new(VersionedSettings::new(
            AgentSettingsEnvelope {
                owner_id: "test".into(),
                schema_version: 3,
                values: Opaque::from_value(json!({})),
            },
            vec![],
            None,
        ));
    for expected in [None, Some(legacy)] {
        let integration = Rc::new(AgentIntegration {
            descriptor: AgentDescriptor {
                id: "test".into(),
                label: "Test".into(),
                icon: None,
                supported_permission_modes: vec![],
                supported_thinking_modes: vec![],
                supports_images: false,
                supports_project_path_update: false,
                requires_native_path_for_project_path_update: false,
                supported_endpoint_protocols: vec![],
                configuration: vec![],
            },
            literal_execution: None,
            attachments: None,
            execution: idle.clone(),
            producers: idle.clone(),
            permissions: idle.clone(),
            catalog: idle.clone(),
            settings: settings.clone(),
            lifecycle: idle.clone(),
            migration: idle.clone(),
            readiness: None,
            auth: None,
            commands: None,
            compaction: None,
            forking: None,
            steering: None,
            endpoints: None,
            single_query: None,
            legacy_history_import: expected.clone(),
            native_history_import: Some(native.clone()),
            native_activity: None,
            native_sessions: None,
            configuration_validation: None,
            session_configuration: None,
            project_path_updates: None,
            usage_history: None,
            cli_updates: None,
        });
        let directory = AgentDirectory::new(Rc::new(DirectoryFixture(integration)));
        let projection =
            TranscriptAdoptionIntegrations::require(&directory, "test", Some(REMOTE)).unwrap();
        assert_eq!(projection.agent_id, "test");
        assert!(Rc::ptr_eq(&projection.settings, &settings));
        match expected {
            Some(legacy) => assert!(Rc::ptr_eq(projection.importer.as_ref().unwrap(), &legacy)),
            None => assert!(projection.importer.is_none()),
        }
    }
}
