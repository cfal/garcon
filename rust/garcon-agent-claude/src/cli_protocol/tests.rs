use garcon_cases::{CaseError, replay, unknown};
use serde_json::json;

use super::*;

#[test]
fn cli_protocol_helpers_match_the_recorded_cases() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/cli-protocol"),
        |function, args| {
            let frame = unknown(function, args.first())?;
            match function {
                "claudeResultFailureMessage" => Ok(json!(claude_result_failure_message(&frame))),
                "claudeProviderSessionState" => Ok(json!(claude_provider_session_state(&frame))),
                "claudeBackgroundTaskCount" => Ok(json!(claude_background_task_count(&frame))),
                "isClaudeSubagentContent" => Ok(json!(is_claude_subagent_content(&frame))),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}

fn started() -> Value {
    json!({ "type": "command_lifecycle", "state": "started", "command_uuid": "submitted-input" })
}

#[test]
fn result_uuid_correlation_preserves_merged_and_untagged_fallbacks() {
    for (result, expected) in [
        (
            json!({ "user_message_uuid": "other-input", "user_message_uuids": ["other-input"] }),
            ClaudeResultCorrelation::Mismatched,
        ),
        (
            json!({ "user_message_uuid": "other-input", "user_message_uuids": ["submitted-input", "other-input"] }),
            ClaudeResultCorrelation::Input,
        ),
        (
            json!({ "user_message_uuids": [] }),
            ClaudeResultCorrelation::Input,
        ),
    ] {
        let mut turn = ClaudeTurnState::new("submitted-input".to_owned(), 0);
        assert_eq!(
            turn.correlate_result(&result),
            ClaudeResultCorrelation::BeforeStart
        );
        assert_eq!(
            turn.observe_input(&started()),
            Some(ClaudeTurnInputEvent::Started {
                source: ClaudeTurnStartSource::Lifecycle
            })
        );
        assert_eq!(turn.correlate_result(&result), expected);
        turn.record_accepted_result(&json!({ "result": "synthetic answer" }));
        assert_eq!(
            turn.correlate_result(&result),
            ClaudeResultCorrelation::Continuation
        );
    }
}

#[test]
fn a_zero_task_snapshot_does_not_confirm_consumption_until_a_continuation_result() {
    let mut turn = ClaudeTurnState::new("submitted-input".to_owned(), 2);
    turn.observe_input(&started());
    turn.observe_background_task_count(0);
    turn.record_accepted_result(&json!({ "result": "synthetic answer" }));
    assert!(turn.background_continuation_pending());
    turn.add_output_messages(1, true);
    assert!(turn.assistant_content_since_last_result());
    turn.record_accepted_result(&json!({ "result": "synthetic continuation" }));
    assert!(!turn.background_continuation_pending());
    assert!(!turn.assistant_content_since_last_result());
    assert!(turn.settlement_failure_message().is_none());
}

#[test]
fn aborted_streaming_result_is_clean_only_during_interrupt() {
    let mut turn = ClaudeTurnState::new("submitted-input".into(), 0);
    let terminal = json!({ "is_error": true, "terminal_reason": "aborted_streaming" });
    turn.record_accepted_result(&terminal);
    assert_eq!(
        turn.settlement_failure_message().as_deref(),
        Some("Claude CLI turn failed: aborted_streaming")
    );
    turn.clear_recorded_result_failure();
    turn.mark_abort_requested();
    turn.observe_input(&started());
    assert_eq!(turn.phase(), ClaudeTurnPhase::Interrupting);
    turn.record_accepted_result(&terminal);
    assert!(turn.clean_abort_result_seen());
    assert!(turn.settlement_failure_message().is_none());
}

#[test]
fn empty_completion_only_reports_retry_diagnostics_from_started_input() {
    let mut turn = ClaudeTurnState::new("submitted-input".into(), 0);
    let retry = json!({ "attempt": 2, "max_retries": 3, "error_status": 529, "error": "synthetic overloaded" });
    turn.record_api_retry(&retry);
    assert_eq!(
        turn.empty_completion_failure_message(),
        "Claude CLI completed the submitted message without producing a response."
    );
    turn.observe_input(&started());
    turn.record_api_retry(&retry);
    assert_eq!(
        turn.empty_completion_failure_message(),
        "Claude CLI completed the submitted message without producing a response. Last API retry: 529 synthetic overloaded (attempt 2/3)."
    );
}
