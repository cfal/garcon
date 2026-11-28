use std::{collections::HashSet, rc::Weak, time::Duration};

use garcon_base::keyed_lock::KeyedLock;
use garcon_contract::{
    error_codes::ErrorCode, project_resolution::ProjectUnavailableReason,
    transcript_notice_details::parse_transcript_notice_detail,
};
use garcon_execution::{
    chat_execution_control_operations::{
        ChatExecutionControlOperations, ChatExecutionControlOperationsHost, ControlChangeResult,
        DequeuedTurn,
    },
    chat_execution_control_repository::{
        ChatExecutionControlRepository, InMemoryChatExecutionControlRepository,
    },
    chat_execution_control_transitions::{
        DequeuedTurnInput, FailurePauseCause, ObservedQueueEntry, QueueEntryInput,
    },
    control_state::{
        StoredChatExecutionControlState, StoredControlInput, StoredControlInputEntry,
        StoredControlReceipt, StoredQueueSubmissionIdentity,
    },
    queue_drainer::{
        QueueDequeueAdmission, QueueDispatchCallbacks, QueueDispatchControls, QueueDispatchDeps,
        QueueDrainer, QueueSelectionAdmission, SelectionAdmissionOperation,
    },
    types::{ProjectAdmissionPort, QueuedAttachmentAdmissionPort},
};
use garcon_js::{Number, clock::ManualClock};
use tokio::sync::oneshot;

use super::*;

struct Fake {
    spec: Value,
    owner: Rc<ExecutionOwnership>,
    controls: RefCell<Weak<ChatExecutionControlOperations>>,
    repository: Rc<InMemoryChatExecutionControlRepository>,
    available: Cell<bool>,
    locked: Cell<bool>,
    check_attachments: Cell<bool>,
    effects: RefCell<Vec<Value>>,
    started: RefCell<Option<String>>,
    late: RefCell<Option<oneshot::Receiver<()>>>,
    late_observed: RefCell<Option<oneshot::Sender<()>>>,
}

impl Fake {
    fn log(&self, event: Value) {
        self.effects.borrow_mut().push(event);
    }

    fn controls(&self) -> Rc<ChatExecutionControlOperations> {
        self.controls.borrow().upgrade().unwrap()
    }
}

struct AvailableOnEnqueue;

#[async_trait(?Send)]
impl ProjectAdmissionPort for AvailableOnEnqueue {
    async fn assert_available(&self, _: &str, _: Option<f64>) -> ExecutionOperationResult<()> {
        Ok(())
    }
}

impl ChatExecutionControlOperationsHost for Fake {
    fn chat_exists(&self, _: &str) -> bool {
        true
    }
    fn unsettled_queue_receipt_keys(&self, _: &str) -> HashSet<String> {
        HashSet::new()
    }
    fn publish(
        &self,
        _: &str,
        _: &StoredChatExecutionControlState,
    ) -> ExecutionOperationResult<()> {
        Ok(())
    }
    fn input_accepted(&self, _: &str) -> ExecutionOperationResult<()> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl ProjectAdmissionPort for Fake {
    async fn assert_available(
        &self,
        chat: &str,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<()> {
        self.log(json!(["project", deadline]));
        if self.spec["stopDuringProject"] == true {
            self.owner.enter_manual_stop(chat);
        }
        if self.spec["clearDuringProject"] == true {
            self.controls().clear(chat).await?;
        }
        if self.spec["unavailable"] == true {
            return Err(Box::new(DomainError::new_project_unavailable(
                "/work/missing",
                ProjectUnavailableReason::NotFound,
            )));
        }
        Ok(())
    }
}

impl QueuedAttachmentAdmissionPort for Fake {
    fn assert_supported(
        &self,
        _: &str,
        images: &[AgentCommandImage],
    ) -> ExecutionOperationResult<()> {
        if !self.check_attachments.get() {
            return Ok(());
        }
        self.log(json!(["attachments", self.locked.get(), images]));
        if self.spec["rejectAttachments"] == true {
            return Err(Box::new(DomainError::new(
                ErrorCode::UNSUPPORTED_AGENT,
                "Attachments unsupported",
                422,
                false,
            )));
        }
        if self.spec["retryAttachments"] == true {
            return Err(Box::new(DomainError::new(
                ErrorCode::EXECUTOR_UNAVAILABLE,
                "Executor unavailable",
                503,
                true,
            )));
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl QueueDispatchControls for Fake {
    async fn read(&self, chat: &str) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.controls().read(chat).await
    }
    async fn pause_for_unavailable_project(
        &self,
        chat: &str,
    ) -> ExecutionOperationResult<ControlChangeResult> {
        self.controls().pause_for_unavailable_project(chat).await
    }
    async fn pause_after_failure(
        &self,
        chat: &str,
        cause: &FailurePauseCause,
    ) -> ExecutionOperationResult<()> {
        self.controls().pause_after_failure(chat, cause).await
    }
    async fn dequeue_next_turn(
        &self,
        chat: &str,
        admit: QueueDequeueAdmission<'_>,
    ) -> ExecutionOperationResult<Option<DequeuedTurn>> {
        if self.spec["failRemoval"] == true {
            let entry = self.repository.load(chat).entries.remove(0);
            admit(&DequeuedTurnInput::User { entry })?;
            return Err(Box::new(std::io::Error::other("queue removal failed")));
        }
        self.controls().dequeue_next_turn(chat, admit).await
    }
}

#[async_trait(?Send)]
impl QueueSelectionAdmission for Fake {
    async fn run_selection_admission_exclusive(
        &self,
        _: &str,
        operation: SelectionAdmissionOperation<'_>,
    ) -> ExecutionOperationResult<Option<DequeuedTurn>> {
        self.log(json!(["lock"]));
        self.locked.set(true);
        if self.spec["offlineInSelection"] == true {
            self.available.set(false);
        }
        let result = operation().await;
        self.locked.set(false);
        self.log(json!(["unlock"]));
        result
    }
}

fn selected(options: &RunAgentTurnOptions) -> Value {
    json!([
        options.model,
        options.client_request_id,
        options.client_message_id,
        options.turn_id,
        options.transcript_view_id,
        serialized(&options.excluded_resend_ordinals),
        options.images,
        options.created_at,
    ])
}

impl QueueDispatchCallbacks for Fake {
    fn can_dispatch(&self, _: &str) -> bool {
        self.available.get()
    }
    fn is_shutting_down(&self) -> bool {
        self.spec["shutdownAfterInstall"] == true && self.owner.has_attempt(CHAT)
    }

    fn register_queued(
        &self,
        _: &str,
        content: &str,
        options: &RunAgentTurnOptions,
    ) -> ExecutionOperationResult<bool> {
        self.log(json!([
            "registered",
            self.locked.get(),
            content,
            selected(options)
        ]));
        if self.spec["slash"] == true && content == "/blocked" {
            return Err(Box::new(DomainError::new(
                ErrorCode::PREAMBLE_SLASH_COMMAND_BLOCKED,
                "Opening slash blocked",
                422,
                false,
            )));
        }
        Ok(self.spec["duplicate"] != true)
    }

    fn append_control_receipt(
        &self,
        _: &str,
        entry: &StoredControlInputEntry,
    ) -> ExecutionOperationResult<()> {
        self.log(json!([
            "receipt",
            self.locked.get(),
            serialized(&entry.input.receipt)
        ]));
        Ok(())
    }

    fn is_control_input_view_current(
        &self,
        _: &str,
        view_id: &str,
    ) -> ExecutionOperationResult<bool> {
        self.log(json!(["view", self.locked.get(), view_id]));
        Ok(self.spec["staleView"] != true)
    }

    fn discard_prepared_input(
        &self,
        _: &str,
        client_message_id: Option<&str>,
    ) -> ExecutionOperationResult<()> {
        self.log(json!(["discard", client_message_id]));
        Ok(())
    }

    fn publish_idle(&self, _: &str) -> ExecutionOperationResult<()> {
        self.log(json!(["idle"]));
        Ok(())
    }

    fn publish_project_unavailable(
        &self,
        _: &str,
        error: &DomainError,
    ) -> ExecutionOperationResult<()> {
        self.log(json!(["unavailable", failure(error)]));
        Ok(())
    }

    fn publish_turn_failed(
        &self,
        _: &str,
        message: &str,
        options: &RunAgentTurnOptions,
    ) -> ExecutionOperationResult<()> {
        self.log(json!(["failed", message, selected(options)]));
        Ok(())
    }

    fn publish_turn_started(&self, _: &str, run_id: &str) -> ExecutionOperationResult<()> {
        self.started.replace(Some(run_id.to_owned()));
        self.log(json!(["started", self.locked.get(), run_id]));
        Ok(())
    }

    fn retire_attempt(
        &self,
        chat: &str,
        attempt: &Rc<QueueExecutionAttempt>,
    ) -> ExecutionOperationResult<()> {
        self.log(json!(["retire", attempt.identity().turn_id]));
        self.owner.retire_attempt(chat, attempt, None);
        Ok(())
    }
}

#[async_trait(?Send)]
impl AgentTurnRunnerPort for Fake {
    async fn run_agent_turn(
        &self,
        chat: &str,
        content: &str,
        options: RunAgentTurnOptions,
    ) -> ExecutionOperationResult<()> {
        self.log(json!([
            "provider",
            self.locked.get(),
            content,
            selected(&options)
        ]));
        let attempt = self.owner.attempt(chat).unwrap();
        if self.spec["providerFailure"] == true {
            if self.spec["terminalCommitted"] == true {
                self.owner
                    .mark_run_terminal_committed(chat, options.turn_id.as_deref().unwrap());
            }
            return Err(Box::new(std::io::Error::other("provider rejected")));
        }
        self.owner.retire_attempt(chat, &attempt, None);
        let late = self.late.take();
        if let Some(late) = late {
            late.await.unwrap();
            self.log(json!(["late-rejection-observed"]));
            self.late_observed.take().unwrap().send(()).unwrap();
            return Err(Box::new(std::io::Error::other("late provider rejection")));
        }
        Ok(())
    }

    async fn capture_steer_target(
        &self,
        _: &str,
        _: Option<f64>,
    ) -> ExecutionOperationResult<Option<AgentSteerTarget>> {
        unreachable!("the drainer runs turns, it does not capture steers")
    }
    async fn steer_input(
        &self,
        _: &str,
        _: &str,
        _: &AgentSteerOptions,
        _: Option<&AgentSteerTarget>,
        _: PrepareSteerDelivery<'_>,
        _: Option<f64>,
    ) -> ExecutionOperationResult<AgentSteerResult> {
        unreachable!("the drainer does not steer")
    }
    async fn abort_session(&self, _: &str) -> ExecutionOperationResult<bool> {
        unreachable!("the drainer does not abort sessions")
    }
    fn is_chat_running(&self, _: &str) -> bool {
        false
    }
}

pub async fn trace(spec: &Value) -> Value {
    let ids: Rc<dyn Fn() -> String> = Rc::new(new_ids());
    let owner = Rc::new(ExecutionOwnership::new({
        let ids = ids.clone();
        move || ids()
    }));
    owner.begin_drain(CHAT).unwrap();
    let repository = Rc::new(InMemoryChatExecutionControlRepository::new("server".into()));
    let (late, late_receiver) = oneshot::channel();
    let (observed, late_observed) = oneshot::channel();
    let late_failure = spec["lateFailure"] == true;
    let fake = Rc::new(Fake {
        spec: spec.clone(),
        owner: owner.clone(),
        controls: RefCell::default(),
        repository: repository.clone(),
        available: Cell::new(true),
        locked: Cell::new(false),
        check_attachments: Cell::new(false),
        effects: RefCell::default(),
        started: RefCell::default(),
        late: RefCell::new(late_failure.then_some(late_receiver)),
        late_observed: RefCell::new(late_failure.then_some(observed)),
    });
    let controls = Rc::new(ChatExecutionControlOperations::new(
        repository.clone(),
        Rc::new(KeyedLock::new()),
        fake.clone(),
        Rc::new(AvailableOnEnqueue),
        fake.clone(),
        Rc::new(ManualClock::new(60_123)),
        {
            let ids = ids.clone();
            move || ids()
        },
    ));
    fake.controls.replace(Rc::downgrade(&controls));
    if spec["controlInput"] == true || spec["controlOnly"] == true {
        controls
            .enqueue_control(
                CHAT,
                &StoredControlInput {
                    content: "control input".into(),
                    transcript_view_id: VIEW.into(),
                    created_at: "provided-time".into(),
                    receipt: Some(StoredControlReceipt {
                        title: "Inter-agent message".into(),
                        content: "message".into(),
                        detail: Box::new(
                            parse_transcript_notice_detail(
                                &json!({"type":"inter-agent-message-received","fromChatId":null}),
                            )
                            .unwrap(),
                        ),
                    }),
                },
            )
            .await
            .unwrap();
    }
    if spec["empty"] != true && spec["controlOnly"] != true {
        controls
            .create(
                CHAT,
                &QueueEntryInput {
                    content: if spec["slash"] == true {
                        "/blocked"
                    } else {
                        "queued input"
                    }
                    .into(),
                    images: (spec["images"] == true).then(image).into_iter().collect(),
                    submission: Some(StoredQueueSubmissionIdentity {
                        client_message_id: "message-1".into(),
                        transcript_view_id: VIEW.into(),
                        excluded_resend_ordinals: Some(vec![Number(1.0), Number(3.0)]),
                    }),
                    command: None,
                },
                None,
            )
            .await
            .unwrap();
        if spec["second"] == true {
            controls
                .create(
                    CHAT,
                    &QueueEntryInput {
                        content: "later".into(),
                        images: Vec::new(),
                        submission: None,
                        command: None,
                    },
                    None,
                )
                .await
                .unwrap();
        }
    }
    if spec["paused"] == true {
        controls.pause(CHAT).await.unwrap();
    }
    if spec["steering"] == true {
        let current = repository.load(CHAT);
        let entry = &current.entries[0];
        controls
            .reserve_steer(
                CHAT,
                &ObservedQueueEntry {
                    entry_id: entry.id.clone(),
                    expected_revision: entry.revision,
                    expected_reorder_revision: current.reorder_revision,
                },
            )
            .await
            .unwrap();
    }
    fake.check_attachments.set(true);
    let drainer = QueueDrainer::new(
        QueueDispatchDeps {
            ownership: owner.clone(),
            controls: fake.clone(),
            turn_runner: fake.clone(),
            get_drain_options: Box::new({
                let fake = fake.clone();
                move |_| {
                    fake.log(json!(["selection", fake.locked.get()]));
                    Ok(RunAgentTurnOptions {
                        model: Some("selected-model".into()),
                        ..Default::default()
                    })
                }
            }),
            selection_admission: fake.clone(),
            project_admission: fake.clone(),
            attachment_admission: fake.clone(),
            callbacks: fake.clone(),
        },
        move || ids(),
    );
    let result = outcome(
        tokio::time::timeout(Duration::from_secs(1), drainer.run(CHAT))
            .await
            .expect("drain trace terminates"),
    );
    if late_failure {
        late.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), late_observed)
            .await
            .expect("late provider completes")
            .unwrap();
    }
    let control = repository.load(CHAT);
    let started = fake.started.take();
    let finalization = if let Some(finalization) = owner.finalization(CHAT, started.as_deref()) {
        serialized(
            tokio::time::timeout(Duration::from_secs(1), finalization.wait())
                .await
                .expect("dispatch finalization settles"),
        )
    } else {
        Value::Null
    };
    json!({
        "result":result, "effects":fake.effects.take(),
        "entries":control.entries.into_iter().map(|entry| json!([entry.content,entry.images])).collect::<Vec<_>>(),
        "controls":control.control_entries.into_iter().map(|entry| entry.input.content).collect::<Vec<_>>(),
        "pause":control.pause.map(|pause| serialized(pause.kind)["kind"].clone()), "finalization":finalization,
    })
}

#[tokio::test]
async fn leaves_queued_inputs_untouched_when_the_executor_goes_offline_waiting_for_admission() {
    let trace = trace(&json!({"offlineInSelection":true})).await;
    assert_eq!(trace["entries"].as_array().unwrap().len(), 1);
    assert_eq!(effect_names(&trace), ["project", "lock", "unlock"]);
}

#[tokio::test]
async fn discards_a_prepared_input_when_queue_removal_fails_after_transcript_admission() {
    let trace = trace(&json!({"failRemoval":true})).await;
    assert_eq!(trace["result"]["error"]["message"], "queue removal failed");
    assert!(effect_names(&trace).ends_with(&["registered", "unlock", "discard"]));
    assert_eq!(trace["entries"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn does_not_commit_finalization_for_a_turn_dropped_during_shutdown() {
    let trace = trace(&json!({"shutdownAfterInstall":true})).await;
    assert_eq!(trace["finalization"], "not-committed");
    assert!(!effect_names(&trace).contains(&"provider"));
}

#[tokio::test]
async fn removes_a_blocked_preamble_slash_command_and_drains_the_next_queued_turn() {
    let trace = trace(&json!({"slash":true,"second":true})).await;
    assert_eq!(trace["entries"], json!([]));
    let effects = trace["effects"].as_array().unwrap();
    let failed = effects
        .iter()
        .position(|event| event[0] == "failed")
        .unwrap();
    let provider = effects
        .iter()
        .position(|event| event[0] == "provider")
        .unwrap();
    assert!(failed < provider);
    assert_eq!(effects[provider][2], "later");
}

#[tokio::test]
async fn observes_a_provider_rejection_after_the_execution_attempt_settles_first() {
    let trace = LocalSet::new()
        .run_until(trace(&json!({"lateFailure":true})))
        .await;
    let effects = effect_names(&trace);
    assert!(effects.contains(&"late-rejection-observed"));
    assert!(!effects.contains(&"failed"));
}

#[tokio::test]
async fn runs_dequeue_and_synchronous_admission_inside_the_selection_admission_lock() {
    let trace = trace(&json!({})).await;
    for effect in trace["effects"].as_array().unwrap() {
        match effect[0].as_str().unwrap() {
            "selection" | "started" | "registered" => assert_eq!(effect[1], true),
            "provider" => assert_eq!(effect[1], false),
            _ => {}
        }
    }
    assert_eq!(trace["finalization"], "committed");
}

#[tokio::test]
async fn pauses_an_unavailable_queue_before_dequeue_or_transcript_admission() {
    let trace = trace(&json!({"unavailable":true})).await;
    assert_eq!(trace["pause"], "manual");
    assert_eq!(effect_names(&trace), ["project", "unavailable"]);
}

#[tokio::test]
async fn does_not_create_a_hidden_pause_for_an_unavailable_control_only_lane() {
    let trace = trace(&json!({"controlOnly":true,"unavailable":true})).await;
    assert_eq!(trace["pause"], Value::Null);
    assert!(!effect_names(&trace).contains(&"project"));
    assert!(effect_names(&trace).contains(&"receipt"));
}

#[tokio::test]
async fn rechecks_visible_pause_eligibility_after_project_resolution() {
    let trace =
        trace(&json!({"controlInput":true,"unavailable":true,"clearDuringProject":true})).await;
    assert_eq!(trace["pause"], Value::Null);
    assert!(!effect_names(&trace).contains(&"unavailable"));
    assert!(effect_names(&trace).contains(&"receipt"));
}

#[tokio::test]
async fn does_not_resolve_empty_paused_or_steering_blocked_queues() {
    for kind in ["empty", "paused", "steering"] {
        let trace = trace(&json!({(kind):true})).await;
        assert!(!effect_names(&trace).contains(&"project"));
    }
}

#[tokio::test]
async fn halts_after_deferred_resolution_when_stop_acquires_suppression() {
    let trace = trace(&json!({"stopDuringProject":true})).await;
    assert_eq!(effect_names(&trace), ["project"]);
    assert_eq!(trace["entries"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn admits_and_dispatches_a_queued_entry_with_its_attachments() {
    let trace = trace(&json!({"images":true,"second":true})).await;
    let provider = trace["effects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event[0] == "provider")
        .collect::<Vec<_>>();
    assert_eq!(provider[0][3][6], json!([image()]));
    assert_eq!(provider[1][3][6], Value::Null);
    assert_eq!(trace["entries"], json!([]));
}

#[tokio::test]
async fn pauses_on_an_attachment_entry_the_current_selection_rejects_without_consuming_it() {
    let trace = trace(&json!({"images":true,"second":true,"rejectAttachments":true})).await;
    assert_eq!(trace["pause"], "queued-turn-failed");
    assert_eq!(trace["entries"][0][1], json!([image()]));
    assert!(!effect_names(&trace).contains(&"provider"));
}

#[tokio::test]
async fn waits_for_readiness_instead_of_pausing_when_attachment_admission_is_retryable() {
    let trace = trace(&json!({"images":true,"retryAttachments":true})).await;
    assert_eq!(trace["pause"], Value::Null);
    assert_eq!(trace["entries"][0][1], json!([image()]));
    assert!(!effect_names(&trace).contains(&"failed"));
}
