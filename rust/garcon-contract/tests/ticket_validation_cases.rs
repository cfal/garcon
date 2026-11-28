use garcon_cases::{CaseError, javascript_number, markers, replay, text, unknown};
use garcon_contract::ticket_validation::*;
use serde::Serialize;
use serde_json::Value;

fn encoded(value: impl Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}

fn error_case(error: TicketValidationError) -> CaseError {
    CaseError::new("TicketValidationError", error.to_string())
}

fn required_text<'a>(function: &str, arg: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, arg)?.ok_or_else(|| CaseError::unhandled(function))
}

fn number(function: &str, arg: Option<&Value>) -> Result<Option<f64>, CaseError> {
    arg.filter(|arg| !markers::is_undefined(arg))
        .map(|arg| javascript_number(function, Some(arg)))
        .transpose()
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let first = args.first();
    let arg1 = || required_text(function, args.get(1));
    let result = match function {
        "new TicketValidationError" => {
            return Err(error_case(TicketValidationError::new(required_text(
                function, first,
            )?)));
        }
        "ticketInvalid" => ticket_invalid::<Value>(required_text(function, first)?),
        "ticketBytes" => Ok(serde_json::json!(ticket_bytes(required_text(
            function, first
        )?))),
        "formatTicketId" => format_ticket_id(javascript_number(function, first)?).map(encoded),
        "ticketNumber" => ticket_number(required_text(function, first)?).map(encoded),
        "parseTicketAssigneeQuery" => {
            parse_ticket_assignee_query(required_text(function, first)?).map(encoded)
        }
        "ticketString" if first.is_some_and(|arg| markers::kind(arg) == Some("utf16")) => {
            let units: Vec<u16> = serde_json::from_value(args[0]["value"].clone())
                .map_err(|_| CaseError::unhandled(function))?;
            ticket_string_utf16(&units, arg1()?).map(encoded)
        }
        _ => {
            let value = unknown(function, first)?;
            match function {
                "ticketRecord" => {
                    let names = unknown(function, args.get(1))?;
                    let keys = names
                        .as_array()
                        .ok_or_else(|| CaseError::unhandled(function))?
                        .iter()
                        .map(|name| required_text(function, Some(name)))
                        .collect::<Result<Vec<_>, _>>()?;
                    ticket_record(&value, &keys).map(|record| {
                        garcon_js::json::Opaque::from_value(Value::Object(record.clone()))
                            .into_value()
                    })
                }
                "ticketString" => ticket_string(&value, arg1()?).map(encoded),
                "ticketLine" => {
                    ticket_line(&value, arg1()?, javascript_number(function, args.get(2))?)
                        .map(encoded)
                }
                "ticketTitle" => ticket_title(&value).map(encoded),
                "ticketProject" => ticket_project(&value).map(encoded),
                "ticketRef" => ticket_ref(&value).map(encoded),
                "ticketBody" => ticket_body(&value).map(encoded),
                "ticketCommentBody" => ticket_comment_body(&value).map(encoded),
                "ticketInteger" => ticket_integer(
                    &value,
                    arg1()?,
                    number(function, args.get(2))?,
                    number(function, args.get(3))?,
                )
                .map(encoded),
                "ticketUuid" => ticket_uuid(&value, arg1()?).map(encoded),
                "ticketId" => ticket_id(&value).map(encoded),
                "storedTicketId" => stored_ticket_id(&value).map(encoded),
                "ticketChatId" => ticket_chat_id(&value).map(encoded),
                "ticketStatus" => ticket_status(&value).map(encoded),
                "ticketResolution" => ticket_resolution(&value).map(encoded),
                "ticketPriority" => ticket_priority(&value).map(encoded),
                "ticketLabels" => ticket_labels(&value).map(encoded),
                "ticketOwner" => ticket_owner(&value).map(encoded),
                "ticketActor" => ticket_actor(&value).map(encoded),
                "ticketSource" => ticket_source(&value).map(encoded),
                "ticketTimestamp" => ticket_timestamp(&value).map(encoded),
                "ticketBoolean" => ticket_boolean(&value).map(encoded),
                "ticketLinkKind" => ticket_link_kind(&value).map(encoded),
                _ => return Err(CaseError::unhandled(function)),
            }
        }
    };
    result.map_err(error_case)
}

#[test]
fn ticket_validation_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/ticket-validation"
        ),
        dispatch,
    );
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}
