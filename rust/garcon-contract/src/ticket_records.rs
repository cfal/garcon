//! Ports `common/ticket-records.ts`.

use serde_json::Value;

use crate::{ticket_validation::*, tickets::*};

const TICKET_KEYS: &[&str] = &[
    "id",
    "number",
    "revision",
    "title",
    "description",
    "project",
    "status",
    "resolution",
    "priority",
    "labels",
    "assignee",
    "parentId",
    "createdAt",
    "updatedAt",
    "createdBy",
];
const COMMENT_KEYS: &[&str] = &[
    "id",
    "ticketId",
    "sequence",
    "revision",
    "body",
    "author",
    "createdAt",
    "updatedAt",
    "deletedAt",
];

pub const TICKET_FIELDS: &[TicketField] = &[
    TicketField::Title,
    TicketField::Description,
    TicketField::Project,
    TicketField::Status,
    TicketField::Resolution,
    TicketField::Priority,
    TicketField::Labels,
    TicketField::Assignee,
    TicketField::ParentId,
];

fn nullable<T>(
    value: &Value,
    key: &str,
    parse: impl FnOnce(&Value) -> Result<T, TicketValidationError>,
) -> Result<Option<T>, TicketValidationError> {
    if value.get(key) == Some(&Value::Null) {
        Ok(None)
    } else {
        parse(&value[key]).map(Some)
    }
}

pub fn parse_ticket(value: &Value) -> Result<Ticket, TicketValidationError> {
    ticket_record(value, TICKET_KEYS)?;
    let id = stored_ticket_id(&value["id"])?;
    let number = ticket_integer(&value["number"], "number", None, None)?;
    if id != format_ticket_id(number as f64)? {
        return ticket_invalid("Ticket ID and number disagree.");
    }
    let status = ticket_status(&value["status"])?;
    let resolution = nullable(value, "resolution", ticket_resolution)?;
    if (status == TicketStatus::Closed) != resolution.is_some() {
        return ticket_invalid("Ticket status and resolution disagree.");
    }
    Ok(Ticket {
        id,
        number: number as u64,
        revision: ticket_integer(&value["revision"], "revision", None, None)? as u64,
        title: ticket_title(&value["title"])?.into(),
        description: ticket_body(&value["description"])?.into(),
        project: ticket_project(&value["project"])?.into(),
        status,
        resolution,
        priority: ticket_priority(&value["priority"])?,
        labels: ticket_labels(&value["labels"])?,
        assignee: nullable(value, "assignee", ticket_owner)?,
        parent_id: nullable(value, "parentId", stored_ticket_id)?,
        created_at: ticket_timestamp(&value["createdAt"])?.into(),
        updated_at: ticket_timestamp(&value["updatedAt"])?.into(),
        created_by: ticket_actor(&value["createdBy"])?,
    })
}

pub fn parse_ticket_comment(value: &Value) -> Result<TicketComment, TicketValidationError> {
    ticket_record(value, COMMENT_KEYS)?;
    let deleted_at = nullable(value, "deletedAt", |v| {
        ticket_timestamp(v).map(str::to_owned)
    })?;
    let body = nullable(value, "body", |v| ticket_comment_body(v).map(str::to_owned))?;
    if deleted_at.is_some() == body.is_some() {
        return ticket_invalid("Comment body and tombstone disagree.");
    }
    Ok(TicketComment {
        id: ticket_uuid(&value["id"], "commentId")?.into(),
        ticket_id: stored_ticket_id(&value["ticketId"])?,
        sequence: ticket_integer(&value["sequence"], "sequence", None, None)? as u64,
        revision: ticket_integer(&value["revision"], "revision", None, None)? as u64,
        body,
        deleted_at,
        author: ticket_actor(&value["author"])?,
        created_at: ticket_timestamp(&value["createdAt"])?.into(),
        updated_at: ticket_timestamp(&value["updatedAt"])?.into(),
    })
}

fn parse_change(value: &Value) -> Result<TicketFieldChange, TicketValidationError> {
    ticket_record(value, &["field", "before", "after"])?;
    macro_rules! change {
        ($variant:ident, $parse:expr) => {
            TicketFieldChange::$variant {
                before: $parse("before")?,
                after: $parse("after")?,
            }
        };
    }
    Ok(match value["field"].as_str() {
        Some("title") => change!(Title, |k| ticket_title(&value[k]).map(str::to_owned)),
        Some("description") => change!(Description, |k| ticket_body(&value[k]).map(str::to_owned)),
        Some("project") => change!(Project, |k| ticket_project(&value[k]).map(str::to_owned)),
        Some("status") => change!(Status, |k| ticket_status(&value[k])),
        Some("resolution") => change!(Resolution, |k| nullable(value, k, ticket_resolution)),
        Some("priority") => change!(Priority, |k| ticket_priority(&value[k])),
        Some("labels") => change!(Labels, |k| ticket_labels(&value[k])),
        Some("assignee") => change!(Assignee, |k| nullable(value, k, ticket_owner)),
        Some("parentId") => change!(ParentId, |k| nullable(value, k, stored_ticket_id)),
        _ => return ticket_invalid("Invalid activity field."),
    })
}

pub fn parse_ticket_activity(value: &Value) -> Result<TicketActivity, TicketValidationError> {
    const BASE: &[&str] = &["sequence", "ticketId", "at", "actor", "source", "action"];
    let check_keys = |extra: &[&str]| ticket_record(value, &[BASE, extra].concat());
    check_keys(&[
        "ticket",
        "changes",
        "commentId",
        "before",
        "after",
        "kind",
        "sourceId",
        "targetId",
    ])?;
    let base = TicketActivityBase {
        sequence: ticket_integer(&value["sequence"], "sequence", None, None)? as u64,
        ticket_id: stored_ticket_id(&value["ticketId"])?,
        at: ticket_timestamp(&value["at"])?.into(),
        actor: ticket_actor(&value["actor"])?,
        source: nullable(value, "source", ticket_source)?,
    };
    let action = value["action"].as_str();
    use TicketActivityAction::*;
    let action = match action {
        Some("created") => {
            check_keys(&["ticket"])?;
            let ticket = parse_ticket(&value["ticket"])?;
            if ticket.id != base.ticket_id {
                return ticket_invalid("Activity ticket disagrees.");
            }
            Created {
                ticket: Box::new(ticket),
            }
        }
        Some("updated" | "claimed" | "released" | "closed" | "reopened") => {
            check_keys(&["changes"])?;
            let Some(items) = value["changes"]
                .as_array()
                .filter(|a| a.len() <= TICKET_FIELDS.len())
            else {
                return ticket_invalid("Invalid activity changes.");
            };
            let changes = TicketChanges {
                changes: items.iter().map(parse_change).collect::<Result<_, _>>()?,
            };
            match action {
                Some("updated") => Updated(changes),
                Some("claimed") => Claimed(changes),
                Some("released") => Released(changes),
                Some("closed") => Closed(changes),
                _ => Reopened(changes),
            }
        }
        Some("comment-added" | "comment-edited" | "comment-removed") => {
            check_keys(&["commentId", "before", "after"])?;
            let change = TicketCommentChange {
                comment_id: ticket_uuid(&value["commentId"], "commentId")?.into(),
                before: nullable(value, "before", |v| {
                    ticket_comment_body(v).map(str::to_owned)
                })?,
                after: nullable(value, "after", |v| {
                    ticket_comment_body(v).map(str::to_owned)
                })?,
            };
            match action {
                Some("comment-added") => CommentAdded(change),
                Some("comment-edited") => CommentEdited(change),
                _ => CommentRemoved(change),
            }
        }
        Some("linked" | "unlinked") => {
            check_keys(&["kind", "sourceId", "targetId"])?;
            let kind = ticket_link_kind(&value["kind"])?;
            let link = TicketLink {
                source_id: stored_ticket_id(&value["sourceId"])?,
                target_id: stored_ticket_id(&value["targetId"])?,
                kind,
            };
            if action == Some("linked") {
                Linked(link)
            } else {
                Unlinked(link)
            }
        }
        _ => return ticket_invalid("Invalid activity action."),
    };
    Ok(TicketActivity { base, action })
}

pub fn parse_ticket_write_result(
    value: &Value,
) -> Result<TicketWriteResult, TicketValidationError> {
    let raw = ticket_record(
        value,
        &[
            "success",
            "storeId",
            "collectionRevision",
            "ticket",
            "comment",
            "relatedTicket",
        ],
    )?;
    if value["success"] != true {
        return ticket_invalid("Expected a successful ticket result.");
    }
    let ticket = parse_ticket(&value["ticket"])?;
    let comment = raw.get("comment").map(parse_ticket_comment).transpose()?;
    if comment
        .as_ref()
        .is_some_and(|comment| comment.ticket_id != ticket.id)
    {
        return ticket_invalid("Result comment belongs to another ticket.");
    }
    Ok(TicketWriteResult {
        success: true,
        version: TicketCollectionVersion {
            store_id: ticket_uuid(&value["storeId"], "storeId")?.into(),
            collection_revision: ticket_integer(
                &value["collectionRevision"],
                "collectionRevision",
                Some(0.0),
                None,
            )? as u64,
        },
        ticket,
        comment,
        related_ticket: raw.get("relatedTicket").map(parse_ticket).transpose()?,
    })
}
