use std::{
    cell::{Cell, RefCell},
    error::Error,
    future::Future,
    path::Path,
    rc::Rc,
    task::{Context, Waker},
};

use async_trait::async_trait;
use garcon_base::{
    domain_error::{DomainError, as_domain_error},
    errors::{ErrorInput, error_metadata},
    executor_disconnect::ExecutorSessionLostError,
};
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::{
    async_user_questions::{AsyncQuestionReply, parse_async_question_reply},
    error_codes::is_error_code,
    ws_requests::AgentCommandImage,
};
use garcon_execution::{
    accepted_input_handler::AcceptedSteerDelivery,
    control_input_delivery::{
        ControlInputDelivery, ControlInputDeliveryOptions, ControlInputSignal, ControlRunReserved,
    },
    execution_attempt::QueueExecutionAttempt,
    execution_ownership::ExecutionOwnership,
    session_types::{AgentSteerOptions, RunAgentTurnOptions},
    steer_input_delivery::{SteerInputDelivery, SteerInputDeliveryHost, SteerInputDeliveryOptions},
    steering_errors::SteerDeliveryError,
    turn_identity::TurnIdentity,
    types::{
        AgentTurnRunnerPort, CapturedSteerTarget, ExecutionOperationResult, PrepareSteerDelivery,
        UserInputAdmissionOptions, execution_error_input,
    },
};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome},
    resources::{AgentResourceRef, AgentResourceScope},
    services::{AgentSteerResult, AgentSteerTarget, AgentSteerTargetKind},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::task::LocalSet;
use tokio_util::sync::CancellationToken;

#[path = "support/queue_drainer_trace.rs"]
mod queue_drainer_trace;
#[path = "support/queued_delivery_trace.rs"]
mod queued_delivery_trace;

const CHAT: &str = "chat-1";
const TURN: &str = "turn-1";
const VIEW: &str = "view-1";

fn provider_target() -> AgentSteerTarget {
    AgentResourceRef {
        scope: AgentResourceScope {
            executor_id: "executor".into(),
            instance_id: "instance".into(),
            integration_id: "agent".into(),
        },
        kind: AgentSteerTargetKind::SteerTarget,
        id: "target".into(),
    }
}

fn image() -> AgentCommandImage {
    AgentCommandImage {
        data: "data:image/png;base64,AAAA".into(),
        name: Some("screen.png".into()),
        mime_type: Some("image/png".into()),
    }
}

fn attempt(turn: &str) -> Rc<QueueExecutionAttempt> {
    Rc::new(QueueExecutionAttempt::new(
        TurnIdentity {
            turn_id: Some(turn.into()),
            client_request_id: Some("owner".into()),
        },
        None,
    ))
}

fn new_ids() -> impl Fn() -> String {
    let next = Cell::new(0);
    move || {
        next.set(next.get() + 1);
        format!("id-{}", next.get())
    }
}

fn typed<T: DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).expect("typed oracle argument")
}

fn serialized(value: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&value).unwrap()).unwrap()
}

fn failure(error: &(dyn Error + 'static)) -> Value {
    let metadata = match execution_error_input(error) {
        ErrorInput::Diagnostic(error) => error.diagnostic_metadata(),
        _ => error_metadata(error),
    };
    let steer = error.downcast_ref::<SteerDeliveryError>();
    let outcome = steer.map(|error| serialized(error.outcome));
    let status = as_domain_error(error)
        .map(|domain| domain.status)
        .or_else(|| steer.map(|error| error.domain.status));
    json!({"error":{"name":metadata.name,"code":metadata.code,"message":error.to_string(),"outcome":outcome,"status":status}})
}

fn outcome(result: ExecutionOperationResult<impl Serialize>) -> Value {
    match result {
        Ok(value) => serialized(value),
        Err(error) => failure(error.as_ref()),
    }
}

fn question() -> AsyncQuestionReply {
    parse_async_question_reply(Some(&json!({
        "questionId":"question","question":"Which environment?","answer":"Staging",
        "source":{"chatId":CHAT,"transcriptViewId":VIEW,"ordinal":1},
    })))
    .unwrap()
    .unwrap()
}

fn effect_names(trace: &Value) -> Vec<&str> {
    trace["effects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|event| event[0].as_str().unwrap())
        .collect()
}

struct SteerFake {
    spec: Value,
    attempt: Rc<QueueExecutionAttempt>,
    effects: RefCell<Vec<Value>>,
}

#[async_trait(?Send)]
impl AgentTurnRunnerPort for SteerFake {
    async fn run_agent_turn(
        &self,
        _: &str,
        _: &str,
        _: RunAgentTurnOptions,
    ) -> ExecutionOperationResult<()> {
        unreachable!("steering is not a fresh run")
    }

    async fn capture_steer_target(
        &self,
        chat: &str,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<Option<AgentSteerTarget>> {
        self.effects
            .borrow_mut()
            .push(json!(["capture", chat, deadline]));
        if self.spec["failCapture"] == true {
            return Err(Box::new(std::io::Error::other("target unavailable")));
        }
        Ok((self.spec["noTarget"] != true).then(provider_target))
    }

    async fn steer_input(
        &self,
        chat: &str,
        input: &str,
        options: &AgentSteerOptions,
        target: Option<&AgentSteerTarget>,
        prepare: PrepareSteerDelivery<'_>,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<AgentSteerResult> {
        self.effects.borrow_mut().push(json!([
            "provider",
            chat,
            input,
            options.client_request_id,
            options.client_message_id,
            target.map(|target| &target.id),
            deadline,
        ]));
        if let Some(reason) = self.spec.get("rejection") {
            return Ok(AgentSteerResult::Rejected {
                reason: typed(reason),
                message: "rejected".into(),
            });
        }
        if self.spec["preparation"] != false {
            if self.spec["settleInProvider"] == true {
                self.attempt.mark_settled();
            }
            prepare().await?;
            self.effects.borrow_mut().push(json!(["prepared"]));
        }
        let lost_session = self.spec.get("sessionLost");
        if let Some(outcome) = lost_session.or_else(|| self.spec.get("agentError")) {
            let outcome = match outcome.as_str().unwrap() {
                "not-dispatched" => AgentDeliveryOutcome::NotDispatched,
                "rejected" => AgentDeliveryOutcome::Rejected,
                "unknown" => AgentDeliveryOutcome::Unknown,
                value => panic!("unexpected agent outcome {value}"),
            };
            return Err(if lost_session.is_some() {
                Box::new(ExecutorSessionLostError::new(outcome, "send failed"))
            } else {
                Box::new(AgentCallError::new(outcome, "send failed"))
            });
        }
        if let Some(outcome) = self.spec.get("failure") {
            return Ok(AgentSteerResult::Failed {
                outcome: typed(outcome),
                message: "send failed".into(),
            });
        }
        Ok(AgentSteerResult::Accepted)
    }

    async fn abort_session(&self, _: &str) -> ExecutionOperationResult<bool> {
        unreachable!("steering cannot abort a session")
    }
    fn is_chat_running(&self, _: &str) -> bool {
        false
    }
}

#[async_trait(?Send)]
impl SteerInputDeliveryHost for SteerFake {
    fn is_shutting_down(&self) -> bool {
        self.spec["shutdown"] == true
    }

    async fn admit_input(
        &self,
        chat: &str,
        content: &str,
        options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        self.effects.borrow_mut().push(json!([
            "admit",
            chat,
            content,
            options.client_message_id,
            options.turn_id,
            options.command_type,
            serialized(&options.question_reply),
        ]));
        Ok(self.spec["inserted"] != false)
    }

    fn discard_prepared_input(
        &self,
        chat: &str,
        client_message_id: Option<&str>,
    ) -> ExecutionOperationResult<()> {
        self.effects
            .borrow_mut()
            .push(json!(["discard", chat, client_message_id]));
        Ok(())
    }
}

async fn steer_trace(spec: &Value) -> Value {
    let owner = Rc::new(ExecutionOwnership::new(new_ids()));
    let attempt = attempt(TURN);
    if spec["noAttempt"] != true {
        owner.install_attempt(CHAT, attempt.clone()).unwrap();
    }
    let fake = Rc::new(SteerFake {
        spec: spec.clone(),
        attempt: attempt.clone(),
        effects: RefCell::default(),
    });
    let delivery = SteerInputDelivery::new(
        SteerInputDeliveryOptions {
            turn_runner: fake.clone(),
            ownership: owner,
            host: fake.clone(),
        },
        new_ids(),
    );
    let deadline = spec["deadline"].as_f64();
    let effects = &fake.effects;
    let attempt = &attempt;
    let target = if spec["control"] == true {
        Ok(delivery.capture_control_target(CHAT, deadline).await)
    } else {
        delivery.capture_target(CHAT, deadline).await
    };
    let result = match target {
        Err(error) => failure(error.as_ref()),
        Ok(None) => Value::Null,
        Ok(Some(target)) if spec["control"] == true && spec["captureOnly"] == true => {
            json!({"turnId":target.turn_id,"providerTarget":serialized(target.provider_target)})
        }
        Ok(Some(target)) if spec["control"] == true => outcome(
            delivery
                .deliver_control(CHAT, "guidance", VIEW, &target)
                .await,
        ),
        Ok(Some(target)) => outcome(
            delivery
                .deliver(AcceptedSteerDelivery {
                    chat_id: CHAT,
                    content: "guidance",
                    provider_content: "resolved guidance",
                    options: AgentSteerOptions {
                        client_request_id: "request".into(),
                        client_message_id: "message".into(),
                        transcript_view_id: VIEW.into(),
                        question_reply: (spec["question"] == true).then(question),
                    },
                    target: &target,
                    after_pending_registered: Box::new(|turn_id| {
                        Box::pin(async move {
                            effects.borrow_mut().push(json!(["registered", turn_id]));
                            if spec["settleAfterAdmit"] == true {
                                attempt.mark_settled();
                            }
                            Ok(())
                        })
                    }),
                    user_message_presentation: None,
                })
                .await,
        ),
    };
    json!({"result":result,"effects":fake.effects.take()})
}

struct ControlFake {
    spec: Value,
    attempt: Rc<QueueExecutionAttempt>,
    effects: RefCell<Vec<Value>>,
}

fn named_domain_error(value: &Value) -> Box<DomainError> {
    let code = is_error_code(value).unwrap();
    Box::new(DomainError::new(code, code.as_str(), 409, false))
}

#[async_trait(?Send)]
impl ControlInputDeliveryOptions for ControlFake {
    async fn capture_target(
        &self,
        chat: &str,
    ) -> ExecutionOperationResult<Option<CapturedSteerTarget>> {
        self.effects.borrow_mut().push(json!(["capture", chat]));
        Ok(
            (self.spec["missingTarget"] != true).then(|| CapturedSteerTarget {
                attempt: self.attempt.clone(),
                turn_id: if self.spec["successor"] == true {
                    "turn-2"
                } else {
                    TURN
                }
                .into(),
                client_request_id: None,
                provider_target: (self.spec["noProvider"] != true).then(provider_target),
                deadline: None,
            }),
        )
    }

    async fn deliver_steer(
        &self,
        chat: &str,
        content: &str,
        view: &str,
        target: &CapturedSteerTarget,
    ) -> ExecutionOperationResult<()> {
        self.effects
            .borrow_mut()
            .push(json!(["steer", chat, content, view, target.turn_id]));
        if let Some(error) = self.spec.get("steerError") {
            return Err(named_domain_error(error));
        }
        Ok(())
    }

    async fn schedule_run(
        &self,
        chat: &str,
        content: &str,
        view: &str,
        on_reserved: ControlRunReserved<'_>,
    ) -> ExecutionOperationResult<()> {
        self.effects
            .borrow_mut()
            .push(json!(["run", chat, content, view]));
        if let Some(error) = self.spec.get("runError") {
            return Err(named_domain_error(error));
        }
        on_reserved("control-turn")
    }
}

async fn control_trace(spec: &Value) -> Value {
    let attempt = attempt(TURN);
    if spec["wait"].is_null() {
        attempt.mark_settled();
    }
    let fake = Rc::new(ControlFake {
        spec: spec.clone(),
        attempt: attempt.clone(),
        effects: RefCell::default(),
    });
    let delivery = ControlInputDelivery::new(fake.clone());
    let token = CancellationToken::new();
    let request = delivery.deliver(
        CHAT,
        "control",
        VIEW,
        (spec["noEmitter"] != true).then_some(TURN),
        ControlInputSignal {
            token: &token,
            reason: &|| Box::new(std::io::Error::other("chat deleted")),
        },
        Box::new(|turn_id| {
            fake.effects.borrow_mut().push(json!(["reserved", turn_id]));
            Ok(())
        }),
    );
    let mut request = Box::pin(request);
    let before = if spec["wait"].is_null() {
        Value::Null
    } else {
        assert!(
            request
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        let before = json!(*fake.effects.borrow());
        if spec["wait"] == "abort" {
            token.cancel();
        } else {
            attempt.mark_settled();
        }
        before
    };
    json!({"result":outcome(request.await),"before":before,"effects":fake.effects.take()})
}

#[test]
fn execution_delivery_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let local = LocalSet::new();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cases/execution-delivery");
    replay(dir, |name, args| {
        let input = unknown("delivery spec", args.first())?;
        Ok(match name {
            "steerDeliveryTrace" => local.block_on(&runtime, steer_trace(&input)),
            "controlDeliveryTrace" => local.block_on(&runtime, control_trace(&input)),
            "queuedDeliveryTrace" => local.block_on(&runtime, queued_delivery_trace::trace(&input)),
            "queueDrainerTrace" => local.block_on(&runtime, queue_drainer_trace::trace(&input)),
            _ => {
                return Err(CaseError::undeliverable(format!(
                    "unexpected delivery trace {name}"
                )));
            }
        })
    });
}

#[tokio::test]
async fn refuses_a_turn_that_cannot_take_steering_yet_before_admitting_the_input() {
    let trace = steer_trace(&json!({"noTarget":true,"question":true})).await;
    assert_eq!(trace["result"]["error"]["code"], "STEER_TURN_UNAVAILABLE");
    assert_eq!(effect_names(&trace), ["capture"]);
}

#[tokio::test]
async fn admits_the_input_before_delivering_it_to_a_steerable_turn() {
    let trace = steer_trace(&json!({"deadline":122.5})).await;
    assert_eq!(trace["result"], json!({"turnId":TURN,"duplicate":false}));
    assert_eq!(
        effect_names(&trace),
        [
            "capture",
            "admit",
            "registered",
            "provider",
            "prepared",
            "discard"
        ]
    );
    assert_eq!(trace["effects"][3][6], 122.5);
}

#[tokio::test]
async fn a_lost_session_uses_its_delivery_outcome_even_after_preparation() {
    for (outcome, code, delivery) in [
        ("not-dispatched", "STEER_NOT_DELIVERED", "not-sent"),
        ("rejected", "STEER_NOT_DELIVERED", "not-sent"),
        ("unknown", "STEER_OUTCOME_UNKNOWN", "unknown"),
    ] {
        let trace = steer_trace(&json!({"sessionLost":outcome})).await;
        assert!(effect_names(&trace).contains(&"prepared"));
        assert_eq!(trace["result"]["error"]["code"], code, "{outcome}");
        assert_eq!(trace["result"]["error"]["outcome"], delivery, "{outcome}");
    }
}

#[tokio::test]
async fn does_not_authorize_resubmitting_an_admitted_question_after_provider_rejection() {
    for reason in ["no-active-turn", "turn-changed"] {
        let trace = steer_trace(&json!({"question":true,"rejection":reason})).await;
        assert_eq!(trace["result"]["error"]["code"], "STEER_NOT_DELIVERED");
        assert_eq!(trace["result"]["error"]["outcome"], "not-sent");
        assert_eq!(
            effect_names(&trace),
            ["capture", "admit", "registered", "provider", "discard"]
        );
    }
}

#[tokio::test]
async fn does_not_authorize_another_route_when_the_captured_turn_settles_after_question_admission()
{
    let trace = steer_trace(&json!({"question":true,"settleAfterAdmit":true})).await;
    assert_eq!(trace["result"]["error"]["code"], "STEER_NOT_DELIVERED");
    assert_eq!(
        effect_names(&trace),
        ["capture", "admit", "registered", "discard"]
    );
}

#[tokio::test]
async fn uses_the_captured_emitting_turn_steer_exactly_once() {
    assert_eq!(
        effect_names(&control_trace(&json!({})).await),
        ["capture", "steer"]
    );
}

#[tokio::test]
async fn an_acceptance_without_the_pre_send_checkpoint_is_uncertain() {
    let trace = steer_trace(&json!({"preparation":false})).await;
    assert_eq!(trace["result"]["error"]["code"], "STEER_OUTCOME_UNKNOWN");
    assert_eq!(trace["result"]["error"]["outcome"], "unknown");
    assert_eq!(
        effect_names(&trace),
        ["capture", "admit", "registered", "provider", "discard"]
    );
}

#[tokio::test]
async fn schedules_one_direct_run_when_no_emitting_turn_is_attributable() {
    assert_eq!(
        effect_names(&control_trace(&json!({"noEmitter":true})).await),
        ["run", "reserved"]
    );
}

#[tokio::test]
async fn does_not_steer_a_mismatched_successor_turn() {
    assert_eq!(
        effect_names(&control_trace(&json!({"successor":true})).await),
        ["capture", "run", "reserved"]
    );
}

#[tokio::test]
async fn waits_for_the_rejected_emitting_attempt_before_one_direct_fallback() {
    let trace = control_trace(&json!({"steerError":"STEER_TURN_CHANGED","wait":"settle"})).await;
    assert_eq!(trace["before"].as_array().unwrap().len(), 2);
    assert_eq!(
        effect_names(&trace),
        ["capture", "steer", "run", "reserved"]
    );
}

#[tokio::test]
async fn uses_one_direct_fallback_after_definite_non_delivery() {
    for code in [
        "STEER_TURN_UNAVAILABLE",
        "STEER_TURN_NOT_STEERABLE",
        "OPERATION_UNSUPPORTED",
        "EXECUTOR_UNAVAILABLE",
        "STEER_NOT_DELIVERED",
    ] {
        let trace = control_trace(&json!({"steerError":code})).await;
        assert_eq!(
            effect_names(&trace),
            ["capture", "steer", "run", "reserved"],
            "{code}"
        );
    }
}

#[tokio::test]
async fn does_not_fall_back_after_ambiguous_delivery() {
    let trace = control_trace(&json!({"steerError":"STEER_OUTCOME_UNKNOWN"})).await;
    assert_eq!(trace["result"]["error"]["code"], "STEER_OUTCOME_UNKNOWN");
    assert_eq!(effect_names(&trace), ["capture", "steer"]);
}

#[tokio::test]
async fn waits_for_an_unsteerable_emitting_attempt_before_one_direct_fallback() {
    let trace = control_trace(&json!({"noProvider":true,"wait":"settle"})).await;
    assert_eq!(trace["before"], json!([["capture", CHAT]]));
    assert_eq!(effect_names(&trace), ["capture", "run", "reserved"]);
}

#[tokio::test]
async fn does_not_retry_a_failed_direct_reservation() {
    let trace = control_trace(&json!({"missingTarget":true,"runError":"SESSION_BUSY"})).await;
    assert_eq!(trace["result"]["error"]["code"], "SESSION_BUSY");
    assert_eq!(effect_names(&trace), ["capture", "run"]);
}

#[tokio::test]
async fn aborts_while_waiting_for_the_emitting_attempt_to_settle() {
    let trace = control_trace(&json!({"steerError":"STEER_TURN_CHANGED","wait":"abort"})).await;
    assert_eq!(trace["result"]["error"]["message"], "chat deleted");
    assert_eq!(effect_names(&trace), ["capture", "steer"]);
}
