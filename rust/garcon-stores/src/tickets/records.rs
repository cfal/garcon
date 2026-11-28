use garcon_base::stored_json::parse_stored_json;
use garcon_contract::{
    error_codes::ErrorCode,
    ticket_records::{parse_ticket, parse_ticket_comment, parse_ticket_write_result},
    ticket_stored::{normalize_stored_ticket, normalize_stored_ticket_write_result},
    ticket_validation::{MAX_SAFE_TICKET_INTEGER, ticket_number},
    tickets::{
        Ticket, TicketActivityAction, TicketActivityBase, TicketComment, TicketResolution,
        TicketStatus, TicketWriteResult, ticket_owner_key,
    },
};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;

use super::contracts::TicketMutationContext;
use super::errors::{Result, next_ticket_counter, ticket_conflict, ticket_error};

pub(super) fn status_name(status: TicketStatus) -> &'static str {
    match status {
        TicketStatus::Open => "open",
        TicketStatus::InProgress => "in-progress",
        TicketStatus::InReview => "in-review",
        TicketStatus::Closed => "closed",
    }
}

fn resolution_name(resolution: TicketResolution) -> &'static str {
    match resolution {
        TicketResolution::Done => "done",
        TicketResolution::Canceled => "canceled",
    }
}

pub(super) fn decode_ticket(row: &Row<'_>) -> Result<Ticket> {
    let payload: String = row.get("payload_json")?;
    let parsed = parse_stored_json(&payload, "Ticket record")?;
    let ticket = parse_ticket(normalize_stored_ticket(&parsed)?.as_value())?;
    let assignee = ticket.assignee.as_ref().map(ticket_owner_key);
    let parent = ticket.parent_id.as_deref().map(ticket_number).transpose()?;
    if ticket.number as i64 != row.get::<_, i64>("number")?
        || ticket.revision as i64 != row.get::<_, i64>("revision")?
        || ticket.project != row.get::<_, String>("project")?
        || status_name(ticket.status) != row.get::<_, String>("status")?
        || ticket.resolution.map(resolution_name)
            != row.get::<_, Option<String>>("resolution")?.as_deref()
        || u8::from(ticket.priority) != row.get::<_, u8>("priority")?
        || assignee != row.get::<_, Option<String>>("assignee_key")?
        || parent.map(|v| v as i64) != row.get::<_, Option<i64>>("parent_number")?
    {
        return Err("Inconsistent ticket record.".into());
    }
    Ok(ticket)
}

pub(super) fn require_ticket(database: &Connection, id: &str) -> Result<Ticket> {
    let mut statement = database.prepare_cached("SELECT * FROM tickets WHERE number=?")?;
    let mut rows = statement.query([ticket_number(id)? as i64])?;
    match rows.next()? {
        Some(row) => decode_ticket(row),
        None => Err(ticket_error(
            ErrorCode::TICKET_NOT_FOUND,
            "Ticket not found.",
        )),
    }
}

pub(super) fn require_ticket_revision(ticket: &Ticket, revision: u64) -> Result<()> {
    if ticket.revision != revision {
        return Err(ticket_conflict(
            ErrorCode::TICKET_REVISION_CONFLICT,
            "Ticket changed. Read it before retrying.",
            Some(ticket.clone()),
            None,
        ));
    }
    Ok(())
}

pub(super) fn collection_revision(database: &Connection) -> Result<u64> {
    let revision: Option<i64> = database
        .query_row(
            "SELECT revision FROM ticket_meta WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    revision
        .filter(|v| (0..=MAX_SAFE_TICKET_INTEGER as i64).contains(v))
        .map(|v| v as u64)
        .ok_or_else(|| "Invalid ticket revision.".into())
}

pub(super) fn require_collection_revision(
    database: &Connection,
    expected: Option<u64>,
) -> Result<u64> {
    let revision = collection_revision(database)?;
    if expected.is_some_and(|expected| expected != revision) {
        return Err(ticket_error(
            ErrorCode::TICKET_COLLECTION_CHANGED,
            "Tickets changed. Refresh before loading the next page.",
        ));
    }
    Ok(revision)
}

pub(super) fn save_ticket(database: &Connection, ticket: &Ticket) -> Result<()> {
    database.prepare_cached("UPDATE tickets SET revision=?, project=?, status=?, resolution=?, priority=?,\n    assignee_key=?, parent_number=?, payload_json=? WHERE number=?")?
        .execute(params![ticket.revision as i64, ticket.project, status_name(ticket.status), ticket.resolution.map(resolution_name), u8::from(ticket.priority),
            ticket.assignee.as_ref().map(ticket_owner_key), ticket.parent_id.as_deref().map(ticket_number).transpose()?.map(|v| v as i64),
            serde_json::to_string(ticket)?, ticket.number as i64])?;
    database
        .prepare_cached("DELETE FROM ticket_labels WHERE ticket_number=?")?
        .execute([ticket.number as i64])?;
    let mut insert = database.prepare_cached("INSERT INTO ticket_labels VALUES (?, ?)")?;
    for label in &ticket.labels {
        insert.execute(params![ticket.number as i64, label])?;
    }
    Ok(())
}

pub(super) fn next_autoincrement(database: &Connection, table: &str) -> Result<u64> {
    let sequence: i64 = database
        .prepare_cached("SELECT seq FROM sqlite_sequence WHERE name=?")?
        .query_row([table], |row| row.get(0))
        .optional()?
        .unwrap_or(0);
    next_ticket_counter(sequence as f64)
}

pub(super) struct StoredCommentRow {
    id: String,
    ticket_number: i64,
    sequence: i64,
    revision: i64,
    pub authority_key: String,
    pub deleted_at: Option<String>,
    payload_json: String,
}

impl StoredCommentRow {
    pub(super) fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            ticket_number: row.get("ticket_number")?,
            sequence: row.get("sequence")?,
            revision: row.get("revision")?,
            authority_key: row.get("authority_key")?,
            deleted_at: row.get("deleted_at")?,
            payload_json: row.get("payload_json")?,
        })
    }
}

pub(super) fn decode_comment(row: &StoredCommentRow) -> Result<TicketComment> {
    let comment =
        parse_ticket_comment(parse_stored_json(&row.payload_json, "Ticket comment")?.as_value())?;
    if comment.id != row.id
        || ticket_number(&comment.ticket_id)? as i64 != row.ticket_number
        || comment.sequence as i64 != row.sequence
        || comment.revision as i64 != row.revision
        || comment.deleted_at != row.deleted_at
    {
        return Err("Inconsistent ticket comment.".into());
    }
    Ok(comment)
}

pub(super) fn require_comment(
    database: &Connection,
    id: &str,
    ticket_id: &str,
) -> Result<StoredCommentRow> {
    let row = database
        .prepare_cached("SELECT * FROM ticket_comments WHERE id=?")?
        .query_row([id], StoredCommentRow::read)
        .optional()?;
    let number = ticket_number(ticket_id)? as i64;
    row.filter(|row| row.ticket_number == number)
        .ok_or_else(|| {
            ticket_error(
                ErrorCode::TICKET_COMMENT_NOT_FOUND,
                "Comment not found on this ticket.",
            )
        })
}

pub(super) fn initial_comment_value(comment: &TicketComment) -> serde_json::Result<Value> {
    let mut value = serde_json::to_value(comment)?;
    if let Some(fields) = value.as_object_mut()
        && let Some(deleted_at) = fields.shift_remove("deletedAt")
    {
        fields.insert("deletedAt".into(), deleted_at);
    }
    Ok(value)
}

pub(super) fn insert_comment(
    database: &Connection,
    comment: &TicketComment,
    authority_key: &str,
) -> Result<()> {
    database.prepare_cached("INSERT INTO ticket_comments\n    (id,ticket_number,sequence,revision,authority_key,deleted_at,payload_json) VALUES (?,?,?,?,?,?,?)")?
        .execute(params![comment.id, ticket_number(&comment.ticket_id)? as i64, comment.sequence as i64, comment.revision as i64,
            authority_key, comment.deleted_at, serde_json::to_string(&initial_comment_value(comment)?)?])?;
    Ok(())
}

pub(super) fn update_comment(database: &Connection, comment: &TicketComment) -> Result<()> {
    database
        .prepare_cached(
            "UPDATE ticket_comments SET revision=?, deleted_at=?, payload_json=? WHERE id=?",
        )?
        .execute(params![
            comment.revision as i64,
            comment.deleted_at,
            serde_json::to_string(comment)?,
            comment.id
        ])?;
    Ok(())
}

pub(super) fn append_activity(
    database: &Connection,
    ticket_id: &str,
    action: TicketActivityAction,
    context: &TicketMutationContext,
    now: &str,
) -> Result<()> {
    #[derive(Serialize)]
    struct StoredActivity {
        #[serde(flatten)]
        action: TicketActivityAction,
        #[serde(flatten)]
        base: TicketActivityBase,
    }
    let sequence = next_autoincrement(database, "ticket_activity")?;
    let activity = StoredActivity {
        action,
        base: TicketActivityBase {
            sequence,
            ticket_id: ticket_id.into(),
            at: now.into(),
            actor: context.caller.actor.clone(),
            source: context.source.clone(),
        },
    };
    database.prepare_cached("INSERT INTO ticket_activity (sequence,ticket_number,operation_key,payload_json) VALUES (?,?,?,?)")?
        .execute(params![sequence as i64, ticket_number(ticket_id)? as i64, context.operation_key, serde_json::to_string(&activity)?])?;
    Ok(())
}

pub(super) fn read_operation(
    database: &Connection,
    context: &TicketMutationContext,
) -> Result<Option<TicketWriteResult>> {
    let row: Option<(String, String)> = database
        .prepare_cached(
            "SELECT fingerprint,result_json FROM ticket_operations WHERE operation_key=?",
        )?
        .query_row([&context.operation_key], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()?;
    let Some((fingerprint, result)) = row else {
        return Ok(None);
    };
    if fingerprint != context.fingerprint {
        return Err(ticket_error(
            ErrorCode::TICKET_REQUEST_CONFLICT,
            "This request identity was already used for different ticket content.",
        ));
    }
    let parsed = parse_stored_json(&result, "Ticket operation result")?;
    let result =
        parse_ticket_write_result(normalize_stored_ticket_write_result(&parsed)?.as_value())?;
    if result.version.store_id != context.expected_store_id {
        return Err("Inconsistent ticket operation store.".into());
    }
    Ok(Some(result))
}
