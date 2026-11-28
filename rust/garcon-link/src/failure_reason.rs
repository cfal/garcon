//! Ports `server/remote/transport/failure-reason.ts`.

use std::error::Error;

use garcon_js::{trim, utf16};

const MAX_REASON_LENGTH: usize = 200;

pub const MALFORMED_DATA: &str = "Malformed data";

pub enum Failure<'a> {
    Error(&'a (dyn Error + 'static)),
    SyntaxError {
        header: &'a str,
        stack: Option<&'a str>,
    },
    Text(&'a str),
}

pub fn failure_reason(error: Failure<'_>) -> String {
    let reason = match error {
        Failure::Error(error) if is_parse_error(error) => MALFORMED_DATA.to_owned(),
        Failure::Error(error) => error.to_string(),
        Failure::SyntaxError { header, stack } => malformed_data(header, stack),
        Failure::Text(text) => text.to_owned(),
    };
    if utf16::len(&reason) > MAX_REASON_LENGTH {
        format!("{}...", utf16::truncate(&reason, MAX_REASON_LENGTH))
    } else {
        reason
    }
}

pub(crate) fn is_parse_error(error: &(dyn Error + 'static)) -> bool {
    error
        .downcast_ref::<serde_json::Error>()
        .is_some_and(|error| error.is_syntax() || error.is_eof())
}

fn malformed_data(header: &str, stack: Option<&str>) -> String {
    let location = stack
        .and_then(|stack| stack.strip_prefix(header))
        .and_then(|frames| {
            frames
                .split('\n')
                .map(trim)
                .find(|frame| source_position(frame))
        });
    match location {
        Some(location) => format!("{MALFORMED_DATA} {location}"),
        None => MALFORMED_DATA.to_owned(),
    }
}

fn source_position(frame: &str) -> bool {
    let position = frame.strip_suffix(')').unwrap_or(frame);
    let Some((location, column)) = position.rsplit_once(':') else {
        return false;
    };
    let Some((name, line)) = location.rsplit_once(':') else {
        return false;
    };
    name.starts_with("at ")
        && [line, column]
            .into_iter()
            .all(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_a_parse_error_whose_message_can_echo_its_payload() {
        let error = garcon_js::json::parse(r#"{"synthetic": SYNTHETIC_SENTINEL}"#).unwrap_err();
        assert_eq!(failure_reason(Failure::Error(&error)), MALFORMED_DATA);
    }

    #[test]
    fn reads_the_location_from_stack_frames_not_from_the_message() {
        let header =
            "SyntaxError: SYNTHETIC_SENTINEL\n    at synthetic (/synthetic/sentinel.ts:1:1)";
        let stack = format!("{header}\n    at <parse> (:0)\n    at /synthetic/caller.ts:3:7");
        assert_eq!(
            failure_reason(Failure::SyntaxError {
                header,
                stack: Some(&stack)
            }),
            "Malformed data at /synthetic/caller.ts:3:7",
        );
    }
}
