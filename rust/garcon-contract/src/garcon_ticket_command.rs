//! Ports `common/garcon-ticket-command.ts`.

use garcon_js::json::from_str;
use serde::Serialize;
use serde_json::{Value, json};

use crate::garcon_command_envelope::{is_space, parse_garcon_command_envelope, positive_decimal};
use crate::ticket_commands::{
    MarkupTicketMutationPayload, TICKET_ACTIONS, TicketAction, TicketReadPayload,
    parse_markup_ticket_mutation_payload,
};
use crate::ticket_query::{
    parse_ticket_history_query, parse_ticket_list_query, parse_ticket_read_query,
};
use crate::ticket_validation::{ticket_id, ticket_integer, ticket_record, ticket_ref};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum TicketCommandType {
    Ticket,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GarconTicketMutationCommand {
    #[serde(rename = "type")]
    command_type: TicketCommandType,
    #[serde(rename = "ref")]
    pub reference: String,
    pub payload: MarkupTicketMutationPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GarconTicketReadCommand {
    #[serde(rename = "type")]
    command_type: TicketCommandType,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    pub payload: TicketReadPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum GarconTicketCommand {
    Mutation(GarconTicketMutationCommand),
    Read(GarconTicketReadCommand),
}

pub fn is_ticket_read_action(action: &Value) -> bool {
    matches!(action.as_str(), Some("list" | "read" | "history"))
}

pub fn is_ticket_read_command(command: &Value) -> bool {
    is_ticket_read_action(&command["payload"]["action"])
}

fn attributes(action: TicketAction) -> &'static [&'static str] {
    use TicketAction::*;
    match action {
        Create | List => &["ref"],
        Read | History | Comment => &["ref", "ticket-id"],
        CommentEdit | CommentDelete => &["ref", "ticket-id", "comment-id", "expected-revision"],
        _ => &["ref", "ticket-id", "expected-revision"],
    }
}

pub fn parse_garcon_ticket_command(content: &str) -> Option<GarconTicketCommand> {
    let suffix = content.strip_prefix("<garcon-ticket-")?;
    let action = TICKET_ACTIONS.iter().find_map(|name| {
        let next = suffix.strip_prefix(*name)?.chars().next()?;
        if is_space(next) || matches!(next, '/' | '>') {
            TicketAction::from_wire(name)
        } else {
            None
        }
    })?;
    let name = format!("garcon-ticket-{}", action.as_str());
    let envelope = parse_garcon_command_envelope(content, &name, attributes(action))?;
    let attr = |name| envelope.attributes.get(name).map(String::as_str);
    let reference = if let Some(reference) = attr("ref") {
        Some(ticket_ref(&json!(reference)).ok()?.to_owned())
    } else {
        None
    };
    use TicketAction::*;
    let target = if matches!(action, Create | List) {
        None
    } else {
        Some(ticket_id(&json!(attr("ticket-id"))).ok()?.to_owned())
    };
    let body = &envelope.body;
    let body_json = || {
        if body.is_empty() {
            Some(json!({}))
        } else {
            from_str::<Value>(body).ok()
        }
    };
    if matches!(action, List | Read | History) {
        let payload = match action {
            List => TicketReadPayload::List {
                query: parse_ticket_list_query(&body_json()?).ok()?,
            },
            Read => {
                let mut value = body_json()?;
                ticket_record(
                    &value,
                    &[
                        "includeDescription",
                        "commentLimit",
                        "beforeCommentSequence",
                        "expectedCollectionRevision",
                    ],
                )
                .ok()?;
                value["ticketId"] = json!(target);
                TicketReadPayload::Read {
                    query: parse_ticket_read_query(&value).ok()?,
                }
            }
            History => {
                let mut value = body_json()?;
                ticket_record(&value, &["limit", "beforeSequence"]).ok()?;
                value["ticketId"] = json!(target);
                TicketReadPayload::History {
                    query: parse_ticket_history_query(&value).ok()?,
                }
            }
            _ => unreachable!("not a read action"),
        };
        return Some(GarconTicketCommand::Read(GarconTicketReadCommand {
            command_type: TicketCommandType::Ticket,
            reference,
            payload,
        }));
    }
    let reference = reference?;
    let self_closing_only = matches!(action, Claim | Release | Reopen | CommentDelete);
    if self_closing_only && !envelope.self_closing
        || !self_closing_only && action != Close && (envelope.self_closing || body.is_empty())
    {
        return None;
    }
    let raw = match action {
        Create => json!({"action":action,"input":body_json()?}),
        Comment => json!({"action":action,"ticketId":target,"body":body}),
        _ => {
            let revision = positive_decimal(attr("expected-revision")?)?;
            let revision = ticket_integer(&json!(revision), "expectedRevision", None, None).ok()?;
            let mut raw = json!({"action":action,"ticketId":target,"expectedRevision":revision});
            match action {
                Update => raw["patch"] = body_json()?,
                Link | Unlink | Close => {
                    let data = body_json()?;
                    let keys: &[&str] = if action == Close {
                        &["resolution", "comment"]
                    } else {
                        &["targetId", "targetRevision", "kind"]
                    };
                    let data = ticket_record(&data, keys).ok()?;
                    raw.as_object_mut()?.extend(data.clone());
                }
                CommentEdit | CommentDelete => {
                    raw["commentId"] = json!(attr("comment-id"));
                    if action == CommentEdit {
                        raw["body"] = json!(body);
                    }
                }
                _ => {}
            }
            raw
        }
    };
    let payload = parse_markup_ticket_mutation_payload(&raw).ok()?;
    Some(GarconTicketCommand::Mutation(GarconTicketMutationCommand {
        command_type: TicketCommandType::Ticket,
        reference,
        payload,
    }))
}
