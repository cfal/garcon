use std::{
    cell::RefCell,
    future::Future,
    path::Path,
    pin::Pin,
    rc::Rc,
    task::{Context, Poll, Waker},
    time::Duration,
};

use garcon_base::errors::{DiagnosticError, ErrorInput};
use garcon_cases::{CaseError, replay, unknown};
use garcon_execution::{
    command_ledger::{
        CommandLedger, CommandLedgerChange as Change, CommandLedgerDetail as Detail,
        CommandLedgerError, CommandLedgerOptions, CommandLedgerRecord, CommandLedgerStatus,
        CommandTerminalStatus, CommandTurnResult, InterruptionReason, LedgerAcceptInput,
        LedgerAcceptResult, PRE_SCHEDULE_FAILURE_ERROR_CODE, UnavailableTurnResultReason,
        command_ledger_key, command_payload_hash, compact_command_payload,
    },
    types::execution_error_input,
};
use garcon_interface::producer::AgentFinalResponse;
use garcon_js::{clock::ManualClock, json::Opaque};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn typed<T: DeserializeOwned>(value: &Value) -> Result<T, CaseError> {
    serde_json::from_value(value.clone())
        .map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn string(value: &Value) -> Result<&str, CaseError> {
    value
        .as_str()
        .ok_or_else(|| CaseError::undeliverable("expected text"))
}

fn patch(value: &Value) -> Result<Vec<Change>, CaseError> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let object = value
        .as_object()
        .ok_or_else(|| CaseError::undeliverable("expected a patch"))?;
    object
        .iter()
        .map(|(key, value)| {
            Ok(match key.as_str() {
                "commandType" => Change::CommandType(typed(value)?),
                "chatId" => Change::ChatId(typed(value)?),
                "clientRequestId" => Change::ClientRequestId(typed(value)?),
                "payload" => Change::Payload(typed(value)?),
                "payloadHash" => Change::PayloadHash(typed(value)?),
                "acceptedAt" => Change::AcceptedAt(typed(value)?),
                "status" => Change::Status(typed(value)?),
                "entryId" => Change::EntryId(typed(value)?),
                "turnId" => Change::TurnId(typed(value)?),
                "error" => Change::Detail(Detail::Error(typed(value)?)),
                "errorCode" => Change::Detail(Detail::ErrorCode(typed(value)?)),
                "deliveryOutcome" => Change::Detail(Detail::DeliveryOutcome(typed(value)?)),
                "forkPreparation" => Change::Detail(Detail::ForkPreparation(typed(value)?)),
                "stopOutcome" => Change::Detail(Detail::StopOutcome(typed(value)?)),
                "runTerminalObserved" => Change::Detail(Detail::RunTerminalObserved(typed(value)?)),
                "turnResult" => Change::Detail(Detail::TurnResult(typed(value)?)),
                "interruptionReason" => Change::Detail(Detail::InterruptionReason(typed(value)?)),
                "publicTerminalAt" => Change::Detail(Detail::PublicTerminalAt(typed(value)?)),
                "retainedPrivateTerminal" => {
                    Change::Detail(Detail::RetainedPrivateTerminal(typed(value)?))
                }
                "terminalRetentionOrdinal" => {
                    Change::Detail(Detail::TerminalRetentionOrdinal(typed(value)?))
                }
                // The original overwrites a patched updatedAt on every update.
                "updatedAt" => {
                    return Err(CaseError::undeliverable(
                        "unexpected updatedAt in ledger test",
                    ));
                }
                _ => {
                    return Err(CaseError::undeliverable(format!(
                        "unknown ledger field {key}"
                    )));
                }
            })
        })
        .collect()
}

fn wire(value: impl Serialize) -> String {
    serde_json::to_string(&value).unwrap()
}

fn error_wire(error: &CommandLedgerError) -> String {
    wire(json!({ "error": {
        "name": error.diagnostic_metadata().name,
        "message": error.to_string(),
    }}))
}

fn result_wire(result: Result<impl Serialize, CommandLedgerError>) -> String {
    match result {
        Ok(value) => wire(value),
        Err(error) => error_wire(&error),
    }
}

type PendingResult = Result<Option<CommandLedgerRecord>, String>;

struct PendingWait<'a> {
    signal: CancellationToken,
    reason: Rc<RefCell<String>>,
    future: Pin<Box<dyn Future<Output = PendingResult> + 'a>>,
    result: Option<PendingResult>,
}

impl<'a> PendingWait<'a> {
    fn start(ledger: &'a CommandLedger, chat: String, turn: String) -> Self {
        let signal = CancellationToken::new();
        let reason = Rc::new(RefCell::new(String::new()));
        let (owned_signal, owned_reason) = (signal.clone(), Rc::clone(&reason));
        let mut future = Box::pin(async move {
            ledger
                .wait_for_turn_terminal(&chat, &turn, &owned_signal, || {
                    owned_reason.borrow().clone()
                })
                .await
        });
        let result = match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(result) => Some(result),
            Poll::Pending => None,
        };
        Self {
            signal,
            reason,
            future,
            result,
        }
    }

    fn abort(&self, reason: String) {
        *self.reason.borrow_mut() = reason;
        self.signal.cancel();
    }

    async fn finish(self) -> PendingResult {
        match self.result {
            Some(result) => result,
            None => tokio::time::timeout(Duration::from_secs(1), self.future)
                .await
                .expect("the original already resolved this waiter"),
        }
    }
}

async fn trace(options: &Value, steps: &Value) -> Result<Value, CaseError> {
    let clock = Rc::new(ManualClock::new(60_123));
    let ledger = match CommandLedger::new(typed(options)?, clock.clone()) {
        Ok(ledger) => ledger,
        Err(error) => return Ok(garcon_js::json::from_str(&error_wire(&error)).unwrap()),
    };
    let mut waits = indexmap::IndexMap::new();
    let mut results = Vec::new();
    for step in steps
        .as_array()
        .ok_or_else(|| CaseError::undeliverable("expected steps"))?
    {
        let a = |i: usize| string(&step[i]);
        let result = match a(0)? {
            "time" => {
                clock.set(typed(&step[1])?);
                wire(Value::Null)
            }
            "key" => wire(command_ledger_key(a(1)?, a(2)?, a(3)?)),
            "hash" => wire(command_payload_hash(&typed(&step[1])?)),
            "compact" => wire(compact_command_payload(&typed(&step[1])?)),
            "accept" => result_wire(ledger.accept(&typed(&step[1])?).await),
            "observe" => result_wire(ledger.observe(&typed(&step[1])?).await),
            "getRecord" => wire(ledger.get_record(a(1)?).await),
            "getTurnRecord" => wire(ledger.get_turn_record(a(1)?, a(2)?).await),
            "update" => result_wire(ledger.update(a(1)?, patch(&step[2])?).await),
            "updateUnlessStatus" => {
                let statuses: Vec<CommandLedgerStatus> = typed(&step[2])?;
                result_wire(
                    ledger
                        .update_unless_status(a(1)?, &statuses, patch(&step[3])?)
                        .await,
                )
            }
            "clearFork" => result_wire(
                ledger
                    .update(a(1)?, [Change::Detail(Detail::ForkPreparation(None))])
                    .await,
            ),
            "settleTerminal" => result_wire(
                ledger
                    .settle_terminal(a(1)?, typed(&step[2])?, patch(&step[3])?)
                    .await,
            ),
            "setTurnResult" => {
                let response: Option<AgentFinalResponse> = typed(&step[3])?;
                result_wire(
                    ledger
                        .set_turn_result(a(1)?, a(2)?, response.as_ref())
                        .await,
                )
            }
            "markInterruptedWithoutRunTerminal" => result_wire(
                ledger
                    .mark_interrupted_without_run_terminal(a(1)?, a(2)?, typed(&step[3])?)
                    .await,
            ),
            "markPublicTerminal" => result_wire(
                ledger
                    .mark_public_terminal(a(1)?, a(2)?, typed(&step[3])?)
                    .await,
            ),
            "beginChatDeletion" => {
                ledger.begin_chat_deletion(a(1)?);
                wire(Value::Null)
            }
            "cancelChatDeletion" => result_wire(ledger.cancel_chat_deletion(a(1)?).await),
            "markChatInterrupted" => result_wire(ledger.mark_chat_interrupted(a(1)?).await),
            "unsettledQueueReceiptKeys" => wire(
                ledger
                    .unsettled_queue_receipt_keys(a(1)?)
                    .into_iter()
                    .collect::<Vec<_>>(),
            ),
            "startWait" => {
                waits.insert(
                    a(1)?,
                    PendingWait::start(&ledger, typed(&step[2])?, typed(&step[3])?),
                );
                wire(Value::Null)
            }
            "cancelWait" => {
                waits
                    .get(a(1)?)
                    .ok_or_else(|| CaseError::undeliverable("unknown waiter"))?
                    .abort(typed(&step[2])?);
                wire(Value::Null)
            }
            "finishWait" => {
                let wait = waits
                    .shift_remove(a(1)?)
                    .ok_or_else(|| CaseError::undeliverable("unknown waiter"))?;
                match wait.finish().await {
                    Ok(record) => wire(record),
                    Err(reason) => wire(json!({"error":{"name":"Error","message":reason}})),
                }
            }
            name => {
                return Err(CaseError::undeliverable(format!(
                    "unknown ledger step {name}"
                )));
            }
        };
        results.push(result);
    }
    let wire = format!("[{}]", results.join(","));
    let results: Value = garcon_js::json::from_str(&wire).unwrap();
    Ok(json!({ "results": results, "wire": wire }))
}

#[test]
fn command_ledger_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/cases/command-ledger");
    replay(dir, |name, args| {
        if name != "commandLedgerTrace" {
            return Err(CaseError::undeliverable(format!(
                "unexpected export {name}"
            )));
        }
        let options = unknown("options", args.first())?;
        let steps = unknown("steps", args.get(1))?;
        runtime.block_on(trace(&options, &steps))
    });
}

fn ledger(options: CommandLedgerOptions) -> CommandLedger {
    CommandLedger::new(options, Rc::new(ManualClock::new(1_000))).unwrap()
}

fn input(command_type: &str, request: &str, turn: Option<&str>) -> LedgerAcceptInput {
    LedgerAcceptInput {
        command_type: command_type.into(),
        chat_id: "chat".into(),
        client_request_id: request.into(),
        payload: Opaque::from_value(json!({"text":"Synthetic prompt."})),
        turn_id: turn.map(str::to_owned),
        entry_id: None,
    }
}

async fn accept(ledger: &CommandLedger, request: &str) -> CommandLedgerRecord {
    let result = ledger
        .accept(&input("agent-run", request, Some(request)))
        .await
        .unwrap();
    let LedgerAcceptResult::Accepted { record } = result else {
        panic!("expected a fresh receipt");
    };
    record
}

async fn set_text(ledger: &CommandLedger, turn: &str, text: &str) {
    ledger
        .set_turn_result(
            "chat",
            turn,
            Some(&AgentFinalResponse::Text { text: text.into() }),
        )
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn captures_public_output_before_eviction_and_serves_fast_completions() {
    let ledger = ledger(CommandLedgerOptions {
        record_limit: Some(1.0),
        ..Default::default()
    });
    let first = accept(&ledger, "first").await;
    let waiting = PendingWait::start(&ledger, "chat".into(), "first".into());
    let second_waiter = PendingWait::start(&ledger, "chat".into(), "first".into());
    ledger
        .settle_terminal(&first.key, CommandTerminalStatus::Finished, [])
        .await
        .unwrap();
    assert!(
        ledger
            .get_turn_record("chat", "first")
            .await
            .unwrap()
            .public_terminal_at()
            .is_none()
    );
    set_text(&ledger, "first", "Synthetic answer.").await;
    let public = ledger
        .mark_public_terminal("chat", "first", None)
        .await
        .unwrap()
        .unwrap();
    let fast = PendingWait::start(&ledger, "chat".into(), "first".into());
    assert!(fast.result.is_some());
    assert_eq!(fast.finish().await.unwrap(), Some(public.clone()));
    let next = accept(&ledger, "next").await;
    ledger
        .settle_terminal(&next.key, CommandTerminalStatus::Finished, [])
        .await
        .unwrap();
    ledger
        .mark_public_terminal("chat", "next", None)
        .await
        .unwrap();
    assert!(ledger.get_turn_record("chat", "first").await.is_none());
    assert_eq!(waiting.finish().await.unwrap(), Some(public.clone()));
    assert_eq!(second_waiter.finish().await.unwrap(), Some(public));
}

#[tokio::test]
async fn aborts_independently_and_keeps_the_first_settlement() {
    let ledger = ledger(CommandLedgerOptions::default());
    let first = accept(&ledger, "first").await;
    let aborted = PendingWait::start(&ledger, "chat".into(), "first".into());
    let completed = PendingWait::start(&ledger, "chat".into(), "first".into());
    aborted.abort("first abort".into());
    ledger
        .settle_terminal(&first.key, CommandTerminalStatus::Finished, [])
        .await
        .unwrap();
    let terminal = ledger
        .mark_public_terminal("chat", "first", None)
        .await
        .unwrap();
    completed.abort("late abort".into());
    assert_eq!(aborted.finish().await, Err("first abort".into()));
    assert_eq!(completed.finish().await, Ok(terminal));

    let signal = CancellationToken::new();
    signal.cancel();
    assert_eq!(
        ledger
            .wait_for_turn_terminal("chat", "absent", &signal, || "already aborted")
            .await,
        Err("already aborted"),
    );
}

#[tokio::test]
async fn does_not_attach_a_pre_schedule_retry_waiter_to_the_replacement_turn() {
    let ledger = ledger(CommandLedgerOptions::default());
    let first = accept(&ledger, "first").await;
    let waiter = PendingWait::start(&ledger, "chat".into(), "first".into());
    ledger
        .update(
            &first.key,
            [
                Change::Status(CommandLedgerStatus::Failed),
                Change::Detail(Detail::ErrorCode(Some(
                    PRE_SCHEDULE_FAILURE_ERROR_CODE.into(),
                ))),
            ],
        )
        .await
        .unwrap();
    assert!(matches!(
        ledger
            .accept(&input("agent-run", "first", Some("replacement")))
            .await
            .unwrap(),
        LedgerAcceptResult::Accepted { .. }
    ));
    assert!(waiter.finish().await.unwrap().is_none());
    assert!(ledger.get_turn_record("chat", "first").await.is_none());
    assert!(
        ledger
            .get_turn_record("chat", "replacement")
            .await
            .is_some()
    );
}

#[tokio::test]
async fn defers_public_completion_until_deletion_resolves() {
    for confirmed in [false, true] {
        let ledger = ledger(CommandLedgerOptions::default());
        let first = accept(&ledger, "first").await;
        let waiter = PendingWait::start(&ledger, "chat".into(), "first".into());
        ledger.begin_chat_deletion("chat");
        ledger
            .settle_terminal(&first.key, CommandTerminalStatus::Finished, [])
            .await
            .unwrap();
        ledger
            .mark_public_terminal("chat", "first", Some(InterruptionReason::ChatDeleted))
            .await
            .unwrap();
        assert!(
            ledger
                .get_turn_record("chat", "first")
                .await
                .unwrap()
                .public_terminal_at()
                .is_none()
        );
        let expected = if confirmed {
            ledger.mark_chat_interrupted("chat").await.unwrap();
            InterruptionReason::ChatDeleted
        } else {
            ledger.cancel_chat_deletion("chat").await.unwrap();
            InterruptionReason::UserStop
        };
        assert_eq!(
            waiter
                .finish()
                .await
                .unwrap()
                .unwrap()
                .interruption_reason(),
            Some(&expected)
        );
    }
}

#[tokio::test]
async fn captures_output_before_later_result_retention_pressure_expires_it() {
    let ledger = ledger(CommandLedgerOptions {
        total_turn_result_byte_limit: Some(4.0),
        ..Default::default()
    });
    let first = accept(&ledger, "first").await;
    let waiting = PendingWait::start(&ledger, "chat".into(), "first".into());
    set_text(&ledger, "first", "🙂").await;
    ledger
        .settle_terminal(&first.key, CommandTerminalStatus::Finished, [])
        .await
        .unwrap();
    ledger
        .mark_public_terminal("chat", "first", None)
        .await
        .unwrap();
    accept(&ledger, "second").await;
    set_text(&ledger, "second", "5678").await;
    let received = waiting.finish().await.unwrap().unwrap();
    assert_eq!(
        received.turn_result(),
        Some(&CommandTurnResult::Available {
            text: "🙂".into(),
            bytes: 4
        })
    );
    let retained = ledger.get_turn_record("chat", "first").await.unwrap();
    assert_eq!(
        retained.turn_result(),
        Some(&CommandTurnResult::Unavailable {
            reason: UnavailableTurnResultReason::Expired,
        })
    );
}

#[tokio::test]
async fn bounds_retained_steering_identities_and_gets_the_error_through_erasure() {
    let ledger = ledger(CommandLedgerOptions {
        record_limit: Some(0.0),
        steer_identity_limit: Some(1.0),
        ..Default::default()
    });
    let first = input("steer", "first", None);
    let LedgerAcceptResult::Accepted { record } = ledger.accept(&first).await.unwrap() else {
        panic!("expected the first steer");
    };
    ledger
        .settle_terminal(&record.key, CommandTerminalStatus::Finished, [])
        .await
        .unwrap();
    assert!(matches!(
        ledger.accept(&first).await.unwrap(),
        LedgerAcceptResult::Duplicate { .. }
    ));
    let error: Box<dyn std::error::Error> = Box::new(
        ledger
            .accept(&input("steer", "second", None))
            .await
            .unwrap_err(),
    );
    let ErrorInput::Diagnostic(diagnostic) = execution_error_input(error.as_ref()) else {
        panic!("ledger error metadata was erased");
    };
    assert_eq!(
        diagnostic.diagnostic_metadata().name,
        "SteerIdentityCapacityError"
    );
}

#[tokio::test]
async fn does_not_share_records_between_process_lifetime_ledger_instances() {
    let options = CommandLedgerOptions {
        record_limit: Some(0.0),
        steer_identity_limit: Some(1.0),
        ..Default::default()
    };
    let original = ledger(options);
    let first = input("steer", "first", None);
    let LedgerAcceptResult::Accepted { record } = original.accept(&first).await.unwrap() else {
        panic!("expected a fresh steer");
    };
    original
        .settle_terminal(&record.key, CommandTerminalStatus::Finished, [])
        .await
        .unwrap();
    assert!(original.get_record(&record.key).await.is_some());
    let restarted = ledger(options);
    assert!(restarted.get_record(&record.key).await.is_none());
    assert!(matches!(
        restarted.accept(&first).await.unwrap(),
        LedgerAcceptResult::Accepted { .. }
    ));
}
