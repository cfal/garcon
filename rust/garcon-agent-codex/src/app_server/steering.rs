use std::{error::Error, sync::LazyLock};

use garcon_interface::services::{AgentSteerRejectionReason, AgentSteerResult};
use regress::Regex;

use super::client::CodexAppServerRpcError;

pub fn rejected_codex_steer(
    reason: AgentSteerRejectionReason,
    message: impl Into<String>,
) -> AgentSteerResult {
    AgentSteerResult::Rejected {
        reason,
        message: message.into(),
    }
}

pub fn classify_codex_steer_rejection(error: &CodexAppServerRpcError) -> AgentSteerResult {
    use AgentSteerRejectionReason as Reason;
    if actual_turn_id_from_steer_mismatch(error).is_some() {
        return rejected_codex_steer(Reason::TurnChanged, "The active Codex turn changed");
    }
    if is_active_turn_not_steerable_error(error) {
        return rejected_codex_steer(
            Reason::TurnNotSteerable,
            "The active Codex turn cannot be steered",
        );
    }
    if is_no_active_turn_error(error) {
        return rejected_codex_steer(Reason::NoActiveTurn, "No active Codex turn");
    }
    static INVALID_INPUT: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::with_flags(
            r"empty input|input.*(?:too large|limit|exceeds.*maximum length)|invalid input",
            "i",
        )
        .expect("Codex invalid steering input pattern")
    });
    let invalid = error
        .data
        .as_ref()
        .is_some_and(|data| data["input_error_code"] == "input_too_large")
        || INVALID_INPUT.find(&error.message).is_some();
    rejected_codex_steer(
        if invalid {
            Reason::InvalidInput
        } else {
            Reason::ProviderRejected
        },
        "Codex rejected the steering input",
    )
}

pub fn is_no_active_turn_error(error: &(dyn Error + 'static)) -> bool {
    static NO_ACTIVE: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::with_flags(r"no active turn|expected turn.*(?:not active|mismatch|active turn)|active turn.*not found", "i")
            .expect("Codex inactive turn pattern")
    });
    NO_ACTIVE.find(&error.to_string()).is_some()
}

pub fn is_active_turn_not_steerable_error(error: &(dyn Error + 'static)) -> bool {
    if error
        .downcast_ref::<CodexAppServerRpcError>()
        .and_then(|rpc| rpc.data.as_ref())
        .is_some_and(|data| {
            data["codexErrorInfo"]
                .get("activeTurnNotSteerable")
                .is_some()
        })
    {
        return true;
    }
    static NOT_STEERABLE: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::with_flags(r"cannot steer (?:a )?(?:review|compact) turn", "i")
            .expect("Codex nonsteerable turn pattern")
    });
    NOT_STEERABLE.find(&error.to_string()).is_some()
}

pub fn actual_turn_id_from_steer_mismatch(error: &(dyn Error + 'static)) -> Option<String> {
    static MISMATCH: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::new(r"^expected active turn id `[^`]+` but found `([^`]+)`$")
            .expect("Codex turn ID mismatch pattern")
    });
    let message = error.to_string();
    Some(message[MISMATCH.find(&message)?.group(1)?].to_owned())
}
