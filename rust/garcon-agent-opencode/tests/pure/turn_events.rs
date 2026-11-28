//! Ports `turn-events.test.js`.

use std::rc::Rc;

use crate::support::FIXED_NOW;
use garcon_agent_opencode::agents::opencode::sse_events::OpenCodeAssistantTerminal;
use garcon_agent_opencode::agents::opencode::turn_events::{
    ActivateTurnInput, SessionData, SessionStatus, activate_open_code_session_turn,
    create_open_code_turn_context, open_code_turn_requires_provider_quiescence,
};
use garcon_agents_common::execution::runtime_events::AgentRuntimeOperation;
use garcon_contract::chat_modes::PermissionMode;

fn operation(run_id: &str) -> AgentRuntimeOperation {
    AgentRuntimeOperation {
        run_id: run_id.to_owned(),
        publish: Rc::new(|_| {}),
    }
}

fn create_turn(
    run_id: &str,
) -> garcon_agent_opencode::agents::opencode::turn_events::OpenCodeTurnContext {
    create_open_code_turn_context(operation(run_id), false, &|| "unused".to_owned())
}

#[test]
fn clears_retired_turn_control_state_when_a_successor_activates() {
    let previous_turn = create_turn("run-previous");
    let successor_turn = create_turn("run-successor");
    let session = garcon_agent_opencode::js::Shared::new(SessionData {
        status: SessionStatus::Completed,
        aborting: Some(true),
        chat_id: "chat-previous".to_owned(),
        model: Some("provider/previous".to_owned()),
        thinking_variant: Some("high".to_owned()),
        permission_mode: PermissionMode::Default,
        directory: Some("/previous".to_owned()),
        started_at: "1970-01-01T00:00:00.000Z".to_owned(),
        last_activity_at: 0.0,
        provider_work_requires_quiescence: true,
        active_steering_deliveries: 1,
        deferred_terminal: Some(OpenCodeAssistantTerminal::Aborted {
            message_id: "assistant-previous".to_owned(),
        }),
        pending_steering_revert_message_id: None,
        turn: previous_turn,
    });

    activate_open_code_session_turn(
        &session,
        ActivateTurnInput {
            chat_id: "chat-successor".to_owned(),
            model: Some("provider/successor".to_owned()),
            thinking_variant: Some("low".to_owned()),
            permission_mode: PermissionMode::Plan,
            directory: Some("/successor".to_owned()),
            turn: successor_turn.clone(),
        },
        FIXED_NOW as f64,
    );

    let data = session.borrow();
    assert_eq!(data.status, SessionStatus::Running);
    assert_eq!(data.aborting, Some(false));
    assert!(!data.provider_work_requires_quiescence);
    assert_eq!(data.active_steering_deliveries, 0);
    assert!(data.deferred_terminal.is_none());
    assert_eq!(data.chat_id, "chat-successor");
    assert_eq!(data.model.as_deref(), Some("provider/successor"));
    assert_eq!(data.thinking_variant.as_deref(), Some("low"));
    assert_eq!(data.permission_mode, PermissionMode::Plan);
    assert_eq!(data.directory.as_deref(), Some("/successor"));
    assert!(garcon_agent_opencode::js::Shared::ptr_eq(
        &data.turn,
        &successor_turn
    ));
    // The original reads the wall clock; the port takes the clock it is given.
    assert!(data.last_activity_at > 0.0);
}

#[test]
fn derives_quiescence_from_incomplete_prompts_and_uncertain_steering() {
    let turn = create_turn("run-a");
    assert!(open_code_turn_requires_provider_quiescence(&turn));

    turn.borrow_mut().provider_prompt_request_completed = true;
    assert!(!open_code_turn_requires_provider_quiescence(&turn));

    turn.borrow_mut().provider_steering_delivery_unconfirmed = true;
    assert!(open_code_turn_requires_provider_quiescence(&turn));

    turn.borrow_mut().provider_steering_delivery_unconfirmed = false;
    turn.borrow_mut()
        .pending_steering_message_ids
        .insert("user-steer".to_owned());
    assert!(open_code_turn_requires_provider_quiescence(&turn));
}
