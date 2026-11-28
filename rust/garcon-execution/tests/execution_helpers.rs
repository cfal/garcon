use std::{cell::RefCell, error::Error, path::Path, rc::Rc};

use async_trait::async_trait;
use garcon_base::{
    domain_error::DomainError,
    errors::{ErrorInput, error_metadata},
    executor_disconnect::ExecutorSessionLostError,
};
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::{
    agents::AgentExecutionPolicy,
    async_user_questions::parse_async_question_reply,
    chat_types::UserMessage,
    error_codes::is_error_code,
    user_message_presentation::{UserMessagePresentation, parse_user_message_presentation},
    ws_requests::AgentCommandImage,
};
use garcon_execution::{
    accepted_input_transcript::{
        AcceptedInputTranscript, AcceptedInputTranscriptPort, AcceptedInputTranscriptResult,
        IdentifiedUserInput,
    },
    agent_turn_receipt_projector::project_agent_turn_receipt,
    chat_command_settlement::ChatCommandSettlement,
    chat_execution_control_transitions::FailurePauseCause,
    command_ledger::{
        CommandLedger, CommandLedgerChange as Change, CommandLedgerDetail as Detail,
        CommandLedgerOptions, LedgerAcceptInput, LedgerAcceptResult,
    },
    control_state::{StoredChatExecutionControlState, empty_stored_chat_execution_control},
    execution_attempt::QueueExecutionAttempt,
    execution_ownership::{AdmissionAbortReason, ExecutionAdmission, ExecutionOwnership},
    queue_steer_error::QueueEntrySteerError,
    runtime_router_errors::{
        dispatch_failure_detail, execution_setup_failure, is_lost_launch_reply,
        public_dispatch_failure,
    },
    steering_errors::{SteerDeliveryError, SteerDeliveryFailureOutcome},
    turn_identity::TurnIdentity,
    turn_terminal_settlement::*,
    types::{
        AcceptedExecutionCommand, CommandSettlementPort, ExecutionOperationResult,
        PreScheduleFailure, QueueEntryMutationCode, QueueEntryMutationError,
        UserInputAdmissionOptions, execution_error_input,
    },
};
use garcon_interface::{
    errors::{
        AgentCallError, AgentDeliveryOutcome, AgentIntegrationError,
        is_agent_integration_error_code,
    },
    execution::AgentExecutionAdmission,
    producer::AgentFinalResponse,
};
use garcon_js::{Number, clock::ManualClock, json::Opaque};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

#[path = "support/accepted_input_handler_trace.rs"]
mod accepted_input_handler_trace;

const CHAT: &str = "chat";
const TURN: &str = "turn";
const ENTRY: &str = "entry";
const REQUEST: &str = "request";

fn control() -> StoredChatExecutionControlState {
    empty_stored_chat_execution_control("server")
}

fn typed<T: DeserializeOwned>(input: &Value) -> T {
    serde_json::from_value(input.clone()).expect("typed oracle argument")
}

fn serialized(value: impl Serialize) -> Value {
    let text = serde_json::to_string(&value).unwrap();
    garcon_js::json::from_str(&text).unwrap()
}

fn error_shape(error: &(dyn Error + 'static)) -> Value {
    let metadata = match execution_error_input(error) {
        ErrorInput::Diagnostic(error) => error.diagnostic_metadata(),
        _ => error_metadata(error),
    };
    let outcome = if let Some(error) = error.downcast_ref::<QueueEntrySteerError>() {
        serialized(error.delivery_outcome)
    } else if let Some(error) = error.downcast_ref::<SteerDeliveryError>() {
        serialized(error.outcome)
    } else if let Some(error) = error.downcast_ref::<AgentCallError>() {
        json!(error.outcome.as_str())
    } else {
        Value::Null
    };
    json!({"name":metadata.name,"message":error.to_string(),"code":metadata.code,"outcome":outcome})
}

fn outcome(result: ExecutionOperationResult<impl Serialize>) -> Value {
    match result {
        Ok(result) => serialized(result),
        Err(error) => json!({ "error": error_shape(error.as_ref()) }),
    }
}

fn traced(result: Value, effects: Vec<Value>) -> Value {
    let mut trace = json!({ "result": result, "effects": effects });
    let wire = garcon_js::json::stringify(&trace);
    trace["wire"] = json!(wire);
    trace
}

fn decode_error(input: &Value) -> Box<dyn Error> {
    let message: String = typed(&input["message"]);
    match input["kind"].as_str() {
        Some("domain") => Box::new(DomainError::new(
            is_error_code(&input["code"]).unwrap(),
            message,
            typed(&input["status"]),
            false,
        )),
        Some("mutation") => {
            assert_eq!(input["code"], "QUEUE_ENTRY_REVISION_CONFLICT");
            Box::new(QueueEntryMutationError::new(
                QueueEntryMutationCode::RevisionConflict,
                message,
                &control(),
            ))
        }
        Some("agent-call") => Box::new(AgentCallError::new(
            match input["outcome"].as_str() {
                Some("unknown") => AgentDeliveryOutcome::Unknown,
                Some("not-dispatched") => AgentDeliveryOutcome::NotDispatched,
                Some("rejected") => AgentDeliveryOutcome::Rejected,
                _ => panic!("invalid agent delivery outcome"),
            },
            message,
        )),
        Some("integration") => Box::new(AgentIntegrationError::new(
            is_agent_integration_error_code(&input["code"]).unwrap(),
            message,
            false,
            None,
        )),
        Some("steer") => Box::new(SteerDeliveryError::new(
            Box::new(std::io::Error::other(message)),
            typed::<SteerDeliveryFailureOutcome>(&input["outcome"]),
        )),
        _ => Box::new(std::io::Error::other(message)),
    }
}

fn presentation(value: Option<&Value>) -> Option<UserMessagePresentation> {
    parse_user_message_presentation(value).unwrap()
}

fn input_options(input: &Value) -> UserInputAdmissionOptions {
    UserInputAdmissionOptions {
        client_request_id: typed(&input["clientRequestId"]),
        client_message_id: typed(&input["clientMessageId"]),
        transcript_view_id: typed(&input["transcriptViewId"]),
        turn_id: typed(&input["turnId"]),
        model: typed(&input["model"]),
        images: input.get("images").map(|images| {
            images
                .as_array()
                .unwrap()
                .iter()
                .map(|image| AgentCommandImage {
                    data: typed(&image["data"]),
                    name: typed(&image["name"]),
                    mime_type: typed(&image["mimeType"]),
                })
                .collect()
        }),
        excluded_resend_ordinals: typed::<Option<Vec<f64>>>(&input["excludedResendOrdinals"])
            .map(|values| values.into_iter().map(Number).collect()),
        question_reply: parse_async_question_reply(input.get("questionReply")).unwrap(),
        command_type: typed(&input["commandType"]),
        created_at: typed(&input["createdAt"]),
        user_message_presentation: presentation(input.get("userMessagePresentation")),
    }
}

struct TranscriptFake {
    effects: RefCell<Vec<Value>>,
    inserted: bool,
}

#[async_trait(?Send)]
impl AcceptedInputTranscriptPort for TranscriptFake {
    fn has_matching_input(
        &self,
        chat: &str,
        message: &UserMessage,
        _options: &UserInputAdmissionOptions,
    ) -> ExecutionOperationResult<bool> {
        self.effects
            .borrow_mut()
            .push(json!(["match", chat, serialized(message)]));
        Ok(true)
    }

    async fn admit_input(
        &self,
        chat: &str,
        message: UserMessage,
        args: IdentifiedUserInput<'_>,
    ) -> ExecutionOperationResult<AcceptedInputTranscriptResult> {
        self.effects.borrow_mut().push(json!([
            "direct",
            chat,
            serialized(message),
            args.client_request_id
        ]));
        Ok(AcceptedInputTranscriptResult {
            inserted: self.inserted,
        })
    }

    fn admit_queued_input(
        &self,
        chat: &str,
        message: UserMessage,
        args: IdentifiedUserInput<'_>,
    ) -> ExecutionOperationResult<AcceptedInputTranscriptResult> {
        self.effects.borrow_mut().push(json!([
            "queued",
            chat,
            serialized(message),
            args.client_request_id
        ]));
        Ok(AcceptedInputTranscriptResult {
            inserted: self.inserted,
        })
    }

    fn discard_prepared_input(&self, chat: &str, id: Option<&str>) -> ExecutionOperationResult<()> {
        self.effects.borrow_mut().push(json!(["discard", chat, id]));
        Ok(())
    }
}

async fn transcript_trace(steps: &Value, inserted: bool) -> Value {
    let fake = Rc::new(TranscriptFake {
        effects: RefCell::default(),
        inserted,
    });
    let transcript = AcceptedInputTranscript::new(fake.clone(), Rc::new(ManualClock::new(60_123)));
    let mut result = Vec::new();
    for step in steps.as_array().unwrap() {
        let content = step[1].as_str().unwrap_or_default();
        let options = input_options(&step[2]);
        result.push(match step[0].as_str().unwrap() {
            "hasMatching" => outcome(transcript.has_matching(CHAT, content, &options)),
            "register" => outcome(transcript.register(CHAT, content, &options).await),
            "registerQueued" => outcome(transcript.register_queued(CHAT, content, &options)),
            "discard" => outcome(transcript.discard(CHAT, step[1].as_str())),
            method => panic!("unexpected transcript action {method}"),
        });
    }
    traced(json!(result), fake.effects.take())
}

fn command(key: String) -> AcceptedExecutionCommand {
    AcceptedExecutionCommand {
        key,
        chat_id: CHAT.into(),
        turn_id: Some(TURN.into()),
        client_request_id: REQUEST.into(),
        entry_id: Some(ENTRY.into()),
    }
}

async fn command_settlement_trace(command_type: &str, steps: &Value) -> Value {
    let ledger = Rc::new(
        CommandLedger::new(
            CommandLedgerOptions::default(),
            Rc::new(ManualClock::new(60_123)),
        )
        .unwrap(),
    );
    let settle = ChatCommandSettlement::new(ledger.clone());
    let LedgerAcceptResult::Accepted { record } = ledger
        .accept(&LedgerAcceptInput {
            command_type: command_type.into(),
            chat_id: CHAT.into(),
            client_request_id: REQUEST.into(),
            payload: Opaque::from_value(json!({"content":"prompt","count":1.0})),
            turn_id: (command_type == "agent-run").then(|| TURN.into()),
            entry_id: None,
        })
        .await
        .unwrap()
    else {
        panic!("new ledger did not accept the input")
    };
    let command = command(record.key.clone());
    let mut result = Vec::new();
    for step in steps.as_array().unwrap() {
        let method = step[0].as_str().unwrap();
        let key = &record.key;
        result.push(match method {
            "project" => serialized(project_agent_turn_receipt(
                &ledger.get_record(key).await.unwrap(),
            )),
            "record" => serialized(ledger.get_record(key).await),
            "update" => {
                let patch = step[1]
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(key, value)| match key.as_str() {
                        "status" => Change::Status(typed(value)),
                        "publicTerminalAt" => {
                            Change::Detail(Detail::PublicTerminalAt(typed(value)))
                        }
                        "turnResult" => Change::Detail(Detail::TurnResult(typed(value))),
                        "forkPreparation" => Change::Detail(Detail::ForkPreparation(typed(value))),
                        key => panic!("unexpected patch key: {key}"),
                    })
                    .collect::<Vec<_>>();
                serialized(ledger.update(key, patch).await.unwrap())
            }
            "result" => {
                let response: Option<AgentFinalResponse> = typed(&step[1]);
                serialized(
                    ledger
                        .set_turn_result(CHAT, TURN, response.as_ref())
                        .await
                        .unwrap(),
                )
            }
            "publish" => serialized(
                ledger
                    .mark_public_terminal(CHAT, TURN, typed(&step[1]))
                    .await
                    .unwrap(),
            ),
            "terminal" => serialized(
                ledger
                    .settle_terminal(key, typed(&step[1]), [])
                    .await
                    .unwrap(),
            ),
            "markScheduled" => outcome(settle.mark_scheduled(&command, step[1].as_str()).await),
            "markPreScheduleFailure" => outcome(
                settle
                    .mark_pre_schedule_failure(
                        &command,
                        PreScheduleFailure {
                            error: decode_error(&step[1]).as_ref(),
                            retryable: typed(&step[2]),
                            preserve_fork_preparation: step[3].as_bool().unwrap_or(false),
                        },
                    )
                    .await,
            ),
            "settleQueueMutation" => outcome(
                settle
                    .settle_queue_mutation(&command, step[1].as_str().unwrap())
                    .await,
            ),
            "settleQueueMutationFailure" => outcome(
                settle
                    .settle_queue_mutation_failure(&command, decode_error(&step[1]).as_ref())
                    .await,
            ),
            "settleOperationFailure" => outcome(
                settle
                    .settle_operation_failure(&command, decode_error(&step[1]).as_ref())
                    .await,
            ),
            "settleSteerFailure" => outcome(
                settle
                    .settle_steer_failure(
                        &command,
                        decode_error(&step[1]).as_ref(),
                        typed(&step[2]),
                    )
                    .await,
            ),
            "settleSteerSuccess" => outcome(
                settle
                    .settle_steer_success(&command, step[1].as_str().unwrap())
                    .await,
            ),
            "settleDuplicateInput" => outcome(settle.settle_duplicate_input(&command).await),
            _ => panic!("unexpected settlement action {method}"),
        });
    }
    traced(json!(result), Vec::new())
}

fn runtime_failure_trace(input: &Value) -> Value {
    let error = decode_error(input);
    let public = public_dispatch_failure(error.as_ref());
    json!({
        "lostLaunch": is_lost_launch_reply(error.as_ref()),
        "setup": error_shape(execution_setup_failure(decode_error(input)).as_ref()),
        "detail": serialized(dispatch_failure_detail(error.as_ref())),
        "public": {"error":public.error,"errorCode":public.error_code.as_str()},
    })
}

struct TerminalFake<'a> {
    effects: RefCell<Vec<Value>>,
    options: &'a Value,
    owner: &'a ExecutionOwnership,
    attempt: Rc<QueueExecutionAttempt>,
    admission: Option<Rc<ExecutionAdmission>>,
}

impl TerminalFake<'_> {
    fn record(&self, effect: Value) {
        self.effects.borrow_mut().push(effect);
    }

    fn abort_state(&self) -> Option<bool> {
        self.admission
            .as_ref()
            .map(|admission| admission.signal().is_cancelled())
    }

    fn retire_as(
        &self,
        chat: &str,
        attempt: &Rc<QueueExecutionAttempt>,
        reason: Option<&AdmissionAbortReason>,
    ) {
        self.record(json!([
            "retire",
            chat,
            attempt.identity().turn_id,
            reason.map(|error| error.to_string())
        ]));
        self.owner.retire_attempt(chat, attempt, reason);
    }
}

#[async_trait(?Send)]
impl InterruptAgentTurnHost for TerminalFake<'_> {
    async fn abort_session(&self, chat: &str) -> ExecutionOperationResult<bool> {
        self.record(json!(["abort", chat, self.abort_state()]));
        if let Some(error) = self.options.get("error") {
            return Err(decode_error(error));
        }
        if self.options["stale"] == true {
            self.owner.retire_attempt(CHAT, &self.attempt, None);
        }
        Ok(self.options["acknowledged"] == true)
    }

    fn retire(
        &self,
        chat: &str,
        attempt: &Rc<QueueExecutionAttempt>,
        reason: &AdmissionAbortReason,
    ) -> ExecutionOperationResult<()> {
        self.retire_as(chat, attempt, Some(reason));
        Ok(())
    }
}

#[async_trait(?Send)]
impl TerminalSettlementHost for TerminalFake<'_> {
    fn execution_policy(&self, chat: &str) -> ExecutionOperationResult<AgentExecutionPolicy> {
        self.record(json!(["policy", chat]));
        Ok(self
            .options
            .get("policy")
            .map(typed)
            .unwrap_or(AgentExecutionPolicy::Conversation))
    }

    fn retire(
        &self,
        chat: &str,
        attempt: &Rc<QueueExecutionAttempt>,
    ) -> ExecutionOperationResult<()> {
        self.retire_as(chat, attempt, None);
        Ok(())
    }

    async fn check_idle(&self, chat: &str) -> ExecutionOperationResult<()> {
        self.record(json!(["idle", chat]));
        Ok(())
    }
}

#[async_trait(?Send)]
impl TerminalSettlementControl for TerminalFake<'_> {
    async fn pause_after_failure(
        &self,
        chat: &str,
        cause: &FailurePauseCause,
    ) -> ExecutionOperationResult<()> {
        self.record(json!(["pause", chat, serialized(cause)]));
        Ok(())
    }
}

#[async_trait(?Send)]
impl WorkingDirectorySettlementPort for TerminalFake<'_> {
    async fn settle(
        &self,
        chat: &str,
        turn: &TurnEventMetadata,
        is_current: &dyn Fn() -> bool,
    ) -> ExecutionOperationResult<WorkingDirectorySettlement> {
        self.record(json!(["working", chat, turn.turn_id, is_current()]));
        if self.options["stale"] == true {
            self.owner.retire_attempt(CHAT, &self.attempt, None);
        }
        if let Some(error) = self.options.get("error") {
            return Err(decode_error(error));
        }
        Ok(WorkingDirectorySettlement::Settled)
    }
}

async fn terminal_trace(options: &Value) -> Value {
    let owner = ExecutionOwnership::new(|| "id".into());
    let attempt = Rc::new(QueueExecutionAttempt::new(
        TurnIdentity {
            turn_id: Some(TURN.into()),
            client_request_id: None,
        },
        (options["entry"] == true).then(|| ENTRY.into()),
    ));
    let admission = (options["noAttempt"] != true)
        .then(|| owner.install_attempt(CHAT, attempt.clone()).unwrap());
    if options["terminal"] == true {
        owner.mark_run_terminal_committed(CHAT, TURN);
    }
    let fake = TerminalFake {
        effects: RefCell::default(),
        options,
        owner: &owner,
        attempt,
        admission,
    };
    let result = if options["mode"] == "interrupt" {
        outcome(interrupt_agent_turn(&owner, &fake, CHAT).await)
    } else {
        let deps = TerminalSettlementDependencies {
            ownership: &owner,
            control: &fake,
            host: &fake,
            working_directory: (options["working"] == true)
                .then_some(&fake as &dyn WorkingDirectorySettlementPort),
        };
        let turn = TurnEventMetadata {
            turn_id: Some(
                if options["wrong"] == true {
                    "other"
                } else {
                    TURN
                }
                .into(),
            ),
            ..TurnEventMetadata::default()
        };
        let terminal = if options["outcome"] == "failed" {
            AgentTurnSettlementOutcome::Failed
        } else {
            AgentTurnSettlementOutcome::Finished
        };
        outcome(settle_agent_turn(deps, CHAT, Some(&turn), terminal).await)
    };
    fake.record(json!([
        "final",
        owner.has_attempt(CHAT),
        fake.abort_state()
    ]));
    traced(result, fake.effects.take())
}

#[test]
fn execution_helpers_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cases/execution-helpers");
    replay(dir, |name, args| {
        let first = unknown("first", args.first())?;
        Ok(match name {
            "acceptedInputTranscriptTrace" => {
                runtime.block_on(transcript_trace(&first, typed(&args[1])))
            }
            "commandSettlementTrace" => {
                let steps = unknown("steps", args.get(1))?;
                runtime.block_on(command_settlement_trace(first.as_str().unwrap(), &steps))
            }
            "runtimeFailureTrace" => runtime_failure_trace(&first),
            "terminalSettlementTrace" => runtime.block_on(terminal_trace(&first)),
            "acceptedInputHandlerTrace" => {
                runtime.block_on(accepted_input_handler_trace::trace(&first))
            }
            _ => {
                return Err(CaseError::undeliverable(format!(
                    "unexpected helper {name}"
                )));
            }
        })
    });
}

#[tokio::test]
async fn keeps_terminal_ledger_state_pending_until_the_public_barrier() {
    let trace = command_settlement_trace(
        "agent-run",
        &json!([
            ["result", {"type":"text","text":"draft"}],
            ["terminal", "finished"],
            ["project"],
            ["publish"],
            ["project"]
        ]),
    )
    .await;
    assert_eq!(trace["result"][2]["receipt"]["state"], "pending");
    assert_eq!(trace["result"][4]["receipt"]["state"], "completed");
    assert_eq!(trace["result"][4]["receipt"]["output"]["text"], "draft");
}

#[tokio::test]
async fn queued_input_uses_only_the_synchronous_transcript_port() {
    let trace = transcript_trace(
        &json!([["registerQueued", "", {
            "clientRequestId":"request", "images":[{"data":"bytes","name":""}]
        }]]),
        false,
    )
    .await;
    assert_eq!(trace["result"], json!([false]));
    assert_eq!(trace["effects"].as_array().unwrap().len(), 1);
    assert_eq!(trace["effects"][0][0], "queued");
    assert_eq!(
        trace["effects"][0][2]["images"],
        json!([{"data":"bytes","name":"image-1"}])
    );
}

#[tokio::test]
async fn an_attempt_retired_during_working_directory_settlement_is_not_paused_again() {
    let trace = terminal_trace(&json!({
        "mode":"settle", "working":true, "stale":true, "policy":"literal", "outcome":"failed",
    }))
    .await;
    assert_eq!(trace["result"]["kind"], "settled");
    assert_eq!(
        trace["effects"],
        json!([["working", "chat", "turn", true], ["final", false, false]])
    );
}

#[test]
fn only_unknown_launch_errors_are_reclassified_before_dispatch() {
    let before: Box<dyn Error> =
        Box::new(AgentCallError::new(AgentDeliveryOutcome::Unknown, "lost"));
    assert!(is_lost_launch_reply(before.as_ref()));
    let after = execution_setup_failure(before);
    let after = after.downcast_ref::<AgentCallError>().unwrap();
    assert_eq!(after.outcome, AgentDeliveryOutcome::NotDispatched);
    assert_eq!(after.message, "The turn did not start: lost");
}

#[test]
fn setup_and_dispatch_classify_a_lost_executor_session_as_an_agent_call_error() {
    for (outcome, code) in [
        (AgentDeliveryOutcome::NotDispatched, "UNAVAILABLE"),
        (AgentDeliveryOutcome::Rejected, "UNAVAILABLE"),
        (AgentDeliveryOutcome::Unknown, "OUTCOME_UNKNOWN"),
    ] {
        let error: Box<dyn Error> = Box::new(ExecutorSessionLostError::new(outcome, "lost"));
        let detail = dispatch_failure_detail(error.as_ref());
        assert_eq!(detail.code, code);
        assert_eq!(detail.message.as_deref(), Some("lost"));
        assert_eq!(
            is_lost_launch_reply(error.as_ref()),
            outcome == AgentDeliveryOutcome::Unknown
        );
        let setup = execution_setup_failure(error);
        if outcome == AgentDeliveryOutcome::Unknown {
            let setup = setup.downcast_ref::<AgentCallError>().unwrap();
            assert_eq!(setup.outcome, AgentDeliveryOutcome::NotDispatched);
            assert_eq!(setup.message, "The turn did not start: lost");
        } else {
            assert_eq!(
                setup
                    .downcast_ref::<ExecutorSessionLostError>()
                    .unwrap()
                    .outcome,
                outcome
            );
        }
    }
}
