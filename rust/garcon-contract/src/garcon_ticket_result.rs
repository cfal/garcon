//! Ports `common/garcon-ticket-result.ts`.

use garcon_js::{
    json::{self, Opaque, from_str},
    trim,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{Value, json};

use crate::error_codes::{ErrorCode, is_error_code};
use crate::garcon_agent_result::wire_attribute;
use crate::garcon_command_envelope::{
    escape_garcon_xml_text, parse_garcon_command_envelope, positive_decimal,
};
use crate::garcon_command_results::AgentCommandCorrelation;
use crate::garcon_ticket_command::is_ticket_read_action;
use crate::ticket_commands::{TICKET_ACTIONS, TicketAction};
use crate::ticket_query::parse_ticket_list_query;
use crate::ticket_responses::{parse_ticket_detail, parse_ticket_history_page, parse_ticket_page};
use crate::ticket_stored::{normalize_stored_ticket_outcome, normalize_stored_ticket_result};
use crate::ticket_validation::*;
use crate::tickets::*;

const FILTER_KEYS: &[&str] = &[
    "project",
    "status",
    "includeClosed",
    "priority",
    "label",
    "assignee",
    "ready",
    "query",
];

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketNoticeContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filters: Option<TicketListQuery>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<TicketNoticeLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketNoticeLink {
    pub kind: TicketLinkKind,
    pub target_id: String,
}

fn parse_notice_context(
    command: TicketAction,
    value: &Value,
) -> Result<TicketNoticeContext, TicketValidationError> {
    let keys: &[&str] = match command {
        TicketAction::List => &["filters"],
        TicketAction::Link | TicketAction::Unlink => &["link"],
        _ => &[],
    };
    let raw = ticket_record(value, keys)?;
    if let Some(filters) = raw.get("filters") {
        ticket_record(filters, FILTER_KEYS)?;
        let mut filters = parse_ticket_list_query(filters)?;
        filters.limit = None;
        return Ok(TicketNoticeContext {
            filters: Some(filters),
            link: None,
        });
    }
    if let Some(link) = raw.get("link") {
        ticket_record(link, &["kind", "targetId"])?;
        return Ok(TicketNoticeContext {
            filters: None,
            link: Some(TicketNoticeLink {
                kind: ticket_link_kind(&link["kind"])?,
                target_id: stored_ticket_id(&link["targetId"])?,
            }),
        });
    }
    Ok(TicketNoticeContext::default())
}

pub fn ticket_command_context(command: &Value) -> Result<Option<Opaque>, TicketValidationError> {
    let payload = &command["payload"];
    match payload["action"].as_str() {
        Some("list") => {
            let filters: serde_json::Map<_, _> = FILTER_KEYS
                .iter()
                .filter_map(|&key| {
                    payload["query"]
                        .get(key)
                        .map(|value| (key.to_owned(), value.clone()))
                })
                .collect();
            let context = parse_notice_context(TicketAction::List, &json!({"filters":filters}))?;
            Ok(Some(json!(context).into()))
        }
        Some("link" | "unlink") => {
            let data: serde_json::Map<_, _> = ["kind", "targetId"]
                .into_iter()
                .filter_map(|key| {
                    payload
                        .get(key)
                        .map(|value| (key.to_owned(), value.clone()))
                })
                .collect();
            Ok(Some(json!({"link":data}).into()))
        }
        _ => Ok(None),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TicketResultReference {
    pub id: String,
    pub revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketMutationReceipt {
    pub store_id: String,
    pub ticket_id: String,
    pub revision: u64,
    pub status: TicketStatus,
    pub collection_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<TicketResultReference>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_ticket: Option<TicketResultReference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketResultIdentity {
    pub command: TicketAction,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ticket_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<TicketNoticeContext>,
    #[serde(flatten)]
    pub correlation: AgentCommandCorrelation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum TicketResultData {
    List(TicketPage),
    Read(Box<TicketDetail>),
    History(TicketSequencePage<TicketActivity>),
    Mutation(TicketMutationReceipt),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum TicketResultStatus {
    Ok {
        data: TicketResultData,
    },
    Error {
        #[serde(serialize_with = "serialize_ticket_error_code")]
        error_code: TicketErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GarconTicketResult {
    #[serde(flatten)]
    pub identity: TicketResultIdentity,
    #[serde(flatten)]
    pub status: TicketResultStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum TicketCommandOutcomeStatus {
    Ok {
        #[serde(skip_serializing_if = "Option::is_none")]
        revision: Option<u64>,
    },
    Error {
        #[serde(
            serialize_with = "serialize_ticket_error_code",
            deserialize_with = "deserialize_ticket_error_code"
        )]
        error_code: TicketErrorCode,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum TicketOutcomeTag {
    TicketCommandOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TicketCommandOutcome {
    #[serde(rename = "type")]
    kind: TicketOutcomeTag,
    #[serde(flatten)]
    pub identity: TicketResultIdentity,
    #[serde(flatten)]
    pub status: TicketCommandOutcomeStatus,
}

fn serialize_ticket_error_code<S: Serializer>(
    value: &TicketErrorCode,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(ErrorCode::from(*value).as_str())
}

fn deserialize_ticket_error_code<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<TicketErrorCode, D::Error> {
    let value = Value::deserialize(deserializer)?;
    parse_ticket_error_code(&value).map_err(serde::de::Error::custom)
}

pub fn ticket_mutation_receipt(result: &TicketWriteResult) -> TicketMutationReceipt {
    TicketMutationReceipt {
        store_id: result.version.store_id.clone(),
        ticket_id: result.ticket.id.clone(),
        revision: result.ticket.revision,
        status: result.ticket.status,
        collection_revision: result.version.collection_revision,
        comment: result
            .comment
            .as_ref()
            .map(|comment| TicketResultReference {
                id: comment.id.clone(),
                revision: comment.revision,
            }),
        related_ticket: result
            .related_ticket
            .as_ref()
            .map(|ticket| TicketResultReference {
                id: ticket.id.clone(),
                revision: ticket.revision,
            }),
    }
}

fn revision(value: &Value) -> Result<u64, TicketValidationError> {
    ticket_integer(value, "revision", None, None).map(|value| value as u64)
}

fn parse_receipt(value: &Value) -> Result<TicketMutationReceipt, TicketValidationError> {
    let raw = ticket_record(
        value,
        &[
            "storeId",
            "ticketId",
            "revision",
            "status",
            "collectionRevision",
            "comment",
            "relatedTicket",
        ],
    )?;
    let reference = |value: &Value, comment: bool| -> Result<_, TicketValidationError> {
        ticket_record(value, &["id", "revision"])?;
        Ok(TicketResultReference {
            id: if comment {
                ticket_uuid(&value["id"], "commentId")?.to_owned()
            } else {
                stored_ticket_id(&value["id"])?
            },
            revision: revision(&value["revision"])?,
        })
    };
    Ok(TicketMutationReceipt {
        store_id: ticket_uuid(&value["storeId"], "storeId")?.into(),
        ticket_id: stored_ticket_id(&value["ticketId"])?,
        revision: revision(&value["revision"])?,
        status: ticket_status(&value["status"])?,
        collection_revision: ticket_integer(
            &value["collectionRevision"],
            "collectionRevision",
            Some(0.0),
            None,
        )? as u64,
        comment: raw.get("comment").map(|v| reference(v, true)).transpose()?,
        related_ticket: raw
            .get("relatedTicket")
            .map(|v| reference(v, false))
            .transpose()?,
    })
}

fn request_identity(value: &Value) -> Result<TicketResultIdentity, TicketValidationError> {
    let Some(command) = value["command"].as_str().and_then(TicketAction::from_wire) else {
        return ticket_invalid("Invalid ticket result command.");
    };
    let reference = if value.get("ref").is_none() && is_ticket_read_action(&value["command"]) {
        None
    } else {
        Some(ticket_ref(&value["ref"])?.to_owned())
    };
    if command == TicketAction::List && value.get("ticketId").is_some() {
        return ticket_invalid("List result cannot target a ticket.");
    }
    let ticket_id = if value.get("ticketId").is_none()
        && matches!(command, TicketAction::Create | TicketAction::List)
    {
        None
    } else {
        Some(stored_ticket_id(&value["ticketId"])?)
    };
    Ok(TicketResultIdentity {
        command,
        reference,
        ticket_id,
        context: value
            .get("context")
            .map(|v| parse_notice_context(command, v))
            .transpose()?,
        correlation: AgentCommandCorrelation {
            request_view_id: ticket_uuid(&value["requestViewId"], "requestViewId")?.into(),
            request_ordinal: ticket_integer(&value["requestOrdinal"], "requestOrdinal", None, None)?
                as u64,
        },
    })
}

pub fn parse_ticket_error_code(value: &Value) -> Result<TicketErrorCode, TicketValidationError> {
    is_error_code(value)
        .and_then(|code| code.try_into().ok())
        .ok_or_else(|| TicketValidationError::new("Invalid ticket error code."))
}

pub fn parse_ticket_command_result(
    value: &Value,
) -> Result<GarconTicketResult, TicketValidationError> {
    let raw = ticket_record(
        value,
        &[
            "command",
            "ref",
            "ticketId",
            "requestViewId",
            "requestOrdinal",
            "status",
            "data",
            "errorCode",
            "message",
            "context",
        ],
    )?;
    let identity = request_identity(value)?;
    if value["status"] == "error" {
        if raw.contains_key("data") {
            return ticket_invalid("A ticket error cannot contain result data.");
        }
        let Some(message) = value["message"]
            .as_str()
            .filter(|text| text.len() <= 2048 && !trim(text).is_empty())
        else {
            return ticket_invalid("Invalid ticket error message.");
        };
        return Ok(GarconTicketResult {
            identity,
            status: TicketResultStatus::Error {
                error_code: parse_ticket_error_code(&value["errorCode"])?,
                message: message.to_owned(),
            },
        });
    }
    if value["status"] != "ok" || raw.contains_key("errorCode") || raw.contains_key("message") {
        return ticket_invalid("Invalid ticket result status.");
    }
    let target = identity.ticket_id.as_deref();
    let data = match identity.command {
        TicketAction::List => TicketResultData::List(parse_ticket_page(&value["data"])?),
        TicketAction::Read => {
            let data = parse_ticket_detail(&value["data"])?;
            if Some(data.ticket.id.as_str()) != target {
                return ticket_invalid("Read result targets another ticket.");
            }
            TicketResultData::Read(Box::new(data))
        }
        TicketAction::History => {
            let data = parse_ticket_history_page(&value["data"])?;
            if data
                .items
                .iter()
                .any(|entry| Some(entry.base.ticket_id.as_str()) != target)
            {
                return ticket_invalid("History result targets another ticket.");
            }
            TicketResultData::History(data)
        }
        _ => {
            let data = parse_receipt(&value["data"])?;
            if Some(data.ticket_id.as_str()) != target {
                return ticket_invalid("Mutation result targets another ticket.");
            }
            TicketResultData::Mutation(data)
        }
    };
    Ok(GarconTicketResult {
        identity,
        status: TicketResultStatus::Ok { data },
    })
}

const ATTRIBUTES: &[(&str, &str)] = &[
    ("ref", "ref"),
    ("ticket-id", "ticketId"),
    ("request-view-id", "requestViewId"),
    ("request-ordinal", "requestOrdinal"),
    ("status", "status"),
];

pub fn garcon_ticket_result_content(result: &Value) -> String {
    let attributes: Vec<_> = ATTRIBUTES
        .iter()
        .filter_map(|&(name, key)| result.get(key).map(|value| wire_attribute(name, value)))
        .collect();
    let mut body = serde_json::Map::new();
    let fields: &[&str] = if result["status"] == "ok" {
        &["data", "context"]
    } else {
        &["errorCode", "message", "context"]
    };
    for &field in fields {
        if let Some(value) = result.get(field) {
            body.insert(field.into(), value.clone());
        }
    }
    let command = result["command"].as_str().unwrap_or("undefined");
    let name = format!("garcon-ticket-{command}-result");
    let body = escape_garcon_xml_text(&json::stringify(&Value::Object(body)));
    format!("<{name} {}>\n{body}\n</{name}>", attributes.join(" "))
}

pub fn parse_garcon_ticket_result(content: &str) -> Option<GarconTicketResult> {
    let value = trim(content);
    if value.len() > TICKET_LIMITS.markup_bytes {
        return None;
    }
    let allowed: Vec<_> = ATTRIBUTES.iter().map(|&(name, _)| name).collect();
    for &command in TICKET_ACTIONS {
        let name = format!("garcon-ticket-{command}-result");
        let Some(envelope) = parse_garcon_command_envelope(value, &name, &allowed)
            .filter(|frame| !frame.self_closing)
        else {
            continue;
        };
        let mut raw = json!({"command":command});
        for &(name, key) in ATTRIBUTES {
            if let Some(value) = envelope.attributes.get(name) {
                raw[key] = json!(value);
            }
        }
        let ordinal = positive_decimal(raw["requestOrdinal"].as_str()?)?;
        raw["requestOrdinal"] = json!(ordinal);
        let body = from_str::<Value>(&envelope.body).ok()?;
        let keys: &[&str] = if raw["status"] == "error" {
            &["errorCode", "message", "context"]
        } else {
            &["data", "context"]
        };
        raw.as_object_mut()?
            .extend(ticket_record(&body, keys).ok()?.clone());
        let normalized = normalize_stored_ticket_result(&raw).ok()?;
        return parse_ticket_command_result(&normalized).ok();
    }
    None
}

pub fn ticket_command_outcome(result: &Value) -> Opaque {
    let mut outcome = json!({"type":"ticket-command-outcome"});
    for key in [
        "requestViewId",
        "requestOrdinal",
        "command",
        "context",
        "ref",
        "ticketId",
    ] {
        if let Some(value) = result.get(key) {
            outcome[key] = value.clone();
        }
    }
    if result["status"] == "error" {
        outcome["status"] = json!("error");
        if let Some(code) = result.get("errorCode") {
            outcome["errorCode"] = code.clone();
        }
    } else {
        outcome["status"] = json!("ok");
        let data = &result["data"];
        let revision = if result["command"] == "read" {
            data["ticket"].get("revision")
        } else {
            data.get("revision")
        };
        if let Some(revision) = revision {
            outcome["revision"] = revision.clone();
        }
    }
    outcome.into()
}

pub fn parse_ticket_command_outcome(value: &Value) -> Option<TicketCommandOutcome> {
    let raw = ticket_record(
        value,
        &[
            "type",
            "command",
            "ref",
            "ticketId",
            "requestViewId",
            "requestOrdinal",
            "status",
            "revision",
            "errorCode",
            "context",
        ],
    )
    .ok()?;
    if value["type"] != "ticket-command-outcome" {
        return None;
    }
    let identity = request_identity(value).ok()?;
    let status = if value["status"] == "error" && !raw.contains_key("revision") {
        TicketCommandOutcomeStatus::Error {
            error_code: parse_ticket_error_code(&value["errorCode"]).ok()?,
        }
    } else {
        if value["status"] != "ok" || raw.contains_key("errorCode") {
            return None;
        }
        let revision = if matches!(identity.command, TicketAction::List | TicketAction::History) {
            if raw.contains_key("revision") {
                return None;
            }
            None
        } else {
            identity.ticket_id.as_ref()?;
            Some(revision(&value["revision"]).ok()?)
        };
        TicketCommandOutcomeStatus::Ok { revision }
    };
    Some(TicketCommandOutcome {
        kind: TicketOutcomeTag::TicketCommandOutcome,
        identity,
        status,
    })
}

pub fn parse_stored_ticket_command_outcome(value: &Value) -> Option<TicketCommandOutcome> {
    parse_ticket_command_outcome(normalize_stored_ticket_outcome(value).ok()?.as_value())
}
