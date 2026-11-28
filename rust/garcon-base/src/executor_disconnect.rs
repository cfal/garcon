//! Ports `server/common/executor-disconnect.ts`.

use std::error::Error;
use std::fmt;
use std::ops::Deref;

use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};

/// Fails a run whose remote transcript binding could not resume after the
/// executor connection was lost.
pub const EXECUTOR_DISCONNECTED_MID_TURN: &str = "Executor disconnected mid-turn. The turn may still be running on the executor. Reload from native history after it finishes to recover missing output.";

/// Fails a run whose start, resume, or compaction the executor never began:
/// the request or its cancellation was lost with the connection, or the
/// executor went offline while the run was still being set up.
pub const EXECUTOR_DISCONNECTED_BEFORE_START: ExecutorDisconnectedBeforeStart =
    ExecutorDisconnectedBeforeStart {
        code: "EXECUTOR_UNAVAILABLE",
        message: "The executor connection was lost before this turn started. Send it again.",
    };

/// The failure an executor reports for a run it never began.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecutorDisconnectedBeforeStart {
    pub code: &'static str,
    pub message: &'static str,
}

/// A call that stopped waiting for a reconnecting executor before it was sent.
pub fn reconnect_timed_out() -> AgentCallError {
    AgentCallError::new(
        AgentDeliveryOutcome::NotDispatched,
        "The executor did not reconnect in time.",
    )
}

/// A remote call that failed because its executor session was lost: dropped
/// while it was being sent, or outstanding when the session retired. Setup
/// steps may retry it; the retry waits for the replacement session.
#[derive(Debug, Clone, PartialEq)]
pub struct ExecutorSessionLostError {
    call: AgentCallError,
}

impl ExecutorSessionLostError {
    pub fn new(
        outcome: AgentDeliveryOutcome,
        message: impl Into<String>,
    ) -> ExecutorSessionLostError {
        ExecutorSessionLostError {
            call: AgentCallError::new(outcome, message),
        }
    }
}

impl Deref for ExecutorSessionLostError {
    type Target = AgentCallError;

    fn deref(&self) -> &AgentCallError {
        &self.call
    }
}

impl From<ExecutorSessionLostError> for AgentCallError {
    fn from(error: ExecutorSessionLostError) -> AgentCallError {
        error.call
    }
}

impl fmt::Display for ExecutorSessionLostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.call, formatter)
    }
}

impl Error for ExecutorSessionLostError {}

/// Views an erased error as the original's AgentCallError base class.
pub fn as_agent_call_error<'a>(error: &'a (dyn Error + 'static)) -> Option<&'a AgentCallError> {
    error.downcast_ref::<AgentCallError>().or_else(|| {
        error
            .downcast_ref::<ExecutorSessionLostError>()
            .map(|error| &error.call)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_interface::errors::AgentIntegrationErrorCode;

    #[test]
    fn names_the_two_ways_a_run_is_failed_by_a_lost_executor() {
        assert_eq!(
            EXECUTOR_DISCONNECTED_MID_TURN,
            "Executor disconnected mid-turn. The turn may still be running on the executor. Reload from native history after it finishes to recover missing output."
        );
        assert_eq!(
            EXECUTOR_DISCONNECTED_BEFORE_START,
            ExecutorDisconnectedBeforeStart {
                code: "EXECUTOR_UNAVAILABLE",
                message: "The executor connection was lost before this turn started. Send it again.",
            }
        );
    }

    #[test]
    fn a_timed_out_reconnect_was_never_sent() {
        let error = reconnect_timed_out();
        assert_eq!(error.outcome, AgentDeliveryOutcome::NotDispatched);
        assert_eq!(error.message, "The executor did not reconnect in time.");
        assert_eq!(error.code, AgentIntegrationErrorCode::UNAVAILABLE);
        assert!(!error.retryable);
    }

    #[test]
    fn a_lost_session_keeps_its_outcome_and_reads_as_the_call_error_it_extends() {
        for (outcome, code) in [
            (
                AgentDeliveryOutcome::Unknown,
                AgentIntegrationErrorCode::OUTCOME_UNKNOWN,
            ),
            (
                AgentDeliveryOutcome::NotDispatched,
                AgentIntegrationErrorCode::UNAVAILABLE,
            ),
            (
                AgentDeliveryOutcome::Rejected,
                AgentIntegrationErrorCode::UNAVAILABLE,
            ),
        ] {
            let lost = ExecutorSessionLostError::new(
                outcome,
                "The connection to the executor dropped before it replied.",
            );
            assert_eq!(lost.outcome, outcome);
            assert_eq!(lost.code, code);
            assert_eq!(
                lost.message,
                "The connection to the executor dropped before it replied."
            );
            assert!(!lost.retryable);
            assert_eq!(
                lost.to_string(),
                "The connection to the executor dropped before it replied."
            );

            let call: &AgentCallError = &lost;
            assert_eq!(call.outcome, outcome);
            let call: AgentCallError = lost.clone().into();
            assert_eq!(call.outcome, outcome);

            // The class is recognized through an error reference, as
            // `instanceof` reads it.
            let boxed: Box<dyn Error> = Box::new(lost);
            let reference: &(dyn Error + 'static) = boxed.as_ref();
            assert!(
                reference
                    .downcast_ref::<ExecutorSessionLostError>()
                    .is_some()
            );
            assert!(reference.downcast_ref::<AgentCallError>().is_none());
        }
        // A call error that did not lose a session is not one.
        let plain: Box<dyn Error> = Box::new(reconnect_timed_out());
        assert!(plain.downcast_ref::<ExecutorSessionLostError>().is_none());
    }
}
