use garcon_contract::{
    error_codes::ErrorCode,
    ticket_commands::{
        CreateProject, TicketCreateFields, TicketLinkTarget, TicketMutationPayload,
        TicketMutationTarget, TicketPatch, TicketPatchStatus,
    },
    ticket_validation::format_ticket_id,
    tickets::{
        Ticket, TicketActivityAction, TicketChanges, TicketComment, TicketCommentChange,
        TicketFieldChange, TicketLink, TicketLinkKind, TicketStatus, ticket_owner_key,
    },
};
use rusqlite::{Connection, params};

use super::contracts::{TicketMutationContext, ticket_authority_key};
use super::errors::{Result, next_ticket_counter, ticket_conflict, ticket_error};
use super::records::{
    append_activity, decode_comment, insert_comment, next_autoincrement, require_comment,
    require_ticket, require_ticket_revision, save_ticket, update_comment,
};
use super::relationships::{
    require_link_capacity, require_no_blocking_cycle, validate_ticket_parent,
};

pub(super) struct TicketMutationCommit {
    pub ticket: Ticket,
    pub comment: Option<TicketComment>,
    pub related_ticket: Option<Ticket>,
    pub changed: bool,
}

impl TicketMutationCommit {
    fn ticket(ticket: Ticket, changed: bool) -> Self {
        Self {
            ticket,
            comment: None,
            related_ticket: None,
            changed,
        }
    }
}

fn field_changes(current: &Ticket, next: &Ticket) -> Vec<TicketFieldChange> {
    let mut changes = Vec::new();
    macro_rules! compare {
        ($($field:ident : $variant:ident),* $(,)?) => { $(
            if current.$field != next.$field {
                changes.push(TicketFieldChange::$variant { before: current.$field.to_owned(), after: next.$field.to_owned() });
            }
        )* };
    }
    compare!(title: Title, description: Description, project: Project, status: Status, resolution: Resolution,
        priority: Priority, labels: Labels, assignee: Assignee, parent_id: ParentId);
    changes
}

fn commit_fields(
    database: &Connection,
    current: Ticket,
    mut candidate: Ticket,
    action: impl FnOnce(TicketChanges) -> TicketActivityAction,
    context: &TicketMutationContext,
    now: &str,
) -> Result<TicketMutationCommit> {
    let changes = field_changes(&current, &candidate);
    if changes.is_empty() {
        return Ok(TicketMutationCommit::ticket(current, false));
    }
    candidate.revision = next_ticket_counter(current.revision as f64)?;
    candidate.updated_at = now.into();
    let parent_changed = candidate.parent_id != current.parent_id;
    if parent_changed && let Some(parent) = &candidate.parent_id {
        require_ticket(database, parent)?;
    }
    save_ticket(database, &candidate)?;
    if parent_changed {
        validate_ticket_parent(database, &candidate)?;
    }
    append_activity(
        database,
        &candidate.id,
        action(TicketChanges { changes }),
        context,
        now,
    )?;
    Ok(TicketMutationCommit::ticket(candidate, true))
}

fn create(
    database: &Connection,
    input: TicketCreateFields<CreateProject>,
    context: &TicketMutationContext,
    now: &str,
) -> Result<TicketMutationCommit> {
    if let Some(parent) = &input.parent_id {
        require_ticket(database, parent)?;
    }
    let number = next_autoincrement(database, "tickets")?;
    let ticket = Ticket {
        id: format_ticket_id(number as f64)?,
        number,
        revision: 1,
        title: input.title,
        description: input.description,
        project: input.project.project,
        status: TicketStatus::Open,
        resolution: None,
        priority: input.priority,
        labels: input.labels,
        assignee: input.assignee,
        parent_id: input.parent_id,
        created_at: now.into(),
        updated_at: now.into(),
        created_by: context.caller.actor.clone(),
    };
    database.prepare_cached("INSERT INTO tickets\n    (number, revision, project, status, resolution, priority, payload_json) VALUES (?,1,?,'open',NULL,?,?)")?
        .execute(params![number as i64, ticket.project, u8::from(ticket.priority), serde_json::to_string(&ticket)?])?;
    save_ticket(database, &ticket)?;
    validate_ticket_parent(database, &ticket)?;
    append_activity(
        database,
        &ticket.id,
        TicketActivityAction::Created {
            ticket: Box::new(ticket.clone()),
        },
        context,
        now,
    )?;
    Ok(TicketMutationCommit::ticket(ticket, true))
}

fn add_comment(
    database: &Connection,
    ticket: &Ticket,
    body: String,
    context: &TicketMutationContext,
    now: &str,
) -> Result<TicketComment> {
    let latest: Option<i64> = database
        .prepare_cached(
            "SELECT max(sequence) AS sequence FROM ticket_comments WHERE ticket_number=?",
        )?
        .query_row([ticket.number as i64], |row| row.get(0))?;
    let comment = TicketComment {
        id: uuid::Uuid::new_v4().to_string(),
        ticket_id: ticket.id.clone(),
        sequence: next_ticket_counter(latest.unwrap_or(0) as f64)?,
        revision: 1,
        body: Some(body),
        deleted_at: None,
        author: context.caller.actor.clone(),
        created_at: now.into(),
        updated_at: now.into(),
    };
    insert_comment(
        database,
        &comment,
        &ticket_authority_key(&context.caller.authority),
    )?;
    append_activity(
        database,
        &ticket.id,
        TicketActivityAction::CommentAdded(TicketCommentChange {
            comment_id: comment.id.clone(),
            before: None,
            after: comment.body.clone(),
        }),
        context,
        now,
    )?;
    Ok(comment)
}

fn change_comment(
    database: &Connection,
    ticket: Ticket,
    target: TicketMutationTarget,
    comment_id: &str,
    body: Option<String>,
    context: &TicketMutationContext,
    now: &str,
) -> Result<TicketMutationCommit> {
    let stored = require_comment(database, comment_id, &ticket.id)?;
    if stored.authority_key != ticket_authority_key(&context.caller.authority) {
        return Err(ticket_error(
            ErrorCode::TICKET_FORBIDDEN,
            "Only the comment author can change it.",
        ));
    }
    let mut comment = decode_comment(&stored)?;
    if comment.revision != target.expected_revision {
        return Err(ticket_conflict(
            ErrorCode::TICKET_COMMENT_REVISION_CONFLICT,
            "Comment changed. Read it before retrying.",
            None,
            Some(comment),
        ));
    }
    if body.is_some() && comment.deleted_at.is_some() {
        return Err(ticket_error(
            ErrorCode::TICKET_INVALID_TRANSITION,
            "Removed comments cannot be edited.",
        ));
    }
    if body == comment.body {
        return Ok(TicketMutationCommit {
            comment: Some(comment),
            ..TicketMutationCommit::ticket(ticket, false)
        });
    }
    let deleting = body.is_none();
    let change = TicketCommentChange {
        comment_id: comment.id.clone(),
        before: comment.body,
        after: body.clone(),
    };
    comment.body = body;
    comment.revision = next_ticket_counter(comment.revision as f64)?;
    comment.updated_at = now.into();
    comment.deleted_at = deleting.then(|| now.into());
    update_comment(database, &comment)?;
    let action = if deleting {
        TicketActivityAction::CommentRemoved(change)
    } else {
        TicketActivityAction::CommentEdited(change)
    };
    append_activity(database, &ticket.id, action, context, now)?;
    Ok(TicketMutationCommit {
        comment: Some(comment),
        ..TicketMutationCommit::ticket(ticket, true)
    })
}

#[derive(Clone, Copy, PartialEq)]
enum LinkAction {
    Link,
    Unlink,
}

fn change_link(
    database: &Connection,
    mut ticket: Ticket,
    patch: TicketLinkTarget,
    action: LinkAction,
    context: &TicketMutationContext,
    now: &str,
) -> Result<TicketMutationCommit> {
    let mut target = require_ticket(database, &patch.target_id)?;
    require_ticket_revision(&target, patch.target_revision)?;
    if ticket.id == target.id {
        return Err(ticket_error(
            ErrorCode::TICKET_RELATIONSHIP_CYCLE,
            "A ticket cannot link to itself.",
        ));
    }
    let (mut source_number, mut target_number) = (ticket.number, target.number);
    if patch.kind == TicketLinkKind::Related && source_number > target_number {
        std::mem::swap(&mut source_number, &mut target_number);
    }
    let kind = match patch.kind {
        TicketLinkKind::Blocks => "blocks",
        TicketLinkKind::Related => "related",
    };
    let existing = database
        .prepare_cached(
            "SELECT 1 FROM ticket_links WHERE source_number=? AND target_number=? AND kind=?",
        )?
        .exists(params![source_number as i64, target_number as i64, kind])?;
    if (action == LinkAction::Link) == existing {
        return Ok(TicketMutationCommit {
            related_ticket: Some(target),
            ..TicketMutationCommit::ticket(ticket, false)
        });
    }
    if action == LinkAction::Link {
        require_link_capacity(database, source_number, target_number)?;
        if patch.kind == TicketLinkKind::Blocks {
            require_no_blocking_cycle(database, &ticket.id, &target.id)?;
        }
        database
            .prepare_cached("INSERT INTO ticket_links VALUES (?,?,?)")?
            .execute(params![source_number as i64, target_number as i64, kind])?;
    } else {
        database
            .prepare_cached(
                "DELETE FROM ticket_links WHERE source_number=? AND target_number=? AND kind=?",
            )?
            .execute(params![source_number as i64, target_number as i64, kind])?;
    }
    ticket.revision = next_ticket_counter(ticket.revision as f64)?;
    target.revision = next_ticket_counter(target.revision as f64)?;
    for endpoint in [&mut ticket, &mut target] {
        endpoint.updated_at = now.into();
        save_ticket(database, endpoint)?;
        let link = TicketLink {
            source_id: format_ticket_id(source_number as f64)?,
            target_id: format_ticket_id(target_number as f64)?,
            kind: patch.kind,
        };
        let event = if action == LinkAction::Link {
            TicketActivityAction::Linked(link)
        } else {
            TicketActivityAction::Unlinked(link)
        };
        append_activity(database, &endpoint.id, event, context, now)?;
    }
    Ok(TicketMutationCommit {
        related_ticket: Some(target),
        ..TicketMutationCommit::ticket(ticket, true)
    })
}

fn apply_patch(ticket: &mut Ticket, patch: TicketPatch) {
    if let Some(v) = patch.title {
        ticket.title = v;
    }
    if let Some(v) = patch.description {
        ticket.description = v;
    }
    if let Some(v) = patch.project {
        ticket.project = v;
    }
    if let Some(v) = patch.priority {
        ticket.priority = v;
    }
    if let Some(v) = patch.labels {
        ticket.labels = v;
    }
    if !patch.assignee.is_absent() {
        ticket.assignee = patch.assignee.as_option().cloned();
    }
    if !patch.parent_id.is_absent() {
        ticket.parent_id = patch.parent_id.as_option().cloned();
    }
    if let Some(v) = patch.status {
        ticket.status = match v {
            TicketPatchStatus::Open => TicketStatus::Open,
            TicketPatchStatus::InProgress => TicketStatus::InProgress,
            TicketPatchStatus::InReview => TicketStatus::InReview,
        };
    }
}

fn require_current(database: &Connection, target: &TicketMutationTarget) -> Result<Ticket> {
    let ticket = require_ticket(database, &target.ticket_id)?;
    require_ticket_revision(&ticket, target.expected_revision)?;
    Ok(ticket)
}

pub(super) fn mutate_ticket(
    database: &Connection,
    payload: TicketMutationPayload,
    context: &TicketMutationContext,
    now: &str,
) -> Result<TicketMutationCommit> {
    use TicketActivityAction as Activity;
    use TicketMutationPayload as Mutation;
    let invalid_transition = |message| ticket_error(ErrorCode::TICKET_INVALID_TRANSITION, message);
    let assigned_to_other = |ticket: &Ticket| {
        ticket
            .assignee
            .as_ref()
            .is_some_and(|owner| ticket_owner_key(owner) != ticket_owner_key(&context.caller.owner))
    };
    match payload {
        Mutation::Create { input } => create(database, input, context, now),
        Mutation::Comment { ticket_id, body } => {
            let ticket = require_ticket(database, &ticket_id)?;
            let comment = add_comment(database, &ticket, body, context, now)?;
            Ok(TicketMutationCommit {
                comment: Some(comment),
                ..TicketMutationCommit::ticket(ticket, true)
            })
        }
        Mutation::CommentEdit {
            target,
            comment_id,
            body,
        } => {
            let ticket = require_ticket(database, &target.ticket_id)?;
            change_comment(
                database,
                ticket,
                target,
                &comment_id,
                Some(body),
                context,
                now,
            )
        }
        Mutation::CommentDelete { target, comment_id } => {
            let ticket = require_ticket(database, &target.ticket_id)?;
            change_comment(database, ticket, target, &comment_id, None, context, now)
        }
        Mutation::Update(update) => {
            let current = require_current(database, &update.target)?;
            if update.patch.status.is_some() && current.status == TicketStatus::Closed {
                return Err(invalid_transition(
                    "Use reopen before changing a closed ticket status.",
                ));
            }
            let mut candidate = current.clone();
            apply_patch(&mut candidate, update.patch);
            commit_fields(
                database,
                current,
                candidate,
                Activity::Updated,
                context,
                now,
            )
        }
        Mutation::Claim(target) => {
            let current = require_current(database, &target)?;
            if current.status == TicketStatus::Closed {
                return Err(invalid_transition("A closed ticket cannot be claimed."));
            }
            if assigned_to_other(&current) {
                return Err(ticket_conflict(
                    ErrorCode::TICKET_ALREADY_CLAIMED,
                    "Ticket is assigned to another owner.",
                    Some(current),
                    None,
                ));
            }
            let mut candidate = current.clone();
            candidate.assignee = Some(context.caller.owner.clone());
            if candidate.status == TicketStatus::Open {
                candidate.status = TicketStatus::InProgress;
            }
            commit_fields(
                database,
                current,
                candidate,
                Activity::Claimed,
                context,
                now,
            )
        }
        Mutation::Release(target) => {
            let current = require_current(database, &target)?;
            if assigned_to_other(&current) {
                return Err(ticket_conflict(
                    ErrorCode::TICKET_ALREADY_CLAIMED,
                    "Only the assigned owner can release this ticket.",
                    Some(current),
                    None,
                ));
            }
            let candidate = Ticket {
                assignee: None,
                ..current.clone()
            };
            commit_fields(
                database,
                current,
                candidate,
                Activity::Released,
                context,
                now,
            )
        }
        Mutation::Reopen(target) => {
            let current = require_current(database, &target)?;
            if current.status != TicketStatus::Closed {
                return Ok(TicketMutationCommit::ticket(current, false));
            }
            let candidate = Ticket {
                status: TicketStatus::Open,
                resolution: None,
                ..current.clone()
            };
            commit_fields(
                database,
                current,
                candidate,
                Activity::Reopened,
                context,
                now,
            )
        }
        Mutation::Close {
            target,
            resolution,
            comment,
        } => {
            let current = require_current(database, &target)?;
            if current.status == TicketStatus::Closed && current.resolution != Some(resolution) {
                return Err(invalid_transition(
                    "Reopen the ticket before changing its resolution.",
                ));
            }
            let candidate = Ticket {
                status: TicketStatus::Closed,
                resolution: Some(resolution),
                ..current.clone()
            };
            let mut commit =
                commit_fields(database, current, candidate, Activity::Closed, context, now)?;
            if let Some(body) = comment {
                commit.comment = Some(add_comment(database, &commit.ticket, body, context, now)?);
                commit.changed = true;
            }
            Ok(commit)
        }
        Mutation::Link(patch) => {
            let current = require_current(database, &patch.target)?;
            change_link(database, current, patch, LinkAction::Link, context, now)
        }
        Mutation::Unlink(patch) => {
            let current = require_current(database, &patch.target)?;
            change_link(database, current, patch, LinkAction::Unlink, context, now)
        }
    }
}
