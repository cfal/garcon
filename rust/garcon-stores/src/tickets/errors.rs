use std::error::Error;

use garcon_base::ticket_error::TicketDomainError;
use garcon_contract::{
    error_codes::ErrorCode,
    ticket_validation::MAX_SAFE_TICKET_INTEGER,
    tickets::{Ticket, TicketComment, TicketErrorCode},
};

pub(crate) type Result<T> = std::result::Result<T, Box<dyn Error>>;

pub fn ticket_error(code: ErrorCode, message: &str) -> Box<dyn Error> {
    ticket_conflict(code, message, None, None)
}

pub(crate) fn ticket_conflict(
    code: ErrorCode,
    message: &str,
    ticket: Option<Ticket>,
    comment: Option<TicketComment>,
) -> Box<dyn Error> {
    // INFALLIBLE: only registered ticket error codes are supplied by these callers.
    let code = TicketErrorCode::try_from(code).expect("registered ticket code");
    Box::new(TicketDomainError::new(code, message, ticket, comment))
}

pub(super) fn ticket_storage_unavailable() -> Box<dyn Error> {
    ticket_error(
        ErrorCode::TICKET_STORAGE_UNAVAILABLE,
        "Ticket storage is unavailable. Restart the server or restore a valid database.",
    )
}

pub(super) fn next_ticket_counter(value: f64) -> Result<u64> {
    if !garcon_js::is_safe_integer(value) || value < 0.0 || value >= MAX_SAFE_TICKET_INTEGER - 1.0 {
        return Err(ticket_error(
            ErrorCode::TICKET_LIMIT_REACHED,
            "The ticket counter limit has been reached.",
        ));
    }
    Ok(value as u64 + 1)
}

#[derive(Debug, thiserror::Error)]
#[error("not ported")]
pub struct MissingChatAuthority;

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_cases::{CaseError, javascript_number, markers::undefined, replay};
    use serde_json::json;

    #[test]
    fn next_counter_matches_the_recorded_original() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/ticket-counter"),
            |function, args| {
                if function != "nextTicketCounter" {
                    return Err(CaseError::unhandled(function));
                }
                let number = javascript_number(function, args.first())?;
                match next_ticket_counter(number) {
                    Ok(value) => Ok(json!(value)),
                    Err(error) => {
                        let error = error
                            .downcast::<TicketDomainError>()
                            .map_err(|_| CaseError::unhandled(function))?;
                        Ok(
                            json!({"$":"error","name":TicketDomainError::NAME,"message":error.message,
                        "properties":{"code":ErrorCode::from(error.code).as_str(),"status":error.status,"retryable":error.retryable,
                        "currentTicket":error.current_ticket.as_ref().map_or_else(undefined, |value| json!(value)),
                        "currentComment":error.current_comment.as_ref().map_or_else(undefined, |value| json!(value))}}),
                        )
                    }
                }
            },
        );
    }
}
