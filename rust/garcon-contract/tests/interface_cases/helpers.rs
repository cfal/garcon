//! What the replay dispatchers share.

use garcon_cases::{CaseError, replay, unknown};
use serde_json::Value;

pub type Dispatcher = fn(&str, &[Value]) -> Result<Value, CaseError>;

/// Replays the recording in `directory`, which holds `module`, and requires
/// every recorded case to match.
pub fn recorded_cases(directory: &str, module: &str, dispatch: Dispatcher) {
    let stats = replay(directory, dispatch);
    // A wildcard would let the port return anything for that case.
    assert_eq!(
        stats.with_wildcards, 0,
        "{module}: the recording has wildcards"
    );
    assert_eq!(stats.passed, stats.total, "{module}: recorded cases differ");
}

/// A result the original returns as `null` where its parser refuses the value.
pub fn optional<T>(value: Option<T>, to_json: impl FnOnce(T) -> Value) -> Value {
    value.map_or(Value::Null, to_json)
}

/// A result that holds only plain JSON, as the original's `toEqual` sees it.
pub fn plain<T: serde::Serialize>(value: Option<T>) -> Value {
    value.map_or(Value::Null, |value| serde_json::to_value(&value).unwrap())
}

/// The recorded argument as the typed value the original takes, read with
/// the parser its own module validates with. An argument that parser refuses
/// cannot be handed to the port and is not handled.
pub fn typed<T>(
    function: &str,
    args: &[Value],
    parse: fn(&Value) -> Option<T>,
) -> Result<T, CaseError> {
    let value = unknown(function, args.first())?;
    parse(&value).ok_or_else(|| CaseError::unhandled(function))
}
