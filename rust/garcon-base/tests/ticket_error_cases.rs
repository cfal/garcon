use garcon_base::{
    domain_error::is_domain_error,
    errors::ErrorInput,
    http_error::json_error_from_unknown,
    ticket_error::{TicketDomainError, validate_ticket_input},
};
use garcon_cases::{CaseError, replay, round_tripped, text, unknown};
use garcon_contract::{
    error_codes::is_error_code, ticket_validation::ticket_string, tickets::TicketErrorCode,
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn typed<T: DeserializeOwned>(
    function: &str,
    value: Option<&Value>,
) -> Result<Option<T>, CaseError> {
    round_tripped(function, value)?
        .map(|value| serde_json::from_value(value.into_owned()))
        .transpose()
        .map_err(|_| CaseError::unhandled(function))
}

fn project(error: &TicketDomainError) -> Value {
    let output = json!({
        "name": TicketDomainError::NAME,
        "message": error.to_string(),
        "code": garcon_contract::error_codes::ErrorCode::from(error.code).as_str(),
        "status": error.status,
        "retryable": error.retryable,
    });
    let Value::Object(mut output) = output else {
        unreachable!()
    };
    if let Some(ticket) = &error.current_ticket {
        output.insert("currentTicket".into(), json!(ticket));
    }
    if let Some(comment) = &error.current_comment {
        output.insert("currentComment".into(), json!(comment));
    }
    Value::Object(output)
}

#[test]
fn ticket_error_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/ticket-error"
        ),
        |function, args| match function {
            "ticketDomainErrorFixture" => {
                let raw_code = unknown(function, args.first())?;
                let code = is_error_code(&raw_code)
                    .and_then(|code| TicketErrorCode::try_from(code).ok())
                    .ok_or_else(|| CaseError::unhandled(function))?;
                let message =
                    text(function, args.get(1))?.ok_or_else(|| CaseError::unhandled(function))?;
                let error = TicketDomainError::new(
                    code,
                    message,
                    typed(function, args.get(2))?,
                    typed(function, args.get(3))?,
                );
                Ok(project(&error))
            }
            "validateTicketInputFixture" => {
                let value = unknown(function, args.first())?;
                let plain = args.get(1).and_then(Value::as_bool).unwrap_or(false);
                match validate_ticket_input(|| {
                    if plain {
                        return Err(std::io::Error::other("synthetic non-ticket error").into());
                    }
                    ticket_string(&value, "directory").map_err(Box::<dyn std::error::Error>::from)
                }) {
                    Ok(value) => Ok(json!(value)),
                    Err(error) => match error.downcast::<TicketDomainError>() {
                        Ok(error) => Ok(project(&error)),
                        Err(error) => Err(CaseError::new("Error", error.to_string())),
                    },
                }
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn ticket_domain_errors_keep_their_status_and_code_at_the_http_boundary() {
    let error = validate_ticket_input(|| ticket_string(&Value::Null, "directory")).unwrap_err();
    assert!(is_domain_error(error.as_ref()));
    let response =
        json_error_from_unknown(ErrorInput::Error(error.as_ref()), None, None, None).unwrap();
    assert_eq!(response.status(), 400);
    assert_eq!(
        garcon_js::json::from_slice::<Value>(response.body()).unwrap(),
        json!({
            "success": false,
            "error": "directory must be well-formed Unicode text.",
            "errorCode": "TICKET_VALIDATION_FAILED",
            "retryable": false,
        }),
    );
}
