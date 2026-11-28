//! Ports `common/ticket-command-notice.ts`.

use garcon_js::json::stringify;
use serde::Serialize;
use serde_json::Value;

use crate::error_codes::ErrorCode;
use crate::garcon_ticket_result::{TicketCommandOutcome, TicketCommandOutcomeStatus};
use crate::ticket_commands::TicketAction;
use crate::tickets::{
    TicketAssignee, TicketLinkKind, TicketListQuery, TicketOwner, TicketPriority, TicketStatus,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum TicketNoticePart {
    Text { text: String },
    Code { text: String },
    Ticket { ticket_id: String },
}

fn labels(command: TicketAction) -> Option<(&'static str, &'static str)> {
    use TicketAction::*;
    Some(match command {
        Create => ("Created ticket", "create ticket"),
        Update => ("Updated ticket", "update ticket"),
        Claim => ("Assigned ticket", "assign ticket"),
        Release => ("Released ticket", "release ticket"),
        Reopen => ("Reopened ticket", "reopen ticket"),
        Close => ("Closed ticket", "close ticket"),
        Comment => ("Added comment to ticket", "add comment to ticket"),
        CommentEdit => ("Edited comment on ticket", "edit comment on ticket"),
        CommentDelete => ("Deleted comment from ticket", "delete comment from ticket"),
        List => ("Listed tickets", "list tickets"),
        Read => ("Read ticket", "read ticket"),
        History => ("Read history for ticket", "read history for ticket"),
        Link | Unlink => return None,
    })
}

fn list_filter_values(filters: &TicketListQuery) -> Vec<(&'static str, String)> {
    let mut values = Vec::new();
    if let Some(project) = &filters.project {
        values.push(("project", project.clone()));
    }
    if let Some(status) = filters.status {
        let status = match status {
            TicketStatus::Open => "open",
            TicketStatus::InProgress => "in progress",
            TicketStatus::InReview => "in review",
            TicketStatus::Closed => "closed",
        };
        values.push(("status", status.to_owned()));
    }
    if let Some(include_closed) = filters.include_closed {
        values.push(("include closed", include_closed.to_string()));
    }
    if let Some(priority) = filters.priority {
        let priority = match priority {
            TicketPriority::P0 => "urgent",
            TicketPriority::P1 => "high",
            TicketPriority::P2 => "normal",
            TicketPriority::P3 => "low",
        };
        values.push(("priority", priority.to_owned()));
    }
    if let Some(label) = &filters.label {
        values.push(("label", label.clone()));
    }
    if let Some(assignee) = &filters.assignee {
        let owner = match assignee {
            TicketAssignee::Unassigned(_) => "unassigned".to_owned(),
            TicketAssignee::Owner(TicketOwner::User { owner_key }) => owner_key.clone(),
            TicketAssignee::Owner(TicketOwner::Executor { executor_id }) => {
                format!("executor {executor_id}")
            }
            TicketAssignee::Owner(TicketOwner::Chat { chat_id }) => format!("chat {chat_id}"),
        };
        values.push(("assignee", owner));
    }
    if let Some(ready) = filters.ready {
        values.push(("ready", ready.to_string()));
    }
    if let Some(query) = &filters.query {
        values.push(("search", query.clone()));
    }
    values
}

fn text(value: impl Into<String>) -> TicketNoticePart {
    TicketNoticePart::Text { text: value.into() }
}

fn ticket(value: &str) -> TicketNoticePart {
    TicketNoticePart::Ticket {
        ticket_id: value.to_owned(),
    }
}

pub fn ticket_command_notice_parts(outcome: &TicketCommandOutcome) -> Vec<TicketNoticePart> {
    let mut parts = Vec::new();
    let command = outcome.identity.command;
    let context = outcome.identity.context.as_ref();
    let ticket_id = outcome.identity.ticket_id.as_deref();
    let failed = matches!(outcome.status, TicketCommandOutcomeStatus::Error { .. });
    if let Some((success, failure)) = labels(command) {
        parts.push(if failed {
            text(format!("Couldn't {failure}"))
        } else {
            text(success)
        });
        if let Some(id) = ticket_id.filter(|id| !id.is_empty()) {
            parts.extend([text(" "), ticket(id)]);
        }
        if command == TicketAction::Claim && !failed {
            parts.push(text(" to this chat"));
        }
    } else {
        let adding = command == TicketAction::Link;
        let link = context.and_then(|context| context.link.as_ref());
        let label = match link.map(|link| link.kind) {
            Some(TicketLinkKind::Blocks) => "blocking link",
            Some(TicketLinkKind::Related) => "related link",
            None => "link",
        };
        if failed {
            let verb = if adding { "add" } else { "remove" };
            parts.extend([
                text(format!("Couldn't {verb} {label} from ")),
                ticket(ticket_id.unwrap_or_default()),
            ]);
        } else {
            let verb = if adding { "added" } else { "removed" };
            parts.extend([
                ticket(ticket_id.unwrap_or_default()),
                text(format!(" updated, {verb} {label}")),
            ]);
        }
        if let Some(link) = link {
            parts.extend([text(" to "), ticket(&link.target_id)]);
        }
    }
    if command == TicketAction::List
        && let Some(filters) = context.and_then(|context| context.filters.as_ref())
    {
        for (index, (name, value)) in list_filter_values(filters).into_iter().enumerate() {
            let separator = if index == 0 { " with filters " } else { ", " };
            parts.extend([
                text(format!("{separator}{name} ")),
                TicketNoticePart::Code { text: value },
            ]);
        }
    }
    if let TicketCommandOutcomeStatus::Error { error_code } = outcome.status {
        parts.extend([
            text(": "),
            TicketNoticePart::Code {
                text: ErrorCode::from(error_code).as_str().to_owned(),
            },
        ]);
    }
    parts
}

pub fn ticket_command_notice_text(outcome: &TicketCommandOutcome) -> String {
    ticket_command_notice_parts(outcome)
        .into_iter()
        .map(|part| match part {
            TicketNoticePart::Text { text } => text,
            TicketNoticePart::Ticket { ticket_id } => ticket_id,
            TicketNoticePart::Code { text } => stringify(&Value::String(text)),
        })
        .collect()
}
