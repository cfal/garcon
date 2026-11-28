//! Ports `common/ticket-query.ts`.

use garcon_js::json::{self, Opaque};
use serde::Serialize;
use serde_json::{Value, json};
use url::form_urlencoded;

use crate::{json::JsonObject, ticket_validation::*, tickets::*};

const LIST_KEYS: &[&str] = &[
    "project",
    "status",
    "includeClosed",
    "priority",
    "label",
    "assignee",
    "ready",
    "query",
    "beforeNumber",
    "expectedCollectionRevision",
    "limit",
];

fn optional_integer(
    raw: &JsonObject,
    key: &str,
    minimum: Option<f64>,
    maximum: Option<f64>,
) -> Result<Option<u64>, TicketValidationError> {
    raw.get(key)
        .map(|v| ticket_integer(v, key, minimum, maximum).map(|n| n as u64))
        .transpose()
}

fn page_limit(raw: &JsonObject, key: &str, min: f64) -> Result<Option<u64>, TicketValidationError> {
    Ok(Some(
        optional_integer(raw, key, Some(min), Some(TICKET_LIMITS.page as f64))?
            .unwrap_or(TICKET_LIMITS.default_page as u64),
    ))
}

fn require_comment_revision(
    cursor: Option<u64>,
    revision: Option<u64>,
) -> Result<(), TicketValidationError> {
    if cursor.is_some() && revision.is_none() {
        return ticket_invalid("Continuation requires expectedCollectionRevision.");
    }
    Ok(())
}

pub fn parse_ticket_list_query(value: &Value) -> Result<TicketListQuery, TicketValidationError> {
    let raw = ticket_record(value, LIST_KEYS)?;
    let before_number = optional_integer(raw, "beforeNumber", None, None)?;
    let expected_collection_revision =
        optional_integer(raw, "expectedCollectionRevision", Some(0.0), None)?;
    require_comment_revision(before_number, expected_collection_revision)?;
    let assignee = raw
        .get("assignee")
        .map(|v| {
            if v == "unassigned" {
                Ok(TicketAssignee::Unassigned(TicketUnassigned::Unassigned))
            } else {
                ticket_owner(v).map(TicketAssignee::Owner)
            }
        })
        .transpose()?;
    Ok(TicketListQuery {
        project: raw
            .get("project")
            .map(|v| ticket_project(v).map(str::to_owned))
            .transpose()?,
        status: raw.get("status").map(ticket_status).transpose()?,
        include_closed: raw.get("includeClosed").map(ticket_boolean).transpose()?,
        priority: raw.get("priority").map(ticket_priority).transpose()?,
        label: raw
            .get("label")
            .map(|v| {
                ticket_line(v, "label", TICKET_LIMITS.label_code_points as f64).map(str::to_owned)
            })
            .transpose()?,
        assignee,
        ready: raw.get("ready").map(ticket_boolean).transpose()?,
        query: raw
            .get("query")
            .map(|v| ticket_line(v, "query", 256.0).map(str::to_owned))
            .transpose()?,
        before_number,
        expected_collection_revision,
        limit: page_limit(raw, "limit", 1.0)?,
    })
}

pub fn parse_ticket_read_query(value: &Value) -> Result<TicketReadQuery, TicketValidationError> {
    let raw = ticket_record(
        value,
        &[
            "ticketId",
            "includeDescription",
            "commentLimit",
            "beforeCommentSequence",
            "expectedCollectionRevision",
        ],
    )?;
    let before_comment_sequence = optional_integer(raw, "beforeCommentSequence", None, None)?;
    let expected_collection_revision =
        optional_integer(raw, "expectedCollectionRevision", Some(0.0), None)?;
    let comment_limit = page_limit(raw, "commentLimit", 0.0)?;
    require_comment_revision(before_comment_sequence, expected_collection_revision)?;
    if before_comment_sequence.is_some() && comment_limit == Some(0) {
        return ticket_invalid("Comment continuation requires a positive limit.");
    }
    Ok(TicketReadQuery {
        ticket_id: ticket_id(&value["ticketId"])?.into(),
        include_description: Some(
            raw.get("includeDescription")
                .map(ticket_boolean)
                .transpose()?
                .unwrap_or(true),
        ),
        comment_limit,
        before_comment_sequence,
        expected_collection_revision,
    })
}

pub fn parse_ticket_comments_query(
    value: &Value,
) -> Result<TicketCommentsQuery, TicketValidationError> {
    let raw = ticket_record(
        value,
        &[
            "ticketId",
            "limit",
            "beforeSequence",
            "expectedCollectionRevision",
        ],
    )?;
    let before_sequence = optional_integer(raw, "beforeSequence", None, None)?;
    let expected_collection_revision =
        optional_integer(raw, "expectedCollectionRevision", Some(0.0), None)?;
    require_comment_revision(before_sequence, expected_collection_revision)?;
    Ok(TicketCommentsQuery {
        ticket_id: ticket_id(&value["ticketId"])?.into(),
        limit: page_limit(raw, "limit", 1.0)?,
        before_sequence,
        expected_collection_revision,
    })
}

pub fn parse_ticket_history_query(
    value: &Value,
) -> Result<TicketHistoryQuery, TicketValidationError> {
    let raw = ticket_record(value, &["ticketId", "limit", "beforeSequence"])?;
    let before_sequence = optional_integer(raw, "beforeSequence", None, None)?;
    Ok(TicketHistoryQuery {
        ticket_id: ticket_id(&value["ticketId"])?.into(),
        limit: page_limit(raw, "limit", 1.0)?,
        before_sequence,
    })
}

pub fn ticket_query_params(params: &str) -> Result<Opaque, TicketValidationError> {
    let mut raw = JsonObject::new();
    for (key, text) in form_urlencoded::parse(params.strip_prefix('?').unwrap_or(params).as_bytes())
    {
        if raw.contains_key(key.as_ref()) {
            return ticket_invalid("Duplicate query parameter.");
        }
        let value = match key.as_ref() {
            "limit"
            | "priority"
            | "beforeNumber"
            | "expectedCollectionRevision"
            | "commentLimit"
            | "beforeCommentSequence"
            | "beforeSequence" => {
                if text != "0"
                    && (text.is_empty()
                        || text.starts_with('0')
                        || !text.bytes().all(|b| b.is_ascii_digit()))
                {
                    return ticket_invalid("Invalid numeric query parameter.");
                }
                // A decimal too large for a JavaScript number becomes null at the JSON boundary.
                json!(text.parse::<f64>().unwrap_or(f64::INFINITY))
            }
            "includeClosed" | "ready" | "includeDescription" => match text.as_ref() {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => return ticket_invalid("Invalid boolean query parameter."),
            },
            "assignee" => json!(parse_ticket_assignee_query(&text)?),
            _ => Value::String(text.into_owned()),
        };
        raw.insert(key.into_owned(), value);
    }
    Ok(Value::Object(raw).into())
}

/// Encodes a typed ticket query in its serialized field order.
pub fn ticket_search_params(query: &impl Serialize) -> Result<String, serde_json::Error> {
    let query = serde_json::to_value(query)?;
    let mut params = form_urlencoded::Serializer::new(String::new());
    if let Some(raw) = query.as_object() {
        for (key, value) in raw {
            if key == "assignee" && value.is_object() {
                let owner: TicketOwner = serde_json::from_value(value.clone())?;
                params.append_pair(key, &ticket_owner_key(&owner));
            } else if let Some(text) = value.as_str() {
                params.append_pair(key, text);
            } else {
                params.append_pair(key, &json::stringify(value));
            }
        }
    }
    Ok(params.finish())
}
