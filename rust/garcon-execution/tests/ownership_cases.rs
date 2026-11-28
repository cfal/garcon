use std::{cell::Cell, collections::HashMap, path::Path, rc::Rc};

use garcon_cases::{CaseError, replay, round_tripped, unknown};
use garcon_execution::{
    execution_attempt::QueueExecutionAttempt,
    execution_ownership::{AdmissionAbortReason, ExecutionOwnership},
    turn_finalization_tracker::{QueuedTurnFinalizationOutcome, QueuedTurnFinalizationTracker},
    turn_identity::{TurnIdentity, matches_turn_identity},
};
use garcon_interface::execution::AgentExecutionAdmission;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

fn path(name: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/cases")
        .join(name)
}

fn decoded<T: DeserializeOwned>(value: &Value) -> Result<T, CaseError> {
    serde_json::from_value(value.clone())
        .map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn wire(value: impl Serialize) -> Value {
    let serialized = serde_json::to_string(&value).unwrap();
    garcon_js::json::from_str(&serialized).unwrap()
}

fn outcome<T: Serialize, E: std::fmt::Display>(value: Result<T, E>) -> Value {
    match value {
        Ok(value) => wire(value),
        Err(error) => json!({"error":error.to_string()}),
    }
}

fn steps(value: &Value) -> Result<&[Value], CaseError> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| CaseError::undeliverable("expected steps"))
}

fn string(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn reason(message: &str) -> AdmissionAbortReason {
    Rc::new(Box::new(std::io::Error::other(message.to_owned())))
}

#[test]
fn turn_identity_recordings() {
    replay(path("turn-identity"), |function, args| {
        if function != "matchesTurnIdentity" {
            return Err(CaseError::unhandled(function));
        }
        let expected: Option<TurnIdentity> = decoded(unknown(function, args.first())?.as_ref())?;
        let actual: Option<TurnIdentity> = decoded(unknown(function, args.get(1))?.as_ref())?;
        Ok(json!(matches_turn_identity(
            expected.as_ref(),
            actual.as_ref()
        )))
    });
}

fn attempt_trace(args: &[Value]) -> Result<Value, CaseError> {
    let attempt = QueueExecutionAttempt::new(decoded(&args[0])?, decoded(&args[1])?);
    let mut results = Vec::new();
    for step in steps(&args[2])? {
        results.push(match string(&step[0]) {
            "entryId" => wire(&attempt.entry_id),
            "identity" => wire(attempt.identity()),
            "matches" => {
                let turn: Option<TurnIdentity> = decoded(&step[1])?;
                json!(attempt.matches(turn.as_ref()))
            }
            "replaceReservedTurn" => outcome(attempt.replace_reserved_turn(decoded(&step[1])?)),
            "markLaunching" => {
                attempt.mark_launching();
                Value::Null
            }
            "markSettled" => {
                attempt.mark_settled();
                Value::Null
            }
            "markTerminalCommitted" => {
                attempt.mark_terminal_committed();
                Value::Null
            }
            "isSettled" => json!(attempt.is_settled()),
            "hasTerminalCommit" => json!(attempt.has_terminal_commit()),
            name => return Err(CaseError::unhandled(name)),
        });
    }
    Ok(Value::Array(results))
}

fn ownership_trace(args: &[Value]) -> Result<Value, CaseError> {
    let ids: Vec<String> = decoded(&args[0])?;
    let id_calls = Rc::new(Cell::new(0));
    let generation = Rc::clone(&id_calls);
    let owner = ExecutionOwnership::new(move || {
        let index = generation.get();
        generation.set(index + 1);
        ids.get(index)
            .cloned()
            .unwrap_or_else(|| "unexpected-id".into())
    });
    let mut direct = HashMap::new();
    let mut attempts = HashMap::new();
    let mut snapshots = HashMap::new();
    let mut results = Vec::new();
    for step in steps(&args[1])? {
        let chat = string(&step[1]);
        let label = string(&step[2]);
        let other = &step[3];
        results.push(match string(&step[0]) {
            "reserveDirect" => outcome(owner.reserve_direct(chat, &decoded(other)?).map(|reservation| {
                let encoded = json!({"chatId":reservation.chat_id,"reservationId":reservation.reservation_id});
                direct.insert(label, reservation);
                encoded
            })),
            "reserveTranscriptSnapshot" => outcome(owner.reserve_transcript_snapshot(chat).inspect(|reservation| {
                snapshots.insert(label, reservation.clone());
            })),
            "replaceTurnWithTranscriptSnapshot" => wire(owner.replace_turn_with_transcript_snapshot(chat, &decoded(other)?)
                .inspect(|reservation| { snapshots.insert(label, reservation.clone()); })),
            "installAttempt" => {
                let attempt = Rc::new(QueueExecutionAttempt::new(decoded(other)?, decoded(&step[4])?));
                outcome(owner.install_attempt(chat, Rc::clone(&attempt)).map(|_| {
                    attempts.insert(label, attempt);
                }))
            }
            "captureAttempt" => { attempts.insert(label, owner.attempt(chat).unwrap()); Value::Null }
            "attemptSettled" => json!(attempts[label].is_settled()),
            "attemptTerminalCommitted" => json!(attempts[label].has_terminal_commit()),
            "attemptIdentity" => wire(owner.attempt(chat).map(|attempt| attempt.identity())),
            "isDirectCurrent" => json!(owner.is_direct_current(&direct[label])),
            "releaseDirect" => { owner.release_direct(&direct[label]); Value::Null }
            "releaseTranscriptSnapshot" => outcome(owner.release_transcript_snapshot(&snapshots[label])),
            "isCurrentAttempt" => json!(owner.is_current_attempt(chat, &attempts[label])),
            "removeAttempt" => json!(owner.remove_attempt(chat, &attempts[label])),
            "retireAttempt" => {
                let reason = other.as_str().map(reason);
                json!(owner.retire_attempt(chat, &attempts[label], reason.as_ref()))
            }
            "abortAdmission" => { owner.abort_admission(chat, &reason(label)); Value::Null }
            "beginShutdown" => wire(owner.begin_shutdown(&reason(chat))),
            "clearChat" => { owner.clear_chat(chat, &reason(label)); Value::Null }
            "admissionSignal" => {
                let admission = &direct[label].execution_admission;
                json!({
                    "aborted": admission.signal().is_cancelled(),
                    "reason": admission.abort_reason().map(|reason| reason.to_string())
                })
            }
            "hasAnyOwner" => json!(owner.has_any_owner()),
            "hasOwner" => json!(owner.has_owner(chat)),
            "hasDirect" => json!(owner.has_direct(chat)),
            "hasAttempt" => json!(owner.has_attempt(chat)),
            "isDraining" => json!(owner.is_draining(chat)),
            "isTurnReserved" => json!(owner.is_turn_reserved(chat)),
            "hasTranscriptSnapshot" => json!(owner.has_transcript_snapshot(chat)),
            "turnReservedChatIds" => wire(owner.turn_reserved_chat_ids()),
            "beginDrain" => outcome(owner.begin_drain(chat)),
            "endDrain" => { owner.end_drain(chat); Value::Null }
            "setActiveDrainEntry" => outcome(owner.set_active_drain_entry(chat, label)),
            "markRunTerminalCommitted" => { owner.mark_run_terminal_committed(chat, label); Value::Null }
            "requestDrain" => { owner.request_drain(chat); Value::Null }
            "consumeDrainRequest" => { owner.consume_drain_request(chat); Value::Null }
            "hasDrainRequest" => json!(owner.has_drain_request(chat)),
            "hasSuppression" => json!(owner.has_suppression(chat, decoded(&step[2])?)),
            "enterAbortSuppression" => { owner.enter_abort_suppression(chat); Value::Null }
            "clearAbortSuppression" => { owner.clear_abort_suppression(chat); Value::Null }
            "enterDeletionSuppression" => { owner.enter_deletion_suppression(chat); Value::Null }
            "clearDeletionSuppression" => { owner.clear_deletion_suppression(chat); Value::Null }
            "enterManualStop" => { owner.enter_manual_stop(chat); Value::Null }
            "exitManualStop" => { owner.exit_manual_stop(chat, decoded(&step[2]["drainStillActive"])?); Value::Null }
            name => return Err(CaseError::unhandled(name)),
        });
    }
    Ok(json!({"results":results,"idCalls":id_calls.get()}))
}

async fn finalization_trace(input: &Value) -> Result<Value, CaseError> {
    let tracker = QueuedTurnFinalizationTracker::new();
    let mut handles = HashMap::new();
    let mut waiting = HashMap::new();
    let mut results = Vec::new();
    for step in steps(input)? {
        let chat = string(&step[1]);
        let turn = string(&step[2]);
        let argument = string(&step[3]);
        results.push(match string(&step[0]) {
            "begin" => outcome(tracker.begin(chat, turn).map(|handle| {
                handles.insert(argument, handle);
            })),
            "get" => match tracker.get(chat, Some(turn)) {
                Some(result) => wire(result.wait().await),
                None => Value::Null,
            },
            "capture" => {
                waiting.insert(argument, tracker.get(chat, Some(turn)).unwrap());
                Value::Null
            }
            "wait" => wire(waiting[argument].wait().await),
            "settle" => {
                handles[turn].settle(decoded(&step[3])?);
                Value::Null
            }
            "clearChat" => {
                tracker.clear_chat(chat);
                Value::Null
            }
            name => return Err(CaseError::unhandled(name)),
        });
    }
    Ok(Value::Array(results))
}

async fn finalization_retention(oldest_active: bool) -> Value {
    use QueuedTurnFinalizationOutcome::{Committed, NotCommitted};
    let tracker = QueuedTurnFinalizationTracker::new();
    let first = tracker.begin("chat", "oldest").unwrap();
    if !oldest_active {
        first.settle(Committed);
    }
    for index in 0..64 {
        tracker
            .begin("chat", &index.to_string())
            .unwrap()
            .settle(Committed);
    }
    let was_retained = tracker.get("chat", Some("oldest")).is_some();
    first.settle(NotCommitted);
    let prior_result = match tracker.get("chat", Some("oldest")) {
        Some(result) => Some(result.wait().await),
        None => None,
    };
    tracker.begin("chat", "newest").unwrap();
    json!({
        "wasRetained":was_retained,
        "priorResult":prior_result,
        "retainedAfterPrune":tracker.get("chat", Some("oldest")).is_some(),
    })
}

#[test]
fn ownership_lifecycle_recordings() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    replay(path("ownership"), |function, args| {
        let args = args
            .iter()
            .map(|arg| {
                Ok(round_tripped(function, Some(arg))?
                    .map_or(Value::Null, std::borrow::Cow::into_owned))
            })
            .collect::<Result<Vec<_>, CaseError>>()?;
        match function {
            "attemptTrace" => attempt_trace(&args),
            "ownershipTrace" => ownership_trace(&args),
            "finalizationTrace" => runtime.block_on(async {
                tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    finalization_trace(&args[0]),
                )
                .await
                .map_err(|_| CaseError::undeliverable("finalization never settled"))?
            }),
            "finalizationRetention" => {
                Ok(runtime.block_on(finalization_retention(decoded(&args[0])?)))
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}
