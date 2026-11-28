//! Ports `server/controller/tickets/http.ts`.

use std::error::Error;

use bytes::Bytes;
use garcon_base::{
    domain_error::as_domain_error,
    http_body::fetch_header_value,
    log::{Logger, create_logger},
    ticket_error::TicketDomainError,
};
use garcon_contract::{
    error_codes::ErrorCode,
    tickets::{TICKET_LIMITS, Ticket, TicketComment},
};
use garcon_js::{json, trim};
use garcon_stores::tickets::errors::{MissingChatAuthority, ticket_error};
use http::{
    HeaderValue, StatusCode,
    header::{CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE},
};
use http_body_util::BodyExt;
use hyper::body::Body;
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    http_route::response,
    http_route_types::{HttpRouteContext, RouteResult, ServerPrincipal, UnportedRequest},
    listener::HttpRequest,
};

pub(super) fn require_ticket_principal(
    context: &HttpRouteContext,
) -> Result<&ServerPrincipal, Box<dyn Error>> {
    context
        .principal
        .as_ref()
        .ok_or_else(|| ticket_error(ErrorCode::TICKET_UNAUTHORIZED, "Sign in to use Tickets."))
}

pub(super) fn ticket_json(value: &impl Serialize, status: StatusCode) -> RouteResult {
    let body = serde_json::to_vec(value)?;
    if body.len() > TICKET_LIMITS.http_bytes {
        return Err(ticket_error(
            ErrorCode::TICKET_RESULT_TOO_LARGE,
            "Ticket response exceeds the transport limit. Request less content.",
        ));
    }
    let mut reply = response(status, Some(Bytes::from(body)));
    reply
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    reply
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(reply)
}

pub(super) fn ticket_error_response(error: &(dyn Error + 'static)) -> RouteResult {
    // An unavailable owner is distinct from a database fault or a missing chat.
    if error.is::<MissingChatAuthority>() {
        return Err(Box::new(UnportedRequest));
    }
    if let Some(domain) = as_domain_error(error) {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct TicketError<'a> {
            success: bool,
            error: &'a str,
            error_code: &'static str,
            retryable: bool,
            #[serde(skip_serializing_if = "Option::is_none")]
            current_ticket: Option<&'a Ticket>,
            #[serde(skip_serializing_if = "Option::is_none")]
            current_comment: Option<&'a TicketComment>,
        }
        let conflict = error.downcast_ref::<TicketDomainError>();
        return ticket_json(
            &TicketError {
                success: false,
                error: &domain.message,
                error_code: domain.code.as_str(),
                retryable: domain.retryable,
                current_ticket: conflict.and_then(|error| error.current_ticket.as_ref()),
                current_comment: conflict.and_then(|error| error.current_comment.as_ref()),
            },
            StatusCode::from_u16(domain.status)?,
        );
    }
    create_logger("tickets").warn("Unexpected ticket request failure.");
    ticket_json(
        &json!({"success":false,"error":"Ticket request could not be completed.",
        "errorCode":"TICKET_INTERNAL_ERROR","retryable":false}),
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn too_large() -> Box<dyn Error> {
    ticket_error(
        ErrorCode::TICKET_REQUEST_TOO_LARGE,
        "Encoded ticket request exceeds 64 KiB. Reduce the submitted body.",
    )
}

fn invalid_json() -> Box<dyn Error> {
    ticket_error(
        ErrorCode::TICKET_VALIDATION_FAILED,
        "A valid UTF-8 JSON body is required.",
    )
}

pub(super) async fn read_ticket_body(request: &mut HttpRequest) -> Result<Value, Box<dyn Error>> {
    if fetch_header_value(request.headers(), &CONTENT_LENGTH)
        .and_then(|length| trim(&length).parse::<f64>().ok())
        .is_some_and(|length| length > TICKET_LIMITS.request_bytes as f64)
    {
        return Err(too_large());
    }
    if request.body().is_end_stream() {
        return Err(ticket_error(
            ErrorCode::TICKET_VALIDATION_FAILED,
            "A JSON body is required.",
        ));
    }
    let mut bytes = Vec::new();
    loop {
        if request.body().cancellation().is_cancelled() {
            return Err("The operation was aborted.".into());
        }
        let Some(frame) = request.body_mut().frame().await else {
            break;
        };
        let frame = frame.map_err(|error| -> Box<dyn Error> { error })?;
        if let Ok(chunk) = frame.into_data() {
            if bytes.len() + chunk.len() > TICKET_LIMITS.request_bytes {
                return Err(too_large());
            }
            bytes.extend_from_slice(&chunk);
        }
    }
    parse_ticket_body(&bytes)
}

fn parse_ticket_body(bytes: &[u8]) -> Result<Value, Box<dyn Error>> {
    let text = std::str::from_utf8(bytes).map_err(|_| invalid_json())?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    // The mutation validator rejects an ill-formed string like a non-string.
    json::parse_replacing_unpaired_surrogate_values(text, false).map_err(|_| invalid_json())
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_contract::ticket_commands::parse_ticket_mutation_payload;

    #[test]
    fn rejects_unpaired_surrogates_at_the_original_ticket_field() {
        let original_field_order = br#"{"action":"create","input":{"title":"bad \ud800","description":"bad \udfff","project":"fixture"}}"#;
        let value = parse_ticket_body(original_field_order).unwrap();
        let error = parse_ticket_mutation_payload(&value).unwrap_err();
        assert_eq!(error.to_string(), "title must be well-formed Unicode text.");
        for valid in [
            br#""\ufffd""#.as_slice(),
            br#""\ud83d\ude03""#,
            br#""\\ud800""#,
        ] {
            assert!(parse_ticket_body(valid).unwrap().is_string());
        }
    }

    #[test]
    fn preserves_genuine_replacement_characters_and_the_final_duplicate() {
        let title = br#"{"action":"create","input":{"title":"bad \ud800","title":"real \ufffd","project":"fixture"}}"#;
        let body = parse_ticket_body(title).unwrap();
        assert!(parse_ticket_mutation_payload(&body).is_ok());
        assert_eq!(body["input"]["title"], "real \u{fffd}");
        let mixed = br#"{"action":"create","input":{"title":"real \ufffd","description":"bad \udfff","project":"fixture"}}"#;
        let body = parse_ticket_body(mixed).unwrap();
        let error = parse_ticket_mutation_payload(&body).unwrap_err();
        assert_eq!(error.to_string(), "body must be well-formed Unicode text.");
    }

    #[test]
    fn decodes_only_valid_utf8_and_removes_one_initial_bom() {
        let error = parse_ticket_body(b"\"\xed\xa0\x80\"").unwrap_err();
        assert_eq!(error.to_string(), "A valid UTF-8 JSON body is required.");
        assert_eq!(parse_ticket_body(b"\xef\xbb\xbf{}\n").unwrap(), json!({}));
    }
}
