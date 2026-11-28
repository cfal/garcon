//! The recorded cases of `common/terminal-error.ts`.

use garcon_cases::{CaseError, markers, text};
use garcon_contract::terminal::TerminalErrorCode;
use garcon_contract::terminal_error::TerminalError;
use serde_json::Value;

use super::helpers::{self, typed};

fn dispatch_terminal_error(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "new TerminalError" => {
            let code = typed(function, args, |value| {
                serde_json::from_value::<TerminalErrorCode>(value.clone()).ok()
            })?;
            let message =
                text(function, args.get(1))?.ok_or_else(|| CaseError::unhandled(function))?;
            let unhandled = || CaseError::unhandled(function);
            let error = match args.get(2) {
                // The default status applies only where the original received `undefined`.
                None => TerminalError::new(code, message),
                Some(value) if markers::is_undefined(value) => TerminalError::new(code, message),
                Some(value) => TerminalError::with_status(
                    code,
                    message,
                    u16::try_from(value.as_u64().ok_or_else(unhandled)?)
                        .map_err(|_| unhandled())?,
                ),
            };
            Err(CaseError::new("TerminalError", error.message)
                .with_property("code", error.code.as_str())
                .with_property("status", error.status))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn terminal_error_cases_match() {
    helpers::recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/terminal-error"
        ),
        "common/terminal-error.ts",
        dispatch_terminal_error,
    );
}
