use garcon_cases::{CaseError, replay, text};
use garcon_contract::chat_row_contracts::{
    ChatRowUnpairedSurrogates, parse_add_chat_row_request_with_unpaired_surrogates,
};
use garcon_js::json::{from_slice, parse_with_unpaired_surrogate_fields};
use serde_json::Value;

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    if function != "parseChatRowJson" {
        return Err(CaseError::unhandled(function));
    }
    let input = text(function, args.first())?
        .ok_or_else(|| CaseError::undeliverable("expected JSON text"))?;
    let (body, [title, content]) =
        parse_with_unpaired_surrogate_fields(input, ["title", "content"])
            .map_err(|error| CaseError::undeliverable(error.to_string()))?;
    let request = parse_add_chat_row_request_with_unpaired_surrogates(
        &body,
        ChatRowUnpairedSurrogates { title, content },
    )
    .map_err(|error| CaseError::new("CommandRequestValidationError", error.message))?;
    let serialized = serde_json::to_vec(&request).unwrap();
    from_slice(&serialized).map_err(|error| CaseError::undeliverable(error.to_string()))
}

#[test]
fn matches_bun_on_raw_chat_row_json() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/chat-row-json"
        ),
        dispatch,
    );
}
