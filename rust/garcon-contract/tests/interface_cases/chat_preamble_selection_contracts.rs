use garcon_cases::{CaseError, unknown};
use garcon_contract::chat_preamble_selection_contracts::*;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    bun::bun_fixtures,
    helpers::{plain, recorded_cases},
};

#[test]
fn chat_preamble_selection_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/chat-preamble-selection-contracts"
        ),
        "common/chat-preamble-selection-contracts.ts",
        |function, args| {
            let value = unknown(function, args.first())?;
            match function {
                "parseChatPreambleSelectionTargetResponse" => {
                    Ok(plain(parse_chat_preamble_selection_target_response(&value)))
                }
                "parsePreambleSelectionPartialError" => {
                    Ok(plain(parse_preamble_selection_partial_error(&value)))
                }
                "parsePreambleSelectionPreviewRequest" => {
                    parse_preamble_selection_preview_request(&value)
                        .map(|result| json!(result))
                        .map_err(|error| {
                            CaseError::new("CommandRequestValidationError", error.message)
                        })
                }
                "parsePreambleSelectionPreviewResponse" => {
                    Ok(plain(parse_preamble_selection_preview_response(&value)))
                }
                "parseUpdateChatPreambleSelectionRequest" => {
                    parse_update_chat_preamble_selection_request(&value)
                        .map(|result| json!(result))
                        .map_err(|error| {
                            CaseError::new("CommandRequestValidationError", error.message)
                        })
                }
                "parseUpdateChatPreambleSelectionResponse" => {
                    Ok(plain(parse_update_chat_preamble_selection_response(&value)))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}

#[test]
fn preview_preserves_the_original_field_order() {
    #[derive(Deserialize)]
    struct Fixture {
        input: Value,
        expected: String,
    }

    let output = bun_fixtures("chat-preamble-selection-fixtures.ts");
    assert_eq!(output.lines().count(), 2);
    for line in output.lines() {
        let fixture: Fixture = garcon_js::json::from_str(line).unwrap();
        let result = parse_preamble_selection_preview_request(&fixture.input).unwrap();
        assert_eq!(serde_json::to_string(&result).unwrap(), fixture.expected);
    }
}
