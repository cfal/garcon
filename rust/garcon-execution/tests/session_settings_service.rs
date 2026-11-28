use std::{
    cell::{Cell, RefCell},
    io,
    rc::Rc,
    time::Duration,
};

use async_trait::async_trait;
use garcon_base::{
    domain_error::as_domain_error, keyed_lock::KeyedLock, log::create_logger,
    unhandled_rejection_policy::install_unhandled_rejection_policy,
};
use garcon_cases::{CaseError, replay, text};
use garcon_chats::{registry_contracts::ChatRegistryEntry, store::ChatRegistryPatch};
use garcon_contract::{
    agent_execution::AgentEndpointSelection,
    agent_integration::{AgentSettingDescriptor, AgentSettingsEnvelope},
    chat_modes::{PermissionMode, ThinkingMode},
    error_codes::ErrorCode,
    preambles::ChatPreambleSelection,
    queue_state::QueueEntryKind,
};
use garcon_execution::{
    control_state::{
        StoredChatExecutionControlState, StoredControlInput, StoredControlInputEntry,
        StoredQueueEntry, StoredQueueEntryStatus, empty_stored_chat_execution_control,
    },
    session_settings_service::{
        AgentConfigurationInput, AgentSessionSettingsService, AgentSessionSettingsServiceOptions,
        SettingsChatRegistry, SettingsControlOperation, SettingsEndpointResolver,
        SettingsExecutionPort, SettingsIntegration, SettingsIntegrationDirectory,
    },
    session_types::AgentSessionSettingsPatch,
    types::{ExecutionOperationResult, LocalExecutionFuture, TranscriptSnapshotReservation},
};
use garcon_interface::{
    execution::{
        AgentConfigurationValidation, AgentSessionConfiguration, AgentSessionConfigurationUpdate,
        AgentSessionConfigurationUpdates,
    },
    resources::{ExecutorCallOptions, ExecutorResult},
    services::AgentSettings,
};
use garcon_js::{OptionalNullable, json::Opaque};
use garcon_stores::api_providers::endpoint_resolver::{
    ModelSelectionInput, PreviousModelSelectionInput, ResolvedModelSelection,
};
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::{sync::Notify, task::LocalSet};

const CHAT: &str = "chat-1";
const KEY: &str = "chat:chat-1";
const DEADLINE: f64 = 20_000.0;

struct Settings;

#[async_trait(?Send)]
impl AgentSettings for Settings {
    fn describe(&self) -> &[AgentSettingDescriptor] {
        &[]
    }

    fn defaults(&self) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(AgentSettingsEnvelope {
            owner_id: "test".into(),
            schema_version: 2,
            values: Opaque::from_value(json!({})),
        })
    }

    fn parse(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(input)
    }

    async fn migrate(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(input)
    }

    fn apply_patch(
        &self,
        settings: AgentSettingsEnvelope,
        _: IndexMap<String, Opaque>,
    ) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(settings)
    }
}

struct Host {
    saved: RefCell<ChatRegistryEntry>,
    control: RefCell<StoredChatExecutionControlState>,
    effects: RefCell<Vec<&'static str>>,
    literal: Cell<bool>,
    validation: Cell<bool>,
    live: Cell<bool>,
    admitted: Cell<bool>,
    reservation: Cell<bool>,
    control_locked: Cell<bool>,
    late_input: Cell<bool>,
    blocked: Cell<bool>,
    failure: Cell<Option<&'static str>>,
    apply_waiting: Notify,
    wait_for_worker: Notify,
    save_waiting: Notify,
    wait_for_disk: Notify,
    configurations: RefCell<Vec<(AgentSessionConfigurationUpdate, AgentSessionConfiguration)>>,
    dispatch_deadlines: RefCell<Vec<f64>>,
}

impl Host {
    fn new() -> Self {
        Self {
            saved: RefCell::new(ChatRegistryEntry {
                executor_id: OptionalNullable::some("local".into()),
                agent_id: "test".into(),
                agent_session_id: Some("native".into()),
                native_session: None,
                agent_ownership_epoch: "owner".into(),
                agent_settings_by_id: IndexMap::new(),
                project_path: "/project".into(),
                tags: vec![],
                model: "medium".into(),
                api_provider_id: None,
                model_endpoint_id: None,
                model_protocol: None,
                last_read_at: OptionalNullable::ABSENT,
                permission_mode: PermissionMode::BypassPermissions,
                thinking_mode: ThinkingMode::High,
                carry_over_segments: vec![],
                native_seed_receipt: None,
                carry_over_migration_quarantine: None,
                pending_preamble_boundary: None,
                preamble_selection: ChatPreambleSelection {
                    revision: 0,
                    ordered_preamble_ids: vec![],
                },
                parent_chat_id: None,
                lineage: None,
            }),
            control: RefCell::new(empty_stored_chat_execution_control("server")),
            effects: RefCell::default(),
            literal: Cell::default(),
            validation: Cell::new(true),
            live: Cell::new(true),
            admitted: Cell::default(),
            reservation: Cell::default(),
            control_locked: Cell::default(),
            late_input: Cell::default(),
            blocked: Cell::default(),
            failure: Cell::default(),
            apply_waiting: Notify::new(),
            wait_for_worker: Notify::new(),
            save_waiting: Notify::new(),
            wait_for_disk: Notify::new(),
            configurations: RefCell::default(),
            dispatch_deadlines: RefCell::default(),
        }
    }

    fn effect(&self, value: &'static str) {
        self.effects.borrow_mut().push(value);
    }

    fn fail(&self, phase: &'static str) -> ExecutorResult<()> {
        if self.failure.get() == Some(phase) {
            Err(io::Error::other("synthetic failure").into())
        } else {
            Ok(())
        }
    }

    fn queue(&self, control: bool) {
        let mut state = self.control.borrow_mut();
        if control {
            state.control_entries.push(StoredControlInputEntry {
                id: "pending".into(),
                input: StoredControlInput {
                    content: "input".into(),
                    transcript_view_id: "view".into(),
                    created_at: String::new(),
                    receipt: None,
                },
            });
        } else {
            state.entries.push(StoredQueueEntry {
                id: "pending".into(),
                content: "input".into(),
                images: vec![],
                kind: QueueEntryKind::Turn,
                revision: 1,
                status: StoredQueueEntryStatus::Queued,
                created_at: String::new(),
                updated_at: String::new(),
                submission: None,
            });
        }
    }
}

#[async_trait(?Send)]
impl SettingsChatRegistry for Host {
    fn get_chat(&self, chat: &str) -> Option<ChatRegistryEntry> {
        (chat == CHAT).then(|| self.saved.borrow().clone())
    }

    async fn update_chat_flushed(
        self: Rc<Self>,
        chat: &str,
        patch: ChatRegistryPatch,
    ) -> ExecutionOperationResult<Option<ChatRegistryEntry>> {
        assert_eq!(chat, CHAT);
        self.effect("save");
        if self.reservation.get() {
            assert!(self.control_locked.get());
        }
        self.save_waiting.notify_one();
        if self.blocked.get() {
            self.wait_for_disk.notified().await;
        }
        self.fail("save")?;
        let mut saved = self.saved.borrow_mut();
        saved.model = patch.model.unwrap();
        saved.api_provider_id = patch.api_provider_id.unwrap();
        saved.model_endpoint_id = patch.model_endpoint_id.unwrap();
        saved.model_protocol = patch.model_protocol.unwrap();
        saved.permission_mode = patch.permission_mode.unwrap();
        saved.thinking_mode = patch.thinking_mode.unwrap();
        saved.agent_settings_by_id = patch.agent_settings_by_id.unwrap();
        Ok(Some(saved.clone()))
    }
}

struct Directory(Rc<Host>);

impl SettingsIntegrationDirectory for Directory {
    fn require_settings_integration(
        &self,
        _: &str,
        _: Option<&str>,
    ) -> ExecutionOperationResult<SettingsIntegration> {
        let host = &self.0;
        host.effect("require");
        Ok(SettingsIntegration {
            literal_execution: host.literal.get(),
            supported_thinking_modes: vec![],
            endpoints: None,
            configuration_validation: host
                .validation
                .get()
                .then(|| host.clone() as Rc<dyn AgentConfigurationValidation>),
            session_configuration: host
                .live
                .get()
                .then(|| host.clone() as Rc<dyn AgentSessionConfigurationUpdates>),
            settings: Rc::new(Settings),
        })
    }
}

fn native_route(model: &str) -> ResolvedModelSelection {
    ResolvedModelSelection {
        model: model.into(),
        api_provider_id: None,
        endpoint_id: None,
        protocol: None,
        is_local: false,
        executor_id: None,
        endpoint: None,
    }
}

impl SettingsEndpointResolver for Host {
    fn resolve_selection(
        &self,
        selection: ModelSelectionInput<'_>,
    ) -> ExecutionOperationResult<ResolvedModelSelection> {
        self.effect("resolve");
        self.fail("resolve")?;
        Ok(native_route(selection.model))
    }

    fn describe_previous(
        &self,
        selection: PreviousModelSelectionInput<'_>,
    ) -> ExecutionOperationResult<ResolvedModelSelection> {
        self.effect("previous");
        Ok(native_route(selection.model))
    }

    fn to_agent_endpoint_selection(
        &self,
        route: &ResolvedModelSelection,
    ) -> ExecutionOperationResult<Option<AgentEndpointSelection>> {
        self.effect("endpoint");
        Ok(route.endpoint.clone())
    }

    fn assert_endpoint_reference(
        &self,
        _: &ResolvedModelSelection,
    ) -> ExecutionOperationResult<()> {
        self.effect("reference");
        self.fail("reference")
    }
}

#[async_trait(?Send)]
impl SettingsExecutionPort for Host {
    fn owns_execution(&self, _: &str) -> bool {
        self.reservation.get()
    }

    fn reserve_transcript_snapshot(
        &self,
        chat: &str,
    ) -> ExecutionOperationResult<TranscriptSnapshotReservation> {
        self.effect("reserve");
        assert!(!self.reservation.replace(true));
        Ok(TranscriptSnapshotReservation {
            chat_id: chat.into(),
            reservation_id: "reservation".into(),
        })
    }

    async fn release_transcript_snapshot(
        &self,
        _: &TranscriptSnapshotReservation,
    ) -> ExecutionOperationResult<()> {
        assert!(!self.control_locked.get());
        assert!(self.reservation.replace(false));
        self.effect("release");
        Ok(())
    }

    async fn read_chat_execution_control(
        &self,
        _: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.effect("read-control");
        Ok(self.control.borrow().clone())
    }

    fn with_chat_execution_control<'a>(
        &'a self,
        _: &'a str,
        operation: SettingsControlOperation<'a>,
    ) -> LocalExecutionFuture<'a, ChatRegistryEntry> {
        Box::pin(async move {
            assert!(!self.control_locked.replace(true));
            self.effect("lock-control");
            let state = self.control.borrow().clone();
            let result = operation(state).await;
            self.control_locked.set(false);
            self.effect("unlock-control");
            result
        })
    }
}

#[async_trait(?Send)]
impl AgentConfigurationValidation for Host {
    async fn validate(
        &self,
        _: AgentSessionConfiguration,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        self.effect("validate");
        if let Some(options) = options {
            self.dispatch_deadlines
                .borrow_mut()
                .push(options.dispatch_deadline.unwrap());
            assert!(options.timeout_ms.is_some());
        }
        if self.late_input.get() {
            self.queue(true);
        }
        self.fail("validate")
    }
}

#[async_trait(?Send)]
impl AgentSessionConfigurationUpdates for Host {
    async fn apply(
        &self,
        session: &str,
        configuration: AgentSessionConfigurationUpdate,
        previous: AgentSessionConfiguration,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        assert_eq!(session, "native");
        let options = options.unwrap();
        self.dispatch_deadlines
            .borrow_mut()
            .push(options.dispatch_deadline.unwrap());
        assert!(options.timeout_ms.is_none() && options.signal.is_none());
        self.effect("apply");
        self.configurations
            .borrow_mut()
            .push((configuration, previous));
        self.apply_waiting.notify_one();
        if self.blocked.get() {
            self.wait_for_worker.notified().await;
        }
        self.fail("apply")
    }
}

struct Fixture {
    host: Rc<Host>,
    service: Rc<AgentSessionSettingsService>,
    chat_mutation: Rc<KeyedLock>,
    selection_admission: Rc<KeyedLock>,
}

impl Fixture {
    fn new() -> Self {
        Self::with_deadline(|| DEADLINE)
    }

    fn with_deadline(deadline: impl Fn() -> f64 + 'static) -> Self {
        let host = Rc::new(Host::new());
        let selection_admission = Rc::new(KeyedLock::new());
        let chat_mutation = Rc::new(KeyedLock::new());
        let service = Rc::new(AgentSessionSettingsService::with_deadline(
            AgentSessionSettingsServiceOptions {
                registry: host.clone(),
                directory: Rc::new(Directory(host.clone())),
                endpoint_resolver: host.clone(),
                get_execution: Rc::new({
                    let host = host.clone();
                    move || host.clone()
                }),
                has_admitted_provider_turn: Rc::new({
                    let host = host.clone();
                    move |_| host.admitted.get()
                }),
                chat_mutation_lock: chat_mutation.clone(),
                selection_admission_lock: selection_admission.clone(),
                on_committed: Some(Rc::new({
                    let host = host.clone();
                    move |_| {
                        host.effect("committed");
                        Ok(())
                    }
                })),
                unhandled_rejections: Rc::new(install_unhandled_rejection_policy(Rc::new(
                    create_logger("settings-test"),
                ))),
            },
            deadline,
        ));
        Self {
            host,
            service,
            chat_mutation,
            selection_admission,
        }
    }

    async fn update(&self, model: &str) -> ExecutionOperationResult<ChatRegistryEntry> {
        self.service
            .update_session_settings(
                CHAT,
                AgentSessionSettingsPatch {
                    model: Some(model.into()),
                    ..Default::default()
                },
                None,
                None,
            )
            .await
    }
}

fn configuration_input() -> AgentConfigurationInput {
    AgentConfigurationInput {
        executor_id: Some("remote".into()),
        agent_id: "test".into(),
        model: "model".into(),
        api_provider_id: Some("provider".into()),
        model_endpoint_id: Some("endpoint".into()),
        permission_mode: PermissionMode::Default,
        thinking_mode: ThinkingMode::None,
        agent_settings: Settings.defaults().unwrap(),
    }
}

async fn trace(scenario: &str) -> Value {
    let fixture = Fixture::new();
    fixture.host.literal.set(!matches!(
        scenario,
        "conversation" | "stale" | "assignment" | "thinking" | "reference-fails"
    ));
    match scenario {
        "public-input" => fixture.host.queue(false),
        "control-input" => fixture.host.queue(true),
        "late-input" => fixture.host.late_input.set(true),
        "validate-fails" => fixture.host.failure.set(Some("validate")),
        "apply-fails" => fixture.host.failure.set(Some("apply")),
        "save-fails" => fixture.host.failure.set(Some("save")),
        "reference-fails" => fixture.host.failure.set(Some("reference")),
        "assignment" => {
            fixture.host.validation.set(false);
            fixture.host.failure.set(Some("resolve"));
        }
        "conversation" | "literal" | "stale" | "thinking" => {}
        _ => panic!("unrecognized session settings scenario {scenario}"),
    }
    let result = if scenario == "assignment" {
        fixture
            .service
            .validate_configuration(configuration_input(), None)
            .await
            .map(|()| Value::Null)
    } else {
        let patch = AgentSessionSettingsPatch {
            model: Some("next".into()),
            thinking_mode: (scenario == "thinking").then_some(ThinkingMode::High),
            ..Default::default()
        };
        fixture.service.update_session_settings(CHAT, patch, (scenario == "stale").then_some("previous"), None).await.map(|entry| {
            json!({ "model": entry.model, "permissionMode": entry.permission_mode, "thinkingMode": entry.thinking_mode })
        })
    };
    let result = result.unwrap_or_else(|error| {
        let domain = as_domain_error(error.as_ref());
        json!({ "message": error.to_string(), "code": domain.map(|error| error.code.as_str()), "status": domain.map(|error| error.status), "retryable": domain.map(|error| error.retryable) })
    });
    json!({ "result": result, "effects": *fixture.host.effects.borrow() })
}

#[test]
fn session_settings_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = LocalSet::new();
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/session-settings"),
        |function, args| {
            if function != "sessionSettingsTrace" {
                return Err(CaseError::unhandled(function));
            }
            let scenario = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("missing settings scenario"))?;
            local
                .block_on(&runtime, async {
                    tokio::time::timeout(Duration::from_secs(2), trace(scenario)).await
                })
                .map_err(|error| CaseError::undeliverable(error.to_string()))
        },
    );
}

#[tokio::test]
async fn serializes_queue_admission_with_native_confirmation_and_durable_settings_publication() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new();
        fixture.host.blocked.set(true);
        let update = fixture.update("model-next");
        tokio::pin!(update);
        tokio::select! {
            biased;
            _ = &mut update => panic!("settings resolved before native confirmation"),
            () = fixture.host.apply_waiting.notified() => {},
        }
        let admission = fixture.selection_admission.run_exclusive(KEY, || async {
            assert!(fixture.host.effects.borrow().contains(&"committed"));
        }, None);
        tokio::pin!(admission);
        tokio::select! {
            biased;
            _ = &mut admission => panic!("admission proceeded while native settings were pending"),
            () = std::future::ready(()) => {},
        }
        assert!(!fixture.host.effects.borrow().contains(&"save"));
        fixture.host.wait_for_worker.notify_one();
        fixture.host.save_waiting.notified().await;
        tokio::select! {
            biased;
            _ = &mut admission => panic!("admission proceeded while durable settings were pending"),
            () = std::future::ready(()) => {},
        }
        assert!(!fixture.host.effects.borrow().contains(&"committed"));
        fixture.host.wait_for_disk.notify_one();
        admission.await.unwrap();
        assert_eq!(update.await.unwrap().model, "model-next");
    }).await;
}

#[tokio::test]
async fn rejects_literal_mode_changes_with_pending_public_or_control_input() {
    for pending_control in [false, true] {
        let fixture = Fixture::new();
        fixture.host.literal.set(true);
        fixture.host.queue(pending_control);
        let error = fixture.update("next").await.unwrap_err();
        assert_eq!(
            as_domain_error(error.as_ref()).unwrap().code,
            ErrorCode::SESSION_BUSY
        );
        assert_eq!(
            *fixture.host.effects.borrow(),
            [
                "require",
                "previous",
                "resolve",
                "reserve",
                "read-control",
                "release"
            ]
        );
    }
}

#[tokio::test]
async fn rejects_late_control_input_before_live_application_and_releases_outside_the_queue_lock() {
    let fixture = Fixture::new();
    fixture.host.literal.set(true);
    fixture.host.late_input.set(true);
    let error = fixture.update("next").await.unwrap_err();
    assert_eq!(
        as_domain_error(error.as_ref()).unwrap().code,
        ErrorCode::SESSION_BUSY
    );
    let effects = fixture.host.effects.borrow();
    assert!(!effects.contains(&"apply"));
    assert!(!effects.contains(&"save"));
    assert!(effects.ends_with(&["lock-control", "unlock-control", "release"]));
}

#[tokio::test]
async fn releases_a_mode_reservation_after_validation_application_and_persistence_failure() {
    for phase in ["validate", "apply", "save"] {
        let fixture = Fixture::new();
        fixture.host.literal.set(true);
        fixture.host.failure.set(Some(phase));
        let error = fixture.update("next").await.unwrap_err();
        assert_eq!(error.to_string(), "synthetic failure");
        assert!(!fixture.host.reservation.get());
        let effects = fixture.host.effects.borrow();
        assert_eq!(effects.last(), Some(&"release"));
        assert!(!effects.contains(&"committed"));
    }
}

#[tokio::test]
async fn rejects_settings_from_a_superseded_owner_before_touching_the_integration_or_registry() {
    let fixture = Fixture::new();
    let error = fixture
        .service
        .update_session_settings(
            CHAT,
            AgentSessionSettingsPatch::default(),
            Some("previous"),
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(
        as_domain_error(error.as_ref()).unwrap().code,
        ErrorCode::STALE_CHAT_OWNERSHIP
    );
    assert!(fixture.host.effects.borrow().is_empty());
}

#[tokio::test]
async fn enforces_assignment_policy_even_without_an_integration_configuration_validation_facet() {
    let fixture = Fixture::new();
    fixture.host.validation.set(false);
    fixture.host.failure.set(Some("resolve"));
    let error = fixture
        .service
        .validate_configuration(configuration_input(), None)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "synthetic failure");
    assert_eq!(*fixture.host.effects.borrow(), ["require", "resolve"]);
}

#[tokio::test]
async fn starts_each_changes_interactive_deadline_when_it_asks_for_the_chat_lock() {
    LocalSet::new()
        .run_until(async {
            let now = Rc::new(Cell::new(DEADLINE));
            let fixture = Fixture::with_deadline({
                let now = now.clone();
                move || now.get()
            });
            let held = Notify::new();
            let release = Notify::new();
            let holder = fixture.chat_mutation.run_exclusive(
                KEY,
                || async {
                    held.notify_one();
                    release.notified().await;
                },
                None,
            );
            let update = async {
                held.notified().await;
                let request = fixture.update("next");
                tokio::pin!(request);
                tokio::select! {
                    biased;
                    _ = &mut request => panic!("settings must wait for the chat mutation lock"),
                    () = std::future::ready(()) => {},
                }
                assert!(fixture.host.effects.borrow().is_empty());
                now.set(DEADLINE + 5_000.0);
                release.notify_one();
                request.await.unwrap();
            };
            let (held, ()) = tokio::join!(holder, update);
            held.unwrap();
            assert_eq!(
                *fixture.host.dispatch_deadlines.borrow(),
                [DEADLINE, DEADLINE]
            );
        })
        .await;
}

#[tokio::test]
async fn dropping_the_settings_waiter_keeps_admission_locked_until_durable_publication() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            fixture.host.blocked.set(true);
            {
                let update = fixture.update("next");
                tokio::pin!(update);
                tokio::select! {
                    biased;
                    _ = &mut update => panic!("settings resolved before native confirmation"),
                    () = fixture.host.apply_waiting.notified() => {},
                }
            }
            fixture.host.wait_for_worker.notify_one();
            fixture.host.save_waiting.notified().await;
            let admission = fixture.selection_admission.run_exclusive(
                KEY,
                || async {
                    assert_eq!(fixture.host.saved.borrow().model, "next");
                    assert!(fixture.host.effects.borrow().contains(&"committed"));
                },
                None,
            );
            tokio::pin!(admission);
            tokio::select! {
                biased;
                _ = &mut admission => panic!("dropping the request released admission before save"),
                () = std::future::ready(()) => {},
            }
            fixture.host.wait_for_disk.notify_one();
            admission.await.unwrap();
        })
        .await;
}

#[tokio::test]
async fn passes_complete_next_and_previous_configurations_before_persistence() {
    let fixture = Fixture::new();
    fixture
        .service
        .update_session_settings(
            CHAT,
            AgentSessionSettingsPatch {
                model: Some("next".into()),
                permission_mode: Some(PermissionMode::Default),
                thinking_mode: Some(ThinkingMode::None),
                ..Default::default()
            },
            None,
            None,
        )
        .await
        .unwrap();
    let applied = fixture.host.configurations.borrow();
    let (next, previous) = &applied[0];
    assert!(next.permission_mode_explicit);
    assert_eq!(next.configuration.model, "next");
    assert_eq!(next.configuration.permission_mode, PermissionMode::Default);
    assert_eq!(next.configuration.thinking_mode, ThinkingMode::None);
    assert_eq!(next.configuration.settings, previous.settings);
    assert_eq!(previous.model, "medium");
    assert_eq!(previous.permission_mode, PermissionMode::BypassPermissions);
    assert_eq!(previous.thinking_mode, ThinkingMode::None);
    assert_eq!(previous.endpoint, None);
    assert!(
        fixture
            .host
            .effects
            .borrow()
            .ends_with(&["apply", "save", "committed"])
    );
}
