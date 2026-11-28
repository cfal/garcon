use garcon_cases::{CaseError, javascript_number, markers, text, unknown};
use garcon_contract::{
    chat_types::{ChatMessage, parse_chat_message, parse_tool_use_message},
    transcript_seed::*,
};
use garcon_js::utf16;
use serde::Serialize;
use serde_json::Value;

fn wire(value: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&value).unwrap()).unwrap()
}

fn message(function: &str, value: &Value) -> Result<ChatMessage, CaseError> {
    parse_chat_message(value)
        .ok()
        .flatten()
        .ok_or_else(|| CaseError::unhandled(function))
}

fn messages(function: &str, value: &Value) -> Result<Vec<ChatMessage>, CaseError> {
    value
        .as_array()
        .ok_or_else(|| CaseError::unhandled(function))?
        .iter()
        .map(|value| message(function, value))
        .collect()
}

fn receipt(function: &str, value: &Value) -> Result<Option<NativeSeedReceipt>, CaseError> {
    if value.is_null() {
        Ok(None)
    } else {
        parse_native_seed_receipt(value)
            .map(Some)
            .ok_or_else(|| CaseError::unhandled(function))
    }
}

fn optional_number(function: &str, value: Option<&Value>) -> Result<Option<f64>, CaseError> {
    value
        .filter(|value| !value.is_null() && !markers::is_undefined(value))
        .map(|value| javascript_number(function, Some(value)))
        .transpose()
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let value = unknown(function, args.first())?;
    let char_budget =
        |error: CarriedContextBudgetTooSmall| CaseError::new("RangeError", error.to_string());
    Ok(match function {
        "createCarryoverTranscript" => wire(
            create_carryover_transcript(
                &messages(function, &value)?,
                javascript_number(function, args.get(1))?,
                text(function, args.get(2))?,
            )
            .map_err(char_budget)?,
        ),
        "createCarryoverTranscriptWithinCost" => wire(create_carryover_transcript_within_cost(
            &messages(function, &value)?,
            ProjectionCostBudget {
                maximum_cost: javascript_number(function, args.get(1))?,
                cost: &|text| {
                    (utf16::len(text) + text.bytes().filter(|&byte| byte == b'\n').count()) as f64
                },
            },
            text(function, args.get(2))?,
        )),
        "renderCarriedContext" => wire(
            render_carried_context(
                &messages(function, &value)?,
                optional_number(function, args.get(1))?,
            )
            .map_err(char_budget)?,
        ),
        "renderTranscriptSeed" => wire(render_transcript_seed(
            &messages(function, &value)?,
            optional_number(function, args.get(1))?,
            text(function, args.get(2))?,
        )),
        "boundProjectedMessage" => wire(bound_projected_message(message(function, &value)?)),
        "isProjectableMessage" => wire(is_projectable_message(&message(function, &value)?)),
        "isPublicationGapMessage" => wire(is_publication_gap_message(&message(function, &value)?)),
        "projectToolUseSummary" => {
            let tool =
                parse_tool_use_message(&value).ok_or_else(|| CaseError::unhandled(function))?;
            let redact = |value: &str| value.replace("Secret", "[redacted]");
            let redactor: &ToolSummaryRedactor<'_> = &redact;
            let redact = unknown(function, args.get(1))?.as_bool().unwrap_or(false);
            wire(project_tool_use_summary(&tool, redact.then_some(redactor)))
        }
        "sanitizeRecordedCarriedContext" => wire(sanitize_recorded_carried_context(
            messages(function, &value)?,
            receipt(function, unknown(function, args.get(1))?.as_ref())?.as_ref(),
            text(function, args.get(2))?,
        )),
        "retargetNativeSeedReceiptIfPreserved" => wire(
            retarget_native_seed_receipt_if_preserved(
                receipt(function, &value)?.as_ref(),
                text(function, args.get(1))?.ok_or_else(|| CaseError::unhandled(function))?,
                &messages(function, unknown(function, args.get(2))?.as_ref())?,
            )
            .map_err(|error| CaseError::new("Error", error.to_string()))?,
        ),
        _ => return Err(CaseError::unhandled(function)),
    })
}

#[test]
fn transcript_seed_projection_cases_match() {
    let stats = garcon_cases::replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/transcript-seed-projection"
        ),
        dispatch,
    );
    assert_eq!(stats.total, 697);
    assert_eq!(stats.with_wildcards, 0);
}
