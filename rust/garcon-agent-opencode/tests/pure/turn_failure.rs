//! Ports `turn-failure.test.js`.

use crate::support::{FIXED_NOW, build_turn, terminal_value};
use garcon_agent_opencode::agents::opencode::turn_failure::{
    latest_open_code_prompt_terminal, open_code_provider_failure_row,
};
use garcon_interface::native_message_source::{NativeMessageSource, get_native_message_source};
use garcon_js::ManualClock;
use serde_json::json;

#[test]
fn excludes_automatic_compaction_summaries_from_failure_attribution() {
    let turn = build_turn(
        &json!({
            "assistantMessageIds": ["assistant-visible", "assistant-summary"],
            "automaticCompactionMessageIds": ["assistant-summary"],
            "assistantTerminals": {
                "assistant-visible": {
                    "outcome": "failed",
                    "messageId": "assistant-visible",
                    "error": "visible failure",
                },
                "assistant-summary": {
                    "outcome": "failed",
                    "messageId": "assistant-summary",
                    "error": "internal failure",
                },
            },
        }),
        None,
    );

    let terminal = latest_open_code_prompt_terminal(&turn).expect("a terminal");
    assert_eq!(
        terminal_value(&terminal),
        json!({ "outcome": "failed", "messageId": "assistant-visible", "error": "visible failure" })
    );

    let row = open_code_provider_failure_row(
        "control failure",
        None,
        &turn,
        &ManualClock::new(FIXED_NOW),
    );
    assert_eq!(
        get_native_message_source(&row),
        Some(NativeMessageSource {
            entry_id: Some("assistant-visible".to_owned()),
            line_number: None,
            byte_offset: None,
            within_source_ordinal: None,
        })
    );
}
