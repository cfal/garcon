//! Ports `server-agents/opencode/src/agents/opencode/turn-failure.ts`.

use garcon_contract::chat_types::ErrorMessage;
use garcon_interface::native_message_source::{
    NativeMessageSourceInput, NativeSourced, attach_native_message_source,
};
use garcon_js::clock::{Clock, to_iso_string};

use super::sse_events::OpenCodeAssistantTerminal;
use super::turn_events::OpenCodeTurnContext;

// Early cancellation can poison later prompts without a new user Stop.
// https://github.com/anomalyco/opencode/issues/30144
pub const OPEN_CODE_ABORTED_TURN_FAILURE_MESSAGE: &str = "OpenCode interrupted the turn";

pub fn latest_open_code_prompt_terminal(
    turn: &OpenCodeTurnContext,
) -> Option<OpenCodeAssistantTerminal> {
    let turn = turn.borrow();
    turn.assistant_terminals
        .values()
        .rfind(|terminal| {
            !turn
                .automatic_compaction_message_ids
                .contains(terminal.message_id())
        })
        .cloned()
}

pub fn open_code_provider_failure_row(
    message: &str,
    entry_id: Option<&str>,
    turn: &OpenCodeTurnContext,
    clock: &dyn Clock,
) -> NativeSourced<ErrorMessage> {
    // INFALLIBLE: a wall clock reading is within the range a Date holds.
    let timestamp = to_iso_string(clock.now_ms()).expect("a wall clock reading is a valid Date");
    let mut row = NativeSourced::new(ErrorMessage {
        timestamp,
        content: message.to_owned(),
    });
    let source_entry_id = match entry_id {
        Some(entry_id) => Some(entry_id.to_owned()),
        None => {
            let turn = turn.borrow();
            turn.assistant_message_ids
                .iter()
                .rev()
                .find(|candidate| !turn.automatic_compaction_message_ids.contains(*candidate))
                .cloned()
        }
    };
    // Terminal failures use their exact assistant; control failures retain the last observed
    // non-compaction assistant as a stable native occurrence.
    if let Some(source_entry_id) = source_entry_id {
        attach_native_message_source(
            &mut row,
            Some(NativeMessageSourceInput {
                entry_id: Some(&source_entry_id),
                ..Default::default()
            }),
        );
    }
    row
}
