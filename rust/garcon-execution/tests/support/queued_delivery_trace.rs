use std::{collections::HashSet, rc::Weak};

use garcon_base::keyed_lock::KeyedLock;
use garcon_contract::error_codes::ErrorCode;
use garcon_execution::{
    chat_execution_control_operations::{
        ChatExecutionControlOperations, ChatExecutionControlOperationsHost,
    },
    chat_execution_control_repository::{
        ChatExecutionControlRepository, InMemoryChatExecutionControlRepository,
    },
    chat_execution_control_transitions::{QueueCommandIdentity, QueueEntryInput},
    control_state::{StoredChatExecutionControlState, StoredQueueSubmissionIdentity},
    queued_steer_delivery::{
        QueuedSteerContent, QueuedSteerDelivery, QueuedSteerDeliveryOptions, QueuedSteerHost,
    },
    types::{LocalExecutionFuture, ProjectAdmissionPort, QueuedAttachmentAdmissionPort},
};
use garcon_js::clock::ManualClock;

use super::*;

struct Fake {
    spec: Value,
    observe: Cell<bool>,
    refuse: Cell<bool>,
    ready: Cell<bool>,
    attempt: RefCell<Rc<QueueExecutionAttempt>>,
    capture_calls: Cell<u32>,
    resolve_calls: Cell<u32>,
    admit_calls: Cell<u32>,
    effects: RefCell<Vec<Value>>,
    tasks: RefCell<Vec<LocalExecutionFuture<'static>>>,
    controls: RefCell<Weak<ChatExecutionControlOperations>>,
    delivery: RefCell<Weak<QueuedSteerDelivery>>,
}

impl Fake {
    fn log(&self, event: Value) {
        self.effects.borrow_mut().push(event);
    }

    fn delivery(&self) -> Rc<QueuedSteerDelivery> {
        self.delivery.borrow().upgrade().unwrap()
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
        chat: &str,
        control: &StoredChatExecutionControlState,
    ) -> ExecutionOperationResult<()> {
        if self.observe.get() {
            self.delivery().observe(chat, control)?;
        }
        Ok(())
    }
    fn input_accepted(&self, _: &str) -> ExecutionOperationResult<()> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl ProjectAdmissionPort for Fake {
    async fn assert_available(&self, _: &str, _: Option<f64>) -> ExecutionOperationResult<()> {
        Ok(())
    }
}

impl QueuedAttachmentAdmissionPort for Fake {
    fn assert_supported(&self, _: &str, _: &[AgentCommandImage]) -> ExecutionOperationResult<()> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl AgentTurnRunnerPort for Fake {
    async fn run_agent_turn(
        &self,
        _: &str,
        _: &str,
        _: RunAgentTurnOptions,
    ) -> ExecutionOperationResult<()> {
        unreachable!("queued steering does not start a turn")
    }

    async fn capture_steer_target(
        &self,
        _: &str,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<Option<AgentSteerTarget>> {
        self.log(json!(["capture", deadline]));
        self.capture_calls.set(self.capture_calls.get() + 1);
        if self.spec["failCapture"] == true {
            return Err(Box::new(std::io::Error::other("capture failed")));
        }
        if self.spec["rerun"] == "capture" && self.capture_calls.get() == 1 {
            self.delivery().request(CHAT)?;
            return Ok(None);
        }
        if self.spec["settleInCapture"] == true {
            self.attempt.borrow().mark_settled();
        }
        Ok(self.ready.get().then(provider_target))
    }

    async fn steer_input(
        &self,
        _: &str,
        content: &str,
        _: &AgentSteerOptions,
        _: Option<&AgentSteerTarget>,
        prepare: PrepareSteerDelivery<'_>,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<AgentSteerResult> {
        prepare().await?;
        self.log(json!(["provider", content, deadline]));
        Ok(if self.spec["rejectAfterAdmission"] == true {
            AgentSteerResult::Rejected {
                reason: garcon_interface::services::AgentSteerRejectionReason::TurnNotSteerable,
                message: "not steerable".into(),
            }
        } else {
            AgentSteerResult::Accepted
        })
    }

    async fn abort_session(&self, _: &str) -> ExecutionOperationResult<bool> {
        unreachable!("steering does not abort a turn")
    }
    fn is_chat_running(&self, _: &str) -> bool {
        false
    }
}

#[async_trait(?Send)]
impl SteerInputDeliveryHost for Fake {
    fn is_shutting_down(&self) -> bool {
        false
    }

    async fn admit_input(
        &self,
        _: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        self.admit_calls.set(self.admit_calls.get() + 1);
        self.log(json!([
            "admit",
            content,
            options.client_message_id,
            options.transcript_view_id,
            options.turn_id
        ]));
        if self.refuse.get() {
            if self.admit_calls.get() >= 3 {
                self.ready.set(false);
            }
            return Err(Box::new(DomainError::new(
                ErrorCode::STALE_TRANSCRIPT_VIEW,
                "The transcript view changed",
                409,
                false,
            )));
        }
        Ok(true)
    }

    fn discard_prepared_input(&self, _: &str, _: Option<&str>) -> ExecutionOperationResult<()> {
        Ok(())
    }
}

#[async_trait(?Send)]
impl QueuedSteerHost for Fake {
    async fn resolve_content(
        &self,
        input: QueuedSteerContent<'_>,
    ) -> ExecutionOperationResult<String> {
        self.log(json!(["resolve", input.content]));
        self.resolve_calls.set(self.resolve_calls.get() + 1);
        if self.spec["pauseWhileResolving"] == true {
            let controls = self.controls.borrow().upgrade().unwrap();
            controls.pause(CHAT).await?;
        }
        if self.spec["rerun"] == "failed-resolve" && self.resolve_calls.get() == 1 {
            self.delivery().request(CHAT)?;
            return Err(Box::new(std::io::Error::other("resolver failed")));
        }
        Ok(if self.spec["context"] == true {
            format!("{}\n\nresolved context", input.content)
        } else {
            input.content.into()
        })
    }

    fn can_deliver(&self, _: &str) -> bool {
        true
    }
    fn request_drain(&self, _: &str, why: &str) -> ExecutionOperationResult<()> {
        self.log(json!(["drain", why]));
        Ok(())
    }
    fn track_task(&self, task: LocalExecutionFuture<'static>) -> ExecutionOperationResult<()> {
        self.tasks.borrow_mut().push(task);
        Ok(())
    }
}

async fn run_pass(fake: &Fake, delivery: &Rc<QueuedSteerDelivery>) {
    delivery.request(CHAT).unwrap();
    loop {
        let mut tasks = fake.tasks.take();
        if tasks.is_empty() {
            return;
        }
        for task in tasks.drain(..) {
            task.await.unwrap();
        }
    }
}

fn snapshot(control: StoredChatExecutionControlState) -> Value {
    json!({
        "entries": control.entries.into_iter().map(|entry| json!([entry.content, entry.kind, entry.status, entry.images])).collect::<Vec<_>>(),
        "dispatched": control.recently_dispatched.into_iter().map(|entry| entry.entry_id).collect::<Vec<_>>(),
        "pause": control.pause.map(|pause| serialized(pause.kind)["kind"].clone()),
    })
}

pub async fn trace(spec: &Value) -> Value {
    let owner = Rc::new(ExecutionOwnership::new(new_ids()));
    let attempt_1 = attempt(TURN);
    owner.install_attempt(CHAT, attempt_1.clone()).unwrap();
    let fake = Rc::new(Fake {
        spec: spec.clone(),
        observe: Cell::new(false),
        refuse: Cell::new(spec["refuse"] == true),
        ready: Cell::new(spec["noProvider"] != true),
        attempt: RefCell::new(attempt_1.clone()),
        capture_calls: Cell::new(0),
        resolve_calls: Cell::new(0),
        admit_calls: Cell::new(0),
        effects: RefCell::default(),
        tasks: RefCell::default(),
        controls: RefCell::default(),
        delivery: RefCell::default(),
    });
    let ids: Rc<dyn Fn() -> String> = Rc::new(new_ids());
    let repository = Rc::new(InMemoryChatExecutionControlRepository::new("server".into()));
    let controls = Rc::new(ChatExecutionControlOperations::new(
        repository.clone(),
        Rc::new(KeyedLock::new()),
        fake.clone(),
        fake.clone(),
        fake.clone(),
        Rc::new(ManualClock::new(60_123)),
        {
            let ids = ids.clone();
            move || ids()
        },
    ));
    let steer = Rc::new(SteerInputDelivery::new(
        SteerInputDeliveryOptions {
            ownership: owner.clone(),
            turn_runner: fake.clone(),
            host: fake.clone(),
        },
        {
            let ids = ids.clone();
            move || ids()
        },
    ));
    let delivery = Rc::new(QueuedSteerDelivery::new(
        QueuedSteerDeliveryOptions {
            controls: controls.clone(),
            steer_input: steer,
            host: fake.clone(),
        },
        move || ids(),
    ));
    fake.controls.replace(Rc::downgrade(&controls));
    fake.delivery.replace(Rc::downgrade(&delivery));
    if spec["future"] == true {
        controls
            .create(
                CHAT,
                &QueueEntryInput {
                    content: "future turn".into(),
                    images: (spec["images"] == true).then(image).into_iter().collect(),
                    submission: None,
                    command: None,
                },
                None,
            )
            .await
            .unwrap();
    }
    for index in 1..=spec["entries"].as_u64().unwrap_or(1) {
        let key = format!("steer-{index}");
        controls
            .create_steer(
                CHAT,
                if index == 1 {
                    "first guidance"
                } else {
                    "second guidance"
                },
                &QueueCommandIdentity {
                    key: key.clone(),
                    entry_id: key,
                },
                &StoredQueueSubmissionIdentity {
                    client_message_id: format!("message-{index}"),
                    transcript_view_id: VIEW.into(),
                    excluded_resend_ordinals: None,
                },
            )
            .await
            .unwrap();
    }
    if spec["noSubmission"] == true {
        let mut state = repository.load(CHAT);
        for entry in &mut state.entries {
            entry.submission = None;
        }
        repository.save(CHAT, &state).unwrap();
    }
    if spec["paused"] == true {
        controls.pause(CHAT).await.unwrap();
    }
    fake.observe.set(spec["observe"] == true);
    if fake.observe.get() {
        delivery.observe(CHAT, &repository.load(CHAT)).unwrap();
    }
    run_pass(&fake, &delivery).await;
    let before = snapshot(controls.read(CHAT).await.unwrap());
    if spec["resume"] == true {
        let paused = controls.read(CHAT).await.unwrap();
        controls
            .resume(CHAT, &paused.pause.unwrap().id)
            .await
            .unwrap();
        run_pass(&fake, &delivery).await;
    }
    if fake.refuse.get() && spec["nextTurn"] == true {
        delivery.retry(CHAT).unwrap();
        run_pass(&fake, &delivery).await;
        owner.remove_attempt(CHAT, &attempt_1);
        let attempt_2 = attempt("turn-2");
        owner.install_attempt(CHAT, attempt_2.clone()).unwrap();
        fake.attempt.replace(attempt_2);
        fake.refuse.set(false);
        run_pass(&fake, &delivery).await;
    }
    json!({"before":before,"after":snapshot(controls.read(CHAT).await.unwrap()),"effects":fake.effects.take()})
}

#[tokio::test]
async fn delivers_queued_steers_in_order_and_preserves_queued_turn_attachments() {
    for images in [false, true] {
        let trace = trace(&json!({"entries":2,"future":true,"images":images})).await;
        assert_eq!(trace["after"]["dispatched"], json!(["steer-1", "steer-2"]));
        assert_eq!(trace["after"]["entries"][0][0], "future turn");
        assert_eq!(
            trace["after"]["entries"][0][3].as_array().unwrap().len(),
            usize::from(images)
        );
        assert_eq!(trace["effects"][2][2], "message-1");
    }
}

#[tokio::test]
async fn resolves_file_context_for_the_steer_it_delivers() {
    let trace = trace(&json!({"context":true})).await;
    assert!(
        trace["effects"].as_array().unwrap().iter().any(
            |effect| effect == &json!(["provider", "first guidance\n\nresolved context", null])
        )
    );
}

#[tokio::test]
async fn keeps_steers_queued_when_the_turn_or_a_pause_blocks_delivery() {
    let not_ready = trace(&json!({"noProvider":true})).await;
    assert_eq!(effect_names(&not_ready), ["capture"]);
    let paused = trace(&json!({"paused":true,"resume":true})).await;
    assert_eq!(paused["before"]["entries"].as_array().unwrap().len(), 1);
    assert_eq!(paused["after"]["entries"], json!([]));
}

#[tokio::test]
async fn holds_a_steer_back_when_the_queue_is_paused_while_delivery_is_prepared() {
    let trace = trace(&json!({"pauseWhileResolving":true})).await;
    assert_eq!(effect_names(&trace), ["capture", "resolve"]);
    assert_eq!(trace["after"]["pause"], "manual");
    assert_eq!(trace["after"]["entries"][0][2], "queued");
}

#[tokio::test]
async fn leaves_an_entry_without_a_submission_identity_for_the_drain() {
    let trace = trace(&json!({"noSubmission":true})).await;
    assert!(effect_names(&trace).is_empty());
    assert_eq!(trace["after"]["entries"][0][2], "queued");
}

#[tokio::test]
async fn releases_a_steer_refused_before_it_was_recorded() {
    let trace = trace(&json!({"settleInCapture":true})).await;
    assert_eq!(effect_names(&trace), ["capture", "resolve", "drain"]);
    assert_eq!(trace["after"]["entries"][0][2], "queued");
}

#[tokio::test]
async fn does_not_offer_steers_again_to_a_turn_that_refused_one_before_recording() {
    let trace = trace(&json!({"entries":2,"observe":true,"refuse":true,"nextTurn":true})).await;
    let turns = trace["effects"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event[0] == "admit")
        .map(|event| event[4].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(turns, ["turn-1", "turn-2", "turn-2"]);
    assert_eq!(trace["after"]["entries"], json!([]));
}

#[tokio::test]
async fn consumes_a_steer_that_was_recorded_but_not_delivered() {
    let trace = trace(&json!({"entries":2,"rejectAfterAdmission":true})).await;
    assert_eq!(trace["after"]["dispatched"], json!(["steer-1", "steer-2"]));
}

#[tokio::test]
async fn runs_a_pass_requested_during_a_successful_or_failed_one() {
    for phase in ["capture", "failed-resolve"] {
        let trace = trace(&json!({"rerun":phase})).await;
        assert_eq!(trace["after"]["dispatched"], json!(["steer-1"]));
        assert_eq!(
            effect_names(&trace)
                .iter()
                .filter(|name| **name == "admit")
                .count(),
            1
        );
    }
}

#[tokio::test]
async fn stops_without_delivering_when_target_capture_fails() {
    let trace = trace(&json!({"failCapture":true})).await;
    assert_eq!(effect_names(&trace), ["capture"]);
    assert_eq!(trace["after"]["entries"][0][2], "queued");
}
