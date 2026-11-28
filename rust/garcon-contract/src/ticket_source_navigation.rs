//! Ports `common/ticket-source-navigation.ts`.

use serde::Serialize;
use serde_json::Value;

use crate::ticket_validation::{
    TicketValidationError, ticket_chat_id, ticket_invalid, ticket_record, ticket_source,
};
use crate::tickets::TicketSource;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TicketSourceResolution {
    Found { target: TicketSource },
    TranscriptReloaded { chat_id: String },
    OutcomeUnavailable { chat_id: String },
}

pub fn parse_ticket_source_resolution(
    value: &Value,
) -> Result<TicketSourceResolution, TicketValidationError> {
    ticket_record(value, &["kind", "target", "chatId"])?;
    let kind = value["kind"].as_str();
    match kind {
        Some("found") => {
            ticket_record(value, &["kind", "target"])?;
            Ok(TicketSourceResolution::Found {
                target: ticket_source(&value["target"])?,
            })
        }
        Some("transcript-reloaded" | "outcome-unavailable") => {
            ticket_record(value, &["kind", "chatId"])?;
            let chat_id = ticket_chat_id(&value["chatId"])?;
            if kind == Some("transcript-reloaded") {
                Ok(TicketSourceResolution::TranscriptReloaded { chat_id })
            } else {
                Ok(TicketSourceResolution::OutcomeUnavailable { chat_id })
            }
        }
        _ => ticket_invalid("Invalid ticket source resolution."),
    }
}
