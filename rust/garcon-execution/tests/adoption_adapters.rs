use std::{cell::RefCell, rc::Rc};

use async_trait::async_trait;
use garcon_base::{
    log::{Logger, create_logger},
    unhandled_rejection_policy::install_unhandled_rejection_policy,
};
use garcon_cases::{CaseError, replay, text};
use garcon_chats::{
    registry_entry_codec::normalize_chat_registry_entry,
    store::{ChatRegistry, ChatRegistryPatch, NewChatRegistryEntry},
};
use garcon_contract::{
    agent_integration::{AgentDescriptor, AgentSettingsEnvelope},
    chat_id::parse_chat_id,
    chat_transient_feed::ChatTransientControlAction,
    executors::AgentExecutionTarget,
    transcript_seed::{NativeSeedPlacement, NativeSeedReceiptInput, create_native_seed_receipt},
};
use garcon_execution::{
    agent_registry::{AdoptionChatRegistry, AgentRegistry, AgentRegistryOptions},
    directory::{AgentDirectory, ExecutionIntegrationDirectory},
    runtime_router::{
        AgentRuntimeRouterOptions, RouterPermissionClaim, RoutingChat, RuntimeRouterChats,
        RuntimeRouterLedger,
    },
};
use garcon_interface::{
    execution::AgentRunningSession,
    execution_v5::{
        AgentExecutionHandle, AgentExecutionV5, AgentResumeRequestV5, AgentStartRequestV5,
    },
    integration::AgentIntegration,
    native_history::{
        AgentHistoryImport, AgentHistoryImportRequest, AgentHistoryStream,
        AgentNativeSessionAccess, AgentNativeSessionReleaseRequest,
    },
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
        AgentSettings, AgentTranslateLegacyModelRequest, AgentTranslateLegacyNativeSessionRequest,
        AgentTranslateLegacySettingsRequest,
    },
    transcript::{AgentNativeSessionRef, AgentTranscriptSourceLocation},
    versioned_settings::VersionedSettings,
};
use garcon_js::json::Opaque;
use garcon_ledger::adoption::{
    TranscriptAdoptionIntegrations, TranscriptAdoptionRegistry, TranscriptSessionCache,
};
use serde_json::{Value, json};
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
    let native: Rc<dyn AgentHistoryImport> = Rc::new(History);
    let legacy: Rc<dyn AgentHistoryImport> = Rc::new(History);
    for expected in [None, Some(legacy)] {
        let integration = fixture_integration(expected.clone(), Some(native.clone()), None);
        let settings = integration.settings.clone();
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

fn fixture_integration(
    legacy_history_import: Option<Rc<dyn AgentHistoryImport>>,
    native_history_import: Option<Rc<dyn AgentHistoryImport>>,
    native_sessions: Option<Rc<dyn AgentNativeSessionAccess>>,
) -> Rc<AgentIntegration> {
    let idle = Rc::new(IdleFacets);
    let settings: Rc<dyn AgentSettings> = Rc::new(VersionedSettings::new(
        AgentSettingsEnvelope {
            owner_id: "test".into(),
            schema_version: 3,
            values: Opaque::from_value(json!({})),
        },
        vec![],
        None,
    ));
    Rc::new(AgentIntegration {
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
        settings,
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
        legacy_history_import,
        native_history_import,
        native_activity: None,
        native_sessions,
        configuration_validation: None,
        session_configuration: None,
        project_path_updates: None,
        usage_history: None,
        cli_updates: None,
    })
}

type Effects = Rc<RefCell<Vec<Value>>>;

struct SourceDescription {
    scenario: String,
    effects: Effects,
}

#[async_trait(?Send)]
impl AgentNativeSessionAccess for SourceDescription {
    async fn resolve_native_session(
        &self,
        _: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>> {
        unused()
    }
    async fn release(&self, _: AgentNativeSessionReleaseRequest) -> ExecutorResult<()> {
        unused()
    }

    async fn describe_source(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>> {
        let chat = serde_json::to_string(&request.chat)?;
        self.effects
            .borrow_mut()
            .push(json!(["describe", chat, request.signal.is_cancelled()]));
        use AgentTranscriptSourceLocation::{FilesystemPath, ProviderReference};
        match self.scenario.as_str() {
            "failure" => Err("synthetic source failure".into()),
            "none" => Ok(None),
            "reference" => Ok(Some(ProviderReference { value: " ".into() })),
            "empty" => Ok(Some(FilesystemPath {
                value: String::new(),
            })),
            "path" => Ok(Some(FilesystemPath {
                value: "/synthetic/transcript.jsonl".into(),
            })),
            _ => Err("unavailable source fixture was called".into()),
        }
    }
}

struct SourceDirectory {
    integration: Option<Rc<AgentIntegration>>,
    effects: Effects,
}

impl ExecutionIntegrationDirectory for SourceDirectory {
    fn require_integration(
        &self,
        _: &AgentExecutionTarget,
    ) -> ExecutorResult<Rc<AgentIntegration>> {
        unused()
    }
    fn known_integration(&self, target: &AgentExecutionTarget) -> Option<Rc<AgentIntegration>> {
        self.effects
            .borrow_mut()
            .push(json!(["lookup", target.agent_id, target.executor_id]));
        self.integration.clone()
    }
    fn integrations_for(&self, _: &str) -> ExecutorResult<Vec<Rc<AgentIntegration>>> {
        unused()
    }
    fn is_ready(&self, _: &str) -> bool {
        false
    }
}

impl RuntimeRouterChats for IdleFacets {
    fn get_chat(&self, _: &str) -> Option<RoutingChat> {
        None
    }
}

impl RuntimeRouterLedger for IdleFacets {
    fn active_chat_ids(&self) -> Vec<String> {
        vec![]
    }
    fn is_run_active(&self, _: &str) -> bool {
        false
    }
    fn claim_permission_resolution(
        &self,
        _: &ChatTransientControlAction,
    ) -> ExecutorResult<Box<dyn RouterPermissionClaim>> {
        unused()
    }
    fn take_prepared_input(&self, _: &str, _: &str) -> ExecutorResult<()> {
        unused()
    }
}

#[derive(Default)]
struct Log(RefCell<Vec<String>>);

impl Logger for Log {
    fn debug(&self, _: &str) {}
    fn info(&self, _: &str) {}
    fn warn(&self, message: &str) {
        self.0.borrow_mut().push(message.into());
    }
    fn error(&self, _: &str) {}
}

async fn describe_source_trace(scenario: &str) -> Value {
    let effects = Effects::default();
    let access = (scenario != "unsupported").then(|| {
        Rc::new(SourceDescription {
            scenario: scenario.into(),
            effects: effects.clone(),
        }) as Rc<dyn AgentNativeSessionAccess>
    });
    let directory = Rc::new(AgentDirectory::new(Rc::new(SourceDirectory {
        integration: (scenario != "missing").then(|| fixture_integration(None, None, access)),
        effects: effects.clone(),
    })));
    let log = Rc::new(Log::default());
    let agent_registry = AgentRegistry::new(AgentRegistryOptions {
        runtime: AgentRuntimeRouterOptions {
            registry: Rc::new(IdleFacets),
            directory: directory.clone(),
            ledger: Rc::new(IdleFacets),
            unhandled_rejections: Rc::new(install_unhandled_rejection_policy(Rc::new(
                create_logger("test"),
            ))),
        },
        directory,
        get_carry_over_revision: Rc::new({
            let effects = effects.clone();
            move |session| {
                effects
                    .borrow_mut()
                    .push(json!(["revision", session.agent_ownership_epoch]));
                "frozen-revision".into()
            }
        }),
        logger: log.clone(),
    });
    let raw = json!({
        "agentId":"test", "executorId":REMOTE, "projectPath":"/project", "model":"sample-model",
        "agentSessionId":"native-1", "agentOwnershipEpoch":"owner-a", "agentSettingsById":{},
        "nativeSession":{"ownerId":"test", "schemaVersion":1, "value":{}}, "nativeSeedReceipt":null,
        "parentChatId":null, "lineage":null, "carryOverSegments":[], "carryOverMigrationQuarantine":null,
    });
    let mut session = normalize_chat_registry_entry(raw.as_object().unwrap(), "chat-1").unwrap();
    if scenario == "owner" {
        session.native_session.as_mut().unwrap().owner_id = "other".into();
    }
    let source = agent_registry
        .describe_transcript_source(&session, "chat-1")
        .await;
    let warnings = log.0.borrow();
    for warning in warnings.iter() {
        assert!(warning.contains("TRANSCRIPT_SOURCE_DESCRIPTION_FAILED"));
        assert!(!warning.contains("synthetic source failure"));
    }
    json!({ "source": source, "effects": *effects.borrow(), "warnings": warnings.len() })
}

#[test]
fn transcript_source_descriptions_match_the_original() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/transcript-source"),
        |function, args| {
            if function != "describeSourceTrace" {
                return Err(CaseError::unhandled(function));
            }
            let scenario = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("missing source scenario"))?;
            Ok(runtime.block_on(describe_source_trace(scenario)))
        },
    );
}
