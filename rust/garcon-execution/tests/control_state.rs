use std::{collections::HashSet, path::Path, process::Command};

use garcon_base::errors::{DiagnosticError, ErrorInput, diagnostic_error_code};
use garcon_contract::chat_command_contracts::{CommandErrorCode, SteerDeliveryOutcome};
use garcon_contract::chat_execution_control::{
    ChatExecutionControlState, parse_chat_execution_control_state,
};
use garcon_contract::error_codes::ErrorCode;
use garcon_contract::ws_requests::AgentCommandImage;
use garcon_execution::chat_execution_control_repository::{
    ChatExecutionControlRepository, InMemoryChatExecutionControlRepository,
};
use garcon_execution::chat_execution_control_transitions::*;
use garcon_execution::control_state::*;

const NOW: &str = "2026-08-12T00:00:00.000Z";

fn add(
    state: &StoredChatExecutionControlState,
    content: &str,
    images: Vec<AgentCommandImage>,
    id: &str,
) -> ControlTransition<QueueMutationValue> {
    create_queue_entry(
        state,
        &QueueEntryInput {
            content: content.into(),
            images,
            command: None,
            submission: None,
        },
        &TransitionContext {
            now: NOW,
            new_id: &|| id.to_owned(),
            unsettled_queue_receipt_keys: &HashSet::new,
        },
    )
}

fn bun_output(source: &str) -> String {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("bun")
        .current_dir(root)
        .args([
            "-e",
            &format!(
                "if (Bun.version !== '1.4.3') throw new Error('expected Bun 1.4.3');\n{source}"
            ),
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn controller_projection_and_shared_parser_keep_distinct_bun_key_order() {
    let original = bun_output(
        r#"
      import { emptyStoredChatExecutionControl, toClientChatExecutionControlState } from './server/controller/chat-execution/control-state.ts';
      import { createQueueEntry } from './server/controller/chat-execution/chat-execution-control-transitions.ts';
      import { parseChatExecutionControlState } from './common/chat-execution-control.ts';
      const { next } = createQueueEntry(emptyStoredChatExecutionControl('s'), {
        content: 'prose', images: [{data: 'AAAA', mimeType: 'image/png'}],
      }, { now: '2026-08-12T00:00:00.000Z', newId: () => 'entry', unsettledQueueReceiptKeys: () => new Set() });
      const projected = toClientChatExecutionControlState(next);
      console.log(JSON.stringify(projected));
      console.log(JSON.stringify(parseChatExecutionControlState(projected)));
    "#,
    );
    let state = add(
        &empty_stored_chat_execution_control("s"),
        "prose",
        vec![AgentCommandImage {
            data: "AAAA".into(),
            name: None,
            mime_type: Some("image/png".into()),
        }],
        "entry",
    )
    .next;
    let projected = to_client_chat_execution_control_state(&state);
    let projected_wire = serde_json::to_string(&projected).unwrap();
    let shared: ChatExecutionControlState = projected.into();
    let parsed =
        parse_chat_execution_control_state(&garcon_js::json::from_str(&projected_wire).unwrap())
            .unwrap();
    assert_eq!(parsed, shared);
    let parser_wire = serde_json::to_string(&parsed).unwrap();
    assert_ne!(projected_wire, parser_wire);
    assert_eq!(format!("{projected_wire}\n{parser_wire}\n"), original);
}

#[test]
fn bounds_the_attachment_bytes_a_chat_may_hold_in_its_queue() {
    let large = AgentCommandImage {
        data: format!("data:image/png;base64,{}", "A".repeat(35_000_000)),
        name: Some("large.png".into()),
        mime_type: Some("image/png".into()),
    };
    let small = AgentCommandImage {
        data: "data:image/png;base64,AAAA".into(),
        name: Some("small.png".into()),
        mime_type: Some("image/png".into()),
    };
    assert_eq!(
        queued_attachment_bytes(std::slice::from_ref(&large)),
        26_250_000
    );
    let first = add(
        &empty_stored_chat_execution_control("s"),
        "first",
        vec![large.clone()],
        "first",
    );
    let full = add(&first.next, "second", vec![large], "second");
    assert_eq!(
        full.outcome,
        TransitionOutcome::Rejected {
            rejection: TransitionRejection::QueueAttachmentsFull
        }
    );
    assert_eq!(full.next, first.next);
    drop(full);
    assert!(
        matches!(add(&first.next, "small", vec![small], "small").outcome,
        TransitionOutcome::Ok { value } if !value.duplicate)
    );
    assert!(
        matches!(add(&first.next, "text only", Vec::new(), "text").outcome,
        TransitionOutcome::Ok { value } if !value.duplicate)
    );
}

#[test]
fn prioritizes_the_private_lane_without_advancing_the_public_version() {
    let state = add(
        &empty_stored_chat_execution_control("s"),
        "user",
        Vec::new(),
        "user",
    )
    .next;
    let context = TransitionContext {
        now: NOW,
        new_id: &|| "control".into(),
        unsettled_queue_receipt_keys: &HashSet::new,
    };
    let private = enqueue_control_input(
        &state,
        &StoredControlInput {
            content: "control".into(),
            transcript_view_id: "view".into(),
            created_at: NOW.into(),
            receipt: None,
        },
        &context,
    );
    assert!(private.changed);
    assert!(!private.public_changed);
    let next = dequeue_next_turn(&private.next, &context);
    assert!(matches!(
        next.outcome,
        TransitionOutcome::Ok {
            value: Some(DequeuedTurnInput::Control { .. })
        }
    ));
    assert!(next.changed);
    assert!(!next.public_changed);
    assert_eq!(next.next, state);
}

#[test]
fn protects_unsettled_receipts_over_the_terminal_receipt_capacity() {
    let mut state = empty_stored_chat_execution_control("s");
    state.applied_commands = (0..1_005)
        .map(|index| StoredAppliedQueueCommand {
            key: format!("key-{index}"),
            operation: StoredQueueCommandOperation::Create,
            entry_id: format!("entry-{index}"),
            applied_at: NOW.into(),
        })
        .collect();
    let context = TransitionContext {
        now: NOW,
        new_id: &|| panic!("a command provides its entry ID"),
        unsettled_queue_receipt_keys: &|| (0..1_002).map(|index| format!("key-{index}")).collect(),
    };
    let result = create_queue_entry(
        &state,
        &QueueEntryInput {
            content: "next".into(),
            images: Vec::new(),
            submission: None,
            command: Some(QueueCommandIdentity {
                key: "new-key".into(),
                entry_id: "new-entry".into(),
            }),
        },
        &context,
    );
    let keys: Vec<_> = result
        .next
        .applied_commands
        .iter()
        .map(|receipt| receipt.key.as_str())
        .collect();
    assert_eq!(keys.len(), 1_003);
    assert_eq!(keys[0], "key-0");
    assert_eq!(keys[1_001], "key-1001");
    assert_eq!(keys[1_002], "new-key");
}

#[test]
fn loads_missing_state_isolates_returned_values_and_deletes() {
    let repository = InMemoryChatExecutionControlRepository::new("s".into());
    let missing = repository.load("chat");
    assert_eq!(missing, empty_stored_chat_execution_control("s"));
    let mut state = add(&missing, "queued", Vec::new(), "entry").next;
    let mut saved = repository.save("chat", &state).unwrap();
    saved.entries[0].content = "save result".into();
    state.entries[0].content = "save input".into();
    let mut loaded = repository.load("chat");
    assert_eq!(loaded.entries[0].content, "queued");
    loaded.entries[0].content = "load result".into();
    assert_eq!(repository.load("chat").entries[0].content, "queued");
    repository.delete("chat");
    assert_eq!(repository.load("chat"), missing);
}

#[test]
fn preserves_every_applied_receipt_while_cloning_storage() {
    let repository = InMemoryChatExecutionControlRepository::new("s".into());
    let mut state = repository.load("chat");
    state.applied_commands = (0..1_005)
        .map(|index| StoredAppliedQueueCommand {
            key: format!("key-{index}"),
            operation: StoredQueueCommandOperation::Create,
            entry_id: format!("entry-{index}"),
            applied_at: NOW.into(),
        })
        .collect();
    repository.save("chat", &state).unwrap();
    assert_eq!(
        repository.load("chat").applied_commands,
        state.applied_commands
    );
}

#[test]
fn uses_one_identity_until_the_repository_is_replaced() {
    let repository = InMemoryChatExecutionControlRepository::new("server-a".into());
    let state = add(&repository.load("chat-1"), "queued", Vec::new(), "entry").next;
    repository.save("chat-1", &state).unwrap();
    assert_eq!(repository.load("chat-2").server_instance_id, "server-a");
    let replacement = InMemoryChatExecutionControlRepository::new("server-b".into());
    assert_eq!(
        replacement.load("chat-1"),
        empty_stored_chat_execution_control("server-b")
    );
}

#[test]
fn rejects_controls_owned_by_another_repository_instance() {
    let repository = InMemoryChatExecutionControlRepository::new("server-a".into());
    let error = repository
        .save("chat", &empty_stored_chat_execution_control("server-b"))
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Cannot save execution controls from another server instance"
    );
    assert_eq!(
        repository.load("chat"),
        empty_stored_chat_execution_control("server-a")
    );
}

#[test]
fn transition_errors_keep_their_control_snapshot_and_diagnostic_class() {
    use garcon_execution::types::{ControlTransitionError, transition_error};
    let mut source = add(
        &empty_stored_chat_execution_control("s"),
        "queued",
        Vec::new(),
        "entry",
    )
    .next;
    let error = transition_error(
        &TransitionRejection::QueueEntryRevisionConflict {
            entry_id: "entry".into(),
            actual_revision: 1,
        },
        &source,
    );
    source.entries.clear();
    assert_eq!(error.domain_error().status, 409);
    assert_eq!(
        error.to_string(),
        "This queued message changed before it could be saved"
    );
    assert_eq!(error.diagnostic_metadata().name, "QueueEntryMutationError");
    assert_eq!(
        diagnostic_error_code(ErrorInput::Diagnostic(&error)),
        "QUEUE_ENTRY_REVISION_CONFLICT"
    );
    let ControlTransitionError::Mutation(error) = error else {
        panic!("expected queue mutation error")
    };
    assert_eq!(error.control.entries[0].id, "entry");
}

#[test]
fn steering_errors_keep_the_cause_delivery_outcome_and_retry_policy() {
    use garcon_execution::execution_errors::*;
    use garcon_execution::queue_steer_error::QueueEntrySteerError;
    use garcon_execution::steering_errors::*;
    let code = CommandErrorCode::try_from(ErrorCode::STEER_OUTCOME_UNKNOWN).unwrap();
    let queued = QueueEntrySteerError::new(
        code,
        STEER_OUTCOME_UNKNOWN_MESSAGE,
        500,
        SteerDeliveryOutcome::Unknown,
        Some(&empty_stored_chat_execution_control("s")),
        None,
    );
    let delivery = SteerDeliveryError::new(Box::new(queued), SteerDeliveryFailureOutcome::Unknown);
    assert_eq!(delivery.domain.code, ErrorCode::STEER_OUTCOME_UNKNOWN);
    assert_eq!(delivery.diagnostic_metadata().name, "SteerDeliveryError");
    assert!(!delivery.domain.retryable);
    assert!(
        delivery
            .domain
            .cause
            .as_ref()
            .unwrap()
            .is::<QueueEntrySteerError>()
    );
    assert!(control_input_blocked_error().retryable);
    assert_eq!(server_shutting_down_error().status, 503);
    assert_eq!(chat_not_found_error().status, 404);
    assert_eq!(steering_unsupported_error().status, 422);
    assert_eq!(steer_turn_changed_error().status, 409);
}
