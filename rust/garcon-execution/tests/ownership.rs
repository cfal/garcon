use std::{cell::Cell, future::ready, rc::Rc};

use garcon_execution::{
    execution_attempt::QueueExecutionAttempt,
    execution_ownership::{AdmissionAbortReason, ExecutionOwnership, ExecutionOwnershipError},
    turn_finalization_tracker::{QueuedTurnFinalizationOutcome, QueuedTurnFinalizationTracker},
    turn_identity::TurnIdentity,
    types::DrainSuppressionReason,
};
use garcon_interface::execution::AgentExecutionAdmission;

fn ownership() -> ExecutionOwnership {
    let next = Cell::new(0usize);
    ExecutionOwnership::new(move || {
        let id = next.get() + 1;
        next.set(id);
        id.to_string()
    })
}

fn turn(id: &str) -> TurnIdentity {
    TurnIdentity {
        turn_id: Some(id.to_owned()),
        client_request_id: None,
    }
}

fn reason(message: &str) -> AdmissionAbortReason {
    Rc::new(Box::new(std::io::Error::other(message.to_owned())))
}

#[test]
fn owns_a_defensive_turn_identity_and_matches_partial_turn_references() {
    let input = TurnIdentity {
        turn_id: Some("turn-1".into()),
        client_request_id: Some("request-1".into()),
    };
    let attempt = QueueExecutionAttempt::new(input.clone(), Some("entry-1".into()));
    let mut returned = attempt.identity();
    returned.turn_id = Some("mutated".into());
    assert_ne!(attempt.identity(), returned);
    assert_eq!(attempt.identity(), input);
    assert_eq!(attempt.entry_id.as_deref(), Some("entry-1"));
    assert!(attempt.matches(Some(&turn("turn-1"))));
    assert!(!attempt.matches(Some(&turn("other"))));
    assert!(!attempt.matches(None));
}

#[test]
fn replaces_an_identity_only_before_launch_or_settlement() {
    let attempt = QueueExecutionAttempt::new(turn("turn-1"), None);
    attempt.replace_reserved_turn(turn("turn-2")).unwrap();
    assert_eq!(attempt.identity(), turn("turn-2"));
    attempt.mark_launching();
    let error = attempt.replace_reserved_turn(turn("turn-3")).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Cannot replace the identity of a launched turn"
    );
    let settled = QueueExecutionAttempt::new(turn("old"), None);
    settled.mark_settled();
    assert_eq!(
        settled.replace_reserved_turn(turn("new")).unwrap_err(),
        error
    );
}

#[tokio::test]
async fn settles_every_current_and_future_waiter_exactly_once() {
    let attempt = QueueExecutionAttempt::new(turn("turn-1"), None);
    let first = attempt.wait_until_settled();
    let second = attempt.wait_until_settled();
    tokio::pin!(first, second);
    tokio::select! { biased;
        () = &mut first => panic!("first waiter released before settlement"),
        () = &mut second => panic!("second waiter released before settlement"),
        () = ready(()) => {}
    }
    attempt.mark_settled();
    attempt.mark_settled();
    tokio::join!(first, second, attempt.wait_until_settled());
    assert!(attempt.is_settled());
}

#[test]
fn refuses_a_second_direct_turn_while_one_is_reserved() {
    let ownership = ownership();
    let reservation = ownership.reserve_direct("chat", &turn("one")).unwrap();
    assert!(ownership.is_direct_current(&reservation));
    assert_eq!(
        ownership.reserve_direct("chat", &turn("two")).unwrap_err(),
        ExecutionOwnershipError::DirectAlreadyOwned,
    );
}

#[test]
fn refuses_a_direct_turn_while_a_previous_turn_is_still_settling() {
    let ownership = ownership();
    let reservation = ownership.reserve_direct("chat", &turn("one")).unwrap();
    ownership.release_direct(&reservation);
    assert!(!ownership.is_turn_reserved("chat"));
    assert!(ownership.has_owner("chat"));
    assert_eq!(
        ownership.reserve_direct("chat", &turn("two")).unwrap_err(),
        ExecutionOwnershipError::DirectAlreadyOwned,
    );
}

#[test]
fn refuses_a_direct_turn_while_a_drain_or_transcript_snapshot_owns_the_chat() {
    let draining = ownership();
    draining.begin_drain("chat").unwrap();
    assert_eq!(
        draining.reserve_direct("chat", &turn("one")).unwrap_err(),
        ExecutionOwnershipError::DirectAlreadyOwned
    );
    let snapshot = ownership();
    snapshot.reserve_transcript_snapshot("chat").unwrap();
    assert_eq!(
        snapshot.reserve_direct("chat", &turn("one")).unwrap_err(),
        ExecutionOwnershipError::DirectAlreadyOwned
    );
}

#[test]
fn reserves_again_once_the_settling_attempt_is_removed() {
    let ownership = ownership();
    let reservation = ownership.reserve_direct("chat", &turn("one")).unwrap();
    let attempt = ownership.attempt("chat").unwrap();
    ownership.release_direct(&reservation);
    assert!(ownership.remove_attempt("chat", &attempt));
    assert!(ownership.reserve_direct("chat", &turn("two")).is_ok());
}

#[test]
fn refuses_a_transcript_snapshot_while_a_turn_is_still_settling() {
    let ownership = ownership();
    ownership
        .install_attempt(
            "chat",
            Rc::new(QueueExecutionAttempt::new(
                turn("one"),
                Some("entry-1".into()),
            )),
        )
        .unwrap();
    assert_eq!(
        ownership.reserve_transcript_snapshot("chat").unwrap_err(),
        ExecutionOwnershipError::TranscriptSnapshotAlreadyOwned,
    );
}

#[test]
fn abort_and_deletion_suppressions_are_independent_and_scoped_per_chat() {
    use DrainSuppressionReason::{Abort, Deletion, ManualStop};
    let ownership = ownership();
    assert!(!ownership.has_suppression("one", Abort));
    ownership.enter_abort_suppression("one");
    ownership.enter_manual_stop("one");
    ownership.enter_deletion_suppression("two");
    assert!(ownership.has_suppression("one", Abort));
    assert!(ownership.has_suppression("one", ManualStop));
    assert!(!ownership.has_suppression("one", Deletion));
    assert!(ownership.has_suppression("two", Deletion));
    assert!(!ownership.has_suppression("two", ManualStop));
    ownership.clear_abort_suppression("one");
    ownership.clear_deletion_suppression("two");
    assert!(!ownership.has_suppression("one", Abort));
    assert!(!ownership.has_suppression("two", Deletion));
    assert!(!ownership.has_any_owner());
}

#[test]
fn manual_stop_is_retained_only_while_a_predating_drain_is_still_active() {
    use DrainSuppressionReason::{Abort, ManualStop};
    let ownership = ownership();
    ownership.enter_abort_suppression("chat");
    ownership.enter_manual_stop("chat");
    ownership.exit_manual_stop("chat", true);
    assert!(ownership.has_suppression("chat", ManualStop));
    ownership.clear_abort_suppression("chat");
    ownership.exit_manual_stop("chat", false);
    assert!(!ownership.has_suppression("chat", ManualStop));
    assert!(!ownership.has_suppression("chat", Abort));
}

#[tokio::test]
async fn shutdown_aborts_live_admission_but_waits_for_ownership_retirement() {
    let ownership = ownership();
    let reservation = ownership.reserve_direct("chat", &turn("one")).unwrap();
    let attempt = ownership.attempt("chat").unwrap();
    let closing = reason("shutdown");
    assert_eq!(ownership.begin_shutdown(&closing), ["chat"]);
    assert!(reservation.execution_admission.signal().is_cancelled());
    ownership.abort_admission("chat", &reason("ignored"));
    let recorded = reservation.execution_admission.abort_reason().unwrap();
    assert!(Rc::ptr_eq(&recorded, &closing));

    let wait = ownership.wait_for_owners();
    tokio::pin!(wait);
    ownership.release_direct(&reservation);
    ownership.notify_owners_changed();
    tokio::select! { biased;
        () = &mut wait => panic!("the settling turn still owns the chat"),
        () = ready(()) => {}
    }
    assert!(ownership.retire_attempt("chat", &attempt, None));
    ownership.notify_owners_changed();
    wait.await;
    assert!(attempt.is_settled());
}

#[tokio::test]
async fn deleting_a_chat_resolves_all_old_finalization_waiters_without_resurrection() {
    use QueuedTurnFinalizationOutcome::{Committed, NotCommitted};
    let tracker = QueuedTurnFinalizationTracker::new();
    let old = tracker.begin("chat", "turn").unwrap();
    let wait = tracker.get("chat", Some("turn")).unwrap();
    let duplicate = tracker.begin("chat", "turn").err().unwrap();
    assert_eq!(
        duplicate.to_string(),
        "Queued turn finalization already exists: chat/turn"
    );
    tracker.clear_chat("chat");
    let fresh = tracker.begin("chat", "turn").unwrap();
    old.settle(Committed);
    fresh.settle(Committed);
    assert_eq!(wait.wait().await, NotCommitted);
    assert_eq!(
        tracker.get("chat", Some("turn")).unwrap().wait().await,
        Committed
    );
}
