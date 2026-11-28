//! JavaScript semantics of the JSON values the ACP modules read.
//!
//! The agent's answers are JSON. Where the original reads a member, tests
//! truthiness, or compares with `===`, these helpers give the same answer on
//! a `serde_json::Value` whose numbers are JavaScript doubles, which is what
//! `garcon_js::json::Opaque` holds.

use std::error::Error;

use garcon_base::errors::NamedError;
use garcon_interface::resources::ExecutorResult;
use garcon_js::json::as_number;
use serde_json::Value;

/// The `TypeError` the original throws for reading a member of `null`.
/// `expression` is the member access as the original writes it.
pub(super) fn null_member_error(expression: &str) -> Box<dyn Error> {
    NamedError {
        name: "TypeError".to_owned(),
        message: format!("null is not an object (evaluating '{expression}')"),
        code: None,
    }
    .into()
}

/// `object.key`: absent on any value but an object, and the original's
/// `TypeError` when `object` is `null`.
pub(super) fn member<'a>(
    object: &'a Value,
    key: &str,
    expression: &str,
) -> ExecutorResult<Option<&'a Value>> {
    match object {
        Value::Object(entries) => Ok(entries.get(key)),
        Value::Null => Err(null_member_error(expression)),
        _ => Ok(None),
    }
}

/// Whether `value` is truthy: everything but `null`, `false`, `0`, and `""`.
pub(super) fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(_) => as_number(value) != Some(0.0),
        Value::String(text) => !text.is_empty(),
        _ => true,
    }
}

/// Whether `value` is the number `expected`, as `===` compares it.
pub(super) fn is_number(value: &Value, expected: f64) -> bool {
    as_number(value) == Some(expected)
}
