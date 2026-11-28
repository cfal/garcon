use garcon_cases::{CaseError, markers, round_tripped, text, unknown};
use garcon_contract::command_request_validation::*;
use serde_json::{Value, json};

use crate::helpers::recorded_cases;

fn outcome(error: CommandRequestValidationError) -> CaseError {
    CaseError::new("CommandRequestValidationError", error.message)
}

fn field<'a>(function: &str, argument: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, argument)?.ok_or_else(|| CaseError::unhandled(function))
}

fn optional(value: Option<impl serde::Serialize>) -> Value {
    value.map_or_else(markers::undefined, |value| json!(value))
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "new CommandRequestValidationError" => {
            return Err(outcome(CommandRequestValidationError::new(field(
                function,
                args.first(),
            )?)));
        }
        "isCommandCorrelationIdWithinLimit" => {
            return Ok(json!(is_command_correlation_id_within_limit(field(
                function,
                args.first()
            )?)));
        }
        "isQueueEntryIdWithinLimit" => {
            return Ok(json!(is_queue_entry_id_within_limit(field(
                function,
                args.first()
            )?)));
        }
        _ => {}
    }
    let value = unknown(function, args.first())?;
    if function == "requestRecord" {
        return Ok(json!(request_record(&value).map_err(outcome)?));
    }
    let name = field(function, args.get(1))?;
    if function == "optionalRecord" {
        return Ok(optional(optional_record(&value, name).map_err(outcome)?));
    }
    let body = request_record(&value).map_err(outcome)?;
    match function {
        "requiredString" => Ok(json!(required_string(body, name).map_err(outcome)?)),
        "requiredCommandCorrelationId" => Ok(json!(
            required_command_correlation_id(body, name).map_err(outcome)?
        )),
        "requiredQueueEntryId" => Ok(json!(required_queue_entry_id(body, name).map_err(outcome)?)),
        "requiredChatId" => Ok(json!(required_chat_id(body, name).map_err(outcome)?)),
        "optionalChatId" => Ok(optional(optional_chat_id(body, name).map_err(outcome)?)),
        "requiredContent" => Ok(json!(required_content(body, name).map_err(outcome)?)),
        "requiredStringContent" => Ok(json!(required_string_content(body, name).map_err(outcome)?)),
        "optionalString" => {
            let trim = match round_tripped(function, args.get(2))?.as_deref() {
                None => true,
                Some(Value::Bool(value)) => *value,
                _ => return Err(CaseError::unhandled(function)),
            };
            Ok(optional(
                optional_string(body, name, trim).map_err(outcome)?,
            ))
        }
        "optionalNonEmptyString" => Ok(optional(
            optional_non_empty_string(body, name).map_err(outcome)?,
        )),
        "optionalNullableString" => {
            let result = optional_nullable_string(body, name).map_err(outcome)?;
            Ok(if result.is_absent() {
                markers::undefined()
            } else {
                json!(result)
            })
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn command_request_validation_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/command-request-validation"
        ),
        "common/command-request-validation.ts",
        dispatch,
    );
}
