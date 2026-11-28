use garcon_contract::garcon_commands::GarconEdgeCommand;
use serde_json::{Value, json};

use crate::{
    contracts::{LedgerNoticeDetail, LedgerRowData, LedgerRowDraft},
    sqlite_operations::LedgerResult,
};

const CHAT_ID_REQUEST: &str = "chat-id-request";
const INTER_AGENT_SEND_REQUEST: &str = "inter-agent-send-request";
const AGENT_START_REQUEST: &str = "agent-start-request";
const AGENT_RESUME_REQUEST: &str = "agent-resume-request";
const AGENT_STOP_REQUEST: &str = "agent-stop-request";
const AGENT_SCHEDULE_REQUEST: &str = "agent-schedule-request";
const TICKET_COMMAND_REQUEST: &str = "ticket-command-request";

pub(crate) fn is_private_notice_detail(detail: &Value) -> bool {
    matches!(
        detail["type"].as_str(),
        Some(
            CHAT_ID_REQUEST
                | INTER_AGENT_SEND_REQUEST
                | AGENT_START_REQUEST
                | AGENT_RESUME_REQUEST
                | AGENT_STOP_REQUEST
                | AGENT_SCHEDULE_REQUEST
                | TICKET_COMMAND_REQUEST
        )
    )
}

pub(crate) fn request_notice(
    at: &str,
    command: &GarconEdgeCommand,
) -> LedgerResult<LedgerRowDraft> {
    use GarconEdgeCommand::*;

    let (message, kind) = match command {
        GetChatId => {
            return Ok(notice(
                at,
                "Agent requested chat ID",
                json!({"type": CHAT_ID_REQUEST}),
            ));
        }
        SendMessage {
            recipients,
            hide_sender,
            body,
        } => {
            return Ok(notice(
                at,
                "Agent requested inter-agent message delivery",
                json!({
                    "type": INTER_AGENT_SEND_REQUEST,
                    "recipients": recipients,
                    "hideSender": hide_sender,
                    "body": body,
                }),
            ));
        }
        StartAgent(_) => ("Agent requested child creation", AGENT_START_REQUEST),
        ResumeAgent(_) => ("Agent requested child resume", AGENT_RESUME_REQUEST),
        StopAgent(_) => ("Agent requested child stop", AGENT_STOP_REQUEST),
        Schedule(_) => ("Agent requested prompt scheduling", AGENT_SCHEDULE_REQUEST),
        Ticket(_) => ("Agent requested ticket management", TICKET_COMMAND_REQUEST),
    };
    let serialized = serde_json::to_vec(command)?;
    let evidence: Value = garcon_js::json::from_slice(&serialized)?;
    Ok(notice(
        at,
        message,
        json!({ "type": kind, "command": evidence }),
    ))
}

pub(crate) fn notice(at: &str, message: impl Into<String>, detail: Value) -> LedgerRowDraft {
    LedgerRowDraft {
        at: at.into(),
        provider_meta: None,
        data: LedgerRowData::Notice {
            message: message.into(),
            detail: LedgerNoticeDetail::Other(detail.into()),
        },
    }
}
