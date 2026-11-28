use std::{
    cell::Cell,
    future::{Future, ready},
    task::{Context, Poll, Waker},
};

use garcon_contract::{
    chat_command_contracts::SteerDeliveryOutcome,
    queue_state::{AutomaticQueuePauseKind, QueueEntryKind, QueuePause, QueuePauseKind},
};
use garcon_execution::{
    accepted_input_handler::{
        AcceptedInputControls, AcceptedInputCoordinator, AcceptedInputDeps, AcceptedInputHandler,
        AcceptedSteerDelivery,
    },
    chat_execution_control_operations::{QueueEntryMutationResult, QueueMoveResult, ReservedSteer},
    chat_execution_control_transitions::{
        DeleteQueueEntryInput, MoveQueueEntryInput, ObservedQueueEntry, QueueCommandIdentity,
        QueueEntryInput, QueueMutationValue, ReplaceQueueEntryInput,
    },
    control_state::{StoredQueueEntry, StoredQueueEntryStatus, StoredQueueSubmissionIdentity},
    session_types::RunAgentTurnOptions,
    types::{
        AcceptedDirectInput, AcceptedDirectOperation, AcceptedQueueCreate, AcceptedQueueDelete,
        AcceptedQueueEntrySteer, AcceptedQueueEntrySteerMark, AcceptedQueueMove,
        AcceptedQueueReplace, AcceptedQueueSteerCreate, AcceptedSteerInput, AcceptedSteerOutcome,
        BeforeFailureRelease, CapturedSteerTarget, DirectDispatch, DirectInputPreparation,
        DirectInputPreparationContext, DirectInputPreparationOperation, DirectTurnReservation,
        LocalExecutionFuture, ProjectAdmissionPort, QueueCommandMutationResult,
    },
};

use super::*;

struct HandlerFake {
    spec: Value,
    effects: RefCell<Vec<Value>>,
    tasks: RefCell<Vec<LocalExecutionFuture<'static>>>,
    owner: ExecutionOwnership,
    now: Cell<f64>,
}

impl HandlerFake {
    fn record(&self, label: &str, mut fields: Vec<Value>) -> ExecutionOperationResult<()> {
        fields.insert(0, json!(label));
        self.effects.borrow_mut().push(Value::Array(fields));
        if let Some(error) = self.spec["fail"].get(label) {
            return Err(decode_error(error));
        }
        if self.spec["abortAfter"] == label {
            let reason: AdmissionAbortReason =
                Rc::new(Box::new(std::io::Error::other("admission cancelled")));
            self.owner.abort_admission(CHAT, &reason);
        }
        Ok(())
    }
}

fn queue_record() -> QueueCommandMutationResult {
    QueueCommandMutationResult {
        entry_id: ENTRY.into(),
        control: control(),
        duplicate: false,
    }
}

fn queue_mutation() -> QueueEntryMutationResult {
    QueueEntryMutationResult {
        value: QueueMutationValue {
            entry_id: ENTRY.into(),
            entry: None,
            duplicate: false,
        },
        control: control(),
    }
}

fn queue_entry() -> StoredQueueEntry {
    StoredQueueEntry {
        id: ENTRY.into(),
        content: "queued guidance".into(),
        kind: QueueEntryKind::Steer,
        images: Vec::new(),
        revision: 2,
        status: StoredQueueEntryStatus::Steering,
        created_at: "now".into(),
        updated_at: "now".into(),
        submission: None,
    }
}

fn observed(input: &ObservedQueueEntry) -> Vec<Value> {
    vec![
        json!(input.entry_id),
        json!(input.expected_revision),
        json!(input.expected_reorder_revision),
    ]
}

#[async_trait(?Send)]
impl AcceptedInputControls for HandlerFake {
    async fn create(
        &self,
        _chat: &str,
        input: &QueueEntryInput,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        self.record(
            "create",
            vec![
                json!(input.content),
                serialized(&input.submission),
                json!(deadline),
            ],
        )?;
        Ok(queue_mutation())
    }

    async fn replace(
        &self,
        _chat: &str,
        input: &ReplaceQueueEntryInput,
    ) -> ExecutionOperationResult<QueueEntryMutationResult> {
        self.record(
            "replace",
            vec![
                json!(input.entry_id),
                json!(input.content),
                json!(input.expected_revision),
            ],
        )?;
        Ok(queue_mutation())
    }

    async fn delete(
        &self,
        _chat: &str,
        input: &DeleteQueueEntryInput,
    ) -> ExecutionOperationResult<QueueCommandMutationResult> {
        self.record("delete", vec![json!(input.entry_id)])?;
        Ok(queue_record())
    }

    async fn move_entry(
        &self,
        _chat: &str,
        input: &MoveQueueEntryInput,
    ) -> ExecutionOperationResult<QueueMoveResult> {
        self.record(
            "move",
            vec![
                json!(input.entry_id),
                json!(input.target_entry_id),
                json!(input.placement),
                json!(input.expected_reorder_revision),
                json!(input.expected_source_revision),
                json!(input.expected_target_revision),
                json!(input.command.as_ref().map(|command| &command.key)),
            ],
        )?;
        Ok(QueueMoveResult {
            entry_id: ENTRY.into(),
            duplicate: false,
            rebased: Some(false),
            control: control(),
        })
    }

    async fn create_steer(
        &self,
        _chat: &str,
        content: &str,
        _command: &QueueCommandIdentity,
        submission: &StoredQueueSubmissionIdentity,
    ) -> ExecutionOperationResult<QueueCommandMutationResult> {
        self.record("create-steer", vec![json!(content), serialized(submission)])?;
        Ok(queue_record())
    }

    async fn mark_steer(
        &self,
        _chat: &str,
        input: &ObservedQueueEntry,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.record("mark-steer", observed(input))?;
        Ok(control())
    }

    async fn reserve_steer(
        &self,
        _chat: &str,
        input: &ObservedQueueEntry,
    ) -> ExecutionOperationResult<ReservedSteer> {
        self.record("reserve-steer", observed(input))?;
        Ok(ReservedSteer {
            entry: queue_entry(),
            control: control(),
        })
    }

    async fn consume_steer(
        &self,
        _chat: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.record("consume", vec![json!(entry_id)])?;
        Ok(control())
    }

    async fn release_steer(
        &self,
        _chat: &str,
        entry_id: &str,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.record("release-steer", vec![json!(entry_id)])?;
        Ok(control())
    }

    async fn requeue_and_pause(
        &self,
        _chat: &str,
        entry_id: &str,
        kind: AutomaticQueuePauseKind,
    ) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.record("requeue", vec![json!(entry_id), json!(kind)])?;
        Ok(control())
    }

    async fn read(&self, _chat: &str) -> ExecutionOperationResult<StoredChatExecutionControlState> {
        self.record("read", Vec::new())?;
        let mut current = control();
        if self.spec["mode"] == "recover" {
            current.entries.push(queue_entry());
        }
        if self.spec["blocked"] == true {
            current.pause = Some(QueuePause {
                id: "pause".into(),
                kind: QueuePauseKind::Manual {
                    paused_at: "now".into(),
                },
            });
        }
        Ok(current)
    }
}

#[async_trait(?Send)]
impl AcceptedInputCoordinator for HandlerFake {
    fn request_drain(&self, chat: &str, context: &str) -> ExecutionOperationResult<()> {
        self.record("drain", vec![json!(chat), json!(context)])
    }

    fn reserve_direct(
        &self,
        chat: &str,
        turn: &TurnIdentity,
    ) -> ExecutionOperationResult<DirectTurnReservation> {
        self.record("reserve-direct", vec![json!(chat), json!(turn.turn_id)])?;
        Ok(self.owner.reserve_direct(chat, turn)?)
    }

    fn checkpoint(&self, reservation: &DirectTurnReservation) -> ExecutionOperationResult<()> {
        self.record("checkpoint", Vec::new())?;
        match reservation.execution_admission.abort_reason() {
            Some(reason) => Err(Box::new(std::io::Error::other(reason.to_string()))),
            None => Ok(()),
        }
    }

    fn has_matching_input(
        &self,
        _chat: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        self.record(
            "match",
            vec![
                json!(content),
                serialized(&options.user_message_presentation),
            ],
        )?;
        Ok(self.spec["duplicate"] == true)
    }

    async fn admit_input(
        &self,
        _chat: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        self.record(
            "admit",
            vec![
                json!(content),
                serialized(&options.user_message_presentation),
            ],
        )?;
        Ok(self.spec["inserted"] != false)
    }

    fn discard_prepared_input(
        &self,
        _chat: &str,
        message: Option<&str>,
    ) -> ExecutionOperationResult<()> {
        self.record("discard", vec![json!(message)])
    }

    async fn release_direct(
        &self,
        _reservation: &DirectTurnReservation,
    ) -> ExecutionOperationResult<()> {
        self.record("release-direct", Vec::new())
    }

    fn run_direct(
        self: Rc<Self>,
        reservation: DirectTurnReservation,
        content: String,
        options: RunAgentTurnOptions,
        dispatch: Option<DirectDispatch>,
        before: Option<BeforeFailureRelease>,
    ) -> LocalExecutionFuture<'static> {
        let mut future = Box::pin(async move {
            let delivered: ExecutionOperationResult<()> = async {
                self.record(
                    "run",
                    vec![json!(content), json!(options.turn_id), json!(false)],
                )?;
                if let Some(dispatch) = dispatch {
                    dispatch(reservation.execution_admission).await?;
                }
                Ok(())
            }
            .await;
            match (delivered, before) {
                (Err(error), Some(before)) => {
                    let error = Rc::new(error);
                    before(Rc::clone(&error)).await?;
                    Err(Rc::try_unwrap(error).expect("fake settlement does not retain the error"))
                }
                (result, _) => result,
            }
        });
        // Calling the JavaScript async fake runs its prefix before tracking.
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Pending => future,
            Poll::Ready(result) => Box::pin(ready(result)),
        }
    }

    fn track_dispatch(&self, task: LocalExecutionFuture<'static>) -> ExecutionOperationResult<()> {
        self.record("track", Vec::new())?;
        self.tasks.borrow_mut().push(task);
        Ok(())
    }

    async fn steer(
        &self,
        input: AcceptedSteerDelivery<'_>,
    ) -> ExecutionOperationResult<AcceptedSteerOutcome> {
        self.record(
            "steer",
            vec![
                json!(input.content),
                json!(input.provider_content),
                json!(input.options.client_message_id),
                json!(input.target.turn_id),
                serialized(input.user_message_presentation),
            ],
        )?;
        (input.after_pending_registered)(input.target.turn_id.clone()).await?;
        Ok(AcceptedSteerOutcome {
            turn_id: input.target.turn_id.clone(),
            duplicate: self.spec["steerDuplicate"] == true,
        })
    }
}

#[async_trait(?Send)]
impl ProjectAdmissionPort for HandlerFake {
    async fn assert_available(
        &self,
        _chat: &str,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<()> {
        self.record("project", vec![json!(deadline)])
    }
}

#[async_trait(?Send)]
impl DirectInputPreparation for HandlerFake {
    fn operation(&self) -> DirectInputPreparationOperation {
        DirectInputPreparationOperation::ForkRun
    }

    async fn prepare(
        &self,
        ctx: DirectInputPreparationContext<'_>,
    ) -> ExecutionOperationResult<()> {
        self.record("prepare", Vec::new())?;
        (ctx.assert_admission_active)()?;
        self.now
            .set(self.now.get() + self.spec["preparation"].as_f64().unwrap());
        Ok(())
    }

    async fn compensate(&self) -> ExecutionOperationResult<()> {
        self.record("compensate", Vec::new())
    }
}

#[async_trait(?Send)]
impl CommandSettlementPort for HandlerFake {
    async fn mark_scheduled(
        &self,
        _: &AcceptedExecutionCommand,
        turn: Option<&str>,
    ) -> ExecutionOperationResult<()> {
        self.record("scheduled", vec![json!(turn)])
    }

    async fn mark_pre_schedule_failure(
        &self,
        _: &AcceptedExecutionCommand,
        failure: PreScheduleFailure<'_>,
    ) -> ExecutionOperationResult<()> {
        self.record(
            "pre-failed",
            vec![
                error_shape(failure.error),
                json!(failure.retryable),
                json!(failure.preserve_fork_preparation),
            ],
        )
    }

    async fn settle_queue_mutation(
        &self,
        _: &AcceptedExecutionCommand,
        entry_id: &str,
    ) -> ExecutionOperationResult<()> {
        self.record("queue-done", vec![json!(entry_id)])
    }

    async fn settle_queue_mutation_failure(
        &self,
        _: &AcceptedExecutionCommand,
        error: &(dyn Error + 'static),
    ) -> ExecutionOperationResult<()> {
        self.record("queue-failed", vec![error_shape(error)])
    }

    async fn settle_steer_success(
        &self,
        _: &AcceptedExecutionCommand,
        turn: &str,
    ) -> ExecutionOperationResult<()> {
        self.record("steer-done", vec![json!(turn)])
    }

    async fn settle_steer_failure(
        &self,
        _: &AcceptedExecutionCommand,
        error: &(dyn Error + 'static),
        delivery: Option<SteerDeliveryOutcome>,
    ) -> ExecutionOperationResult<()> {
        self.record("steer-failed", vec![error_shape(error), json!(delivery)])
    }

    async fn settle_operation_failure(
        &self,
        _: &AcceptedExecutionCommand,
        error: &(dyn Error + 'static),
    ) -> ExecutionOperationResult<()> {
        self.record("operation-failed", vec![error_shape(error)])
    }

    async fn settle_duplicate_input(
        &self,
        _: &AcceptedExecutionCommand,
    ) -> ExecutionOperationResult<()> {
        self.record("duplicate", Vec::new())
    }
}

fn queue_command() -> AcceptedExecutionCommand<String> {
    let command = command("agent-run:chat:request".into());
    AcceptedExecutionCommand {
        key: command.key,
        chat_id: command.chat_id,
        client_request_id: command.client_request_id,
        turn_id: command.turn_id,
        entry_id: command.entry_id.unwrap(),
    }
}

fn steer_input<EntryId>(
    command: AcceptedExecutionCommand<EntryId>,
    fake: &Rc<HandlerFake>,
) -> AcceptedSteerInput<EntryId> {
    let identity = TurnIdentity {
        turn_id: Some("current".into()),
        client_request_id: None,
    };
    AcceptedSteerInput {
        question_reply: None,
        command,
        content: "new work".into(),
        provider_content: "resolved context".into(),
        client_message_id: "message".into(),
        transcript_view_id: "view".into(),
        target: CapturedSteerTarget {
            attempt: Rc::new(QueueExecutionAttempt::new(identity, None)),
            turn_id: "current".into(),
            client_request_id: None,
            provider_target: None,
            deadline: None,
        },
        settlement: fake.clone(),
        user_message_presentation: presentation(fake.spec.get("presentation")),
    }
}

fn dispatch(fake: &Rc<HandlerFake>) -> DirectDispatch {
    let fake = Rc::clone(fake);
    Box::new(move |_| Box::pin(async move { fake.record("dispatch", Vec::new()) }))
}

pub async fn trace(spec: &Value) -> Value {
    let fake = Rc::new(HandlerFake {
        spec: spec.clone(),
        effects: RefCell::default(),
        tasks: RefCell::default(),
        owner: ExecutionOwnership::new(|| "reservation".into()),
        now: Cell::new(spec["start"].as_f64().unwrap_or(19_000.0)),
    });
    let clock = fake.clone();
    let sequence = Cell::new(0);
    let handler = AcceptedInputHandler::new(
        AcceptedInputDeps {
            controls: fake.clone(),
            coordinator: fake.clone(),
            project_admission: fake.clone(),
        },
        move || clock.now.get(),
        move || {
            sequence.set(sequence.get() + 1);
            format!("id-{}", sequence.get())
        },
    );
    let deadline = spec["deadline"].as_f64();
    let result = match spec["mode"].as_str().unwrap() {
        "enqueue" => outcome(
            handler
                .enqueue(AcceptedQueueCreate {
                    command: queue_command(),
                    content: "new work".into(),
                    images: Vec::new(),
                    client_message_id: "message".into(),
                    transcript_view_id: "view".into(),
                    excluded_resend_ordinals: typed::<Option<Vec<f64>>>(&spec["excluded"])
                        .map(|ordinals| ordinals.into_iter().map(Number).collect()),
                    settlement: fake.clone(),
                    admission_deadline: deadline,
                })
                .await,
        ),
        "replace" => outcome(
            handler
                .replace(AcceptedQueueReplace {
                    command: queue_command(),
                    content: "new work".into(),
                    expected_revision: 2,
                    settlement: fake.clone(),
                })
                .await,
        ),
        "delete" => outcome(
            handler
                .delete(AcceptedQueueDelete {
                    command: queue_command(),
                    settlement: fake.clone(),
                })
                .await,
        ),
        "move" => outcome(
            handler
                .move_entry(AcceptedQueueMove {
                    command: queue_command(),
                    target_entry_id: "target".into(),
                    placement: typed(&json!("before")),
                    expected_reorder_revision: 4,
                    expected_source_revision: 2,
                    expected_target_revision: 3,
                    settlement: fake.clone(),
                })
                .await,
        ),
        "enqueueSteer" => outcome(
            handler
                .enqueue_steer(AcceptedQueueSteerCreate {
                    command: queue_command(),
                    content: "new work".into(),
                    client_message_id: "message".into(),
                    transcript_view_id: "view".into(),
                    settlement: fake.clone(),
                })
                .await,
        ),
        "markQueueEntrySteer" => outcome(
            handler
                .mark_queue_entry_steer(AcceptedQueueEntrySteerMark {
                    command: queue_command(),
                    expected_revision: 2,
                    expected_reorder_revision: 4,
                    settlement: fake.clone(),
                })
                .await,
        ),
        "recover" => outcome(handler.recover_queue_entry_steer(CHAT, ENTRY).await),
        "steer" => outcome(
            handler
                .steer(steer_input(command("agent-run:chat:request".into()), &fake))
                .await,
        ),
        "steerQueueEntry" => outcome(
            handler
                .steer_queue_entry(AcceptedQueueEntrySteer {
                    steer: steer_input(queue_command(), &fake),
                    expected_revision: 2,
                    expected_reorder_revision: 4,
                })
                .await,
        ),
        "scheduleOperation" => outcome(
            handler
                .schedule_operation(AcceptedDirectOperation {
                    command: command("agent-run:chat:request".into()),
                    settlement: fake.clone(),
                    dispatch: dispatch(&fake),
                    admission_deadline: deadline,
                })
                .await,
        ),
        mode @ ("schedule" | "runInitial") => {
            let input = AcceptedDirectInput {
                command: command("agent-run:chat:request".into()),
                content: "new work".into(),
                options: RunAgentTurnOptions {
                    turn_id: Some(TURN.into()),
                    client_message_id: Some("message".into()),
                    client_request_id: Some(REQUEST.into()),
                    ..Default::default()
                },
                settlement: fake.clone(),
                preparation: spec
                    .get("preparation")
                    .map(|_| fake.clone() as Rc<dyn DirectInputPreparation>),
                dispatch: (spec["dispatch"] == true).then(|| dispatch(&fake)),
                user_message_presentation: presentation(spec.get("presentation")),
                admission_deadline: deadline,
            };
            if mode == "runInitial" {
                outcome(handler.run_initial(input).await)
            } else {
                outcome(handler.schedule(input).await)
            }
        }
        mode => panic!("unexpected handler scenario {mode}"),
    };
    for task in fake.tasks.take() {
        task.await.unwrap();
    }
    traced(result, fake.effects.take())
}

fn effect_names(trace: &Value) -> Vec<&str> {
    trace["effects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|effect| effect[0].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn settles_an_enqueue_before_requesting_dispatch() {
    let result = trace(&json!({"mode":"enqueue"})).await;
    assert_eq!(effect_names(&result), ["create", "queue-done", "drain"]);
}

#[tokio::test]
async fn skips_control_preparation_and_project_admission_for_a_matching_input() {
    let result =
        trace(&json!({"mode":"schedule","duplicate":true,"preparation":60_000,"blocked":true}))
            .await;
    assert_eq!(result["result"], "duplicate");
    let effects = effect_names(&result);
    assert!(
        !effects
            .iter()
            .any(|p| matches!(*p, "read" | "prepare" | "project" | "admit" | "run"))
    );
    assert!(effects.ends_with(&["duplicate", "release-direct"]));
}

#[tokio::test]
async fn does_not_count_a_slow_preparation_against_the_deadline() {
    let result = trace(&json!({"mode":"schedule","preparation":60_000,"deadline":21_000})).await;
    let effects = result["effects"].as_array().unwrap();
    let measured = effects.iter().find(|event| event[0] == "project").unwrap();
    assert_eq!(measured[1].as_f64(), Some(81_000.0));
}

#[tokio::test]
async fn checks_admission_after_project_preflight_before_writing_input() {
    let result = trace(&json!({"mode":"schedule","preparation":5,"abortAfter":"project"})).await;
    assert_eq!(result["result"]["error"]["message"], "admission cancelled");
    let effects = effect_names(&result);
    assert!(!effects.contains(&"admit"));
    assert!(effects.ends_with(&["compensate", "discard", "release-direct", "pre-failed"]));
}

#[tokio::test]
async fn retains_a_prepared_target_when_preambles_block_its_opening_slash_command() {
    let result = trace(&json!({"mode":"schedule","preparation":5,"fail":{"admit":{
        "kind":"domain","code":"PREAMBLE_SLASH_COMMAND_BLOCKED","message":"blocked","status":422
    }}}))
    .await;
    assert_eq!(
        result["result"]["error"]["code"],
        "PREAMBLE_SLASH_COMMAND_BLOCKED"
    );
    assert!(!effect_names(&result).contains(&"compensate"));
    assert_eq!(
        result["effects"].as_array().unwrap().last().unwrap()[2],
        false
    );
}

#[tokio::test]
async fn consumes_the_queue_source_after_an_unknown_native_outcome() {
    let result = trace(&json!({"mode":"steerQueueEntry","fail":{"steer":{
        "kind":"steer","outcome":"unknown","message":"disconnected"
    }}}))
    .await;
    assert_eq!(result["result"]["error"]["outcome"], "unknown");
    assert_eq!(
        effect_names(&result),
        ["reserve-steer", "steer", "consume", "drain", "steer-failed"]
    );
}
