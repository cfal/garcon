use garcon_base::errors::NamedError;
use garcon_contract::{
    chat_id::ChatId,
    chat_types::ChatMessage,
    garcon_command_rejection::{GarconCommandIssue, garcon_command_rejection_notice},
    garcon_commands::{
        GarconCommandTransform, GarconEdgeCommand, INTER_AGENT_MESSAGE_NOTICE_TITLE,
        extract_garcon_commands,
    },
};
use garcon_interface::producer::AgentProducedRow;
use serde::Serialize;
use serde_json::json;

use crate::{
    contracts::{LedgerRow, LedgerRowData, LedgerRowDraft, TranscriptViewId},
    garcon_command_request::{notice, request_notice},
    sqlite_operations::LedgerResult,
};

pub struct ProducerPublication {
    pub drafts: Vec<LedgerRowDraft>,
    pub commands: Vec<PendingGarconCommand>,
    pub rejections: Vec<PendingGarconCommandRejection>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingGarconCommand {
    pub command: GarconEdgeCommand,
    pub at: String,
    pub request_draft_index: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingGarconCommandRejection {
    pub issues: Vec<GarconCommandIssue>,
    pub notice_draft_index: usize,
}

pub fn canonicalize_garcon_producer_rows(
    rows: Vec<AgentProducedRow>,
) -> LedgerResult<ProducerPublication> {
    let mut publication = ProducerPublication {
        drafts: Vec::with_capacity(rows.len()),
        commands: Vec::new(),
        rejections: Vec::new(),
    };
    for AgentProducedRow {
        message,
        provider_meta,
    } in rows
    {
        let Some(GarconCommandTransform {
            message: remaining,
            commands,
            issues,
        }) = extract_garcon_commands(&message)
        else {
            publication.drafts.push(LedgerRowDraft {
                at: message_timestamp(&message).into(),
                data: LedgerRowData::ProviderRow { message },
                provider_meta,
            });
            continue;
        };
        let at = message_timestamp(&message);
        if let Some(remaining) = remaining {
            publication.drafts.push(LedgerRowDraft {
                at: remaining.timestamp.clone(),
                data: LedgerRowData::ProviderRow {
                    message: ChatMessage::Assistant(remaining),
                },
                provider_meta,
            });
        }
        for command in commands {
            let draft = request_notice(at, &command)?;
            publication.commands.push(PendingGarconCommand {
                command,
                at: at.into(),
                request_draft_index: publication.drafts.len(),
            });
            publication.drafts.push(draft);
        }
        if issues.is_empty() {
            continue;
        }
        let notice_draft_index = publication.drafts.len();
        publication.drafts.extend(issues.iter().map(|issue| {
            let command = issue.command.as_str();
            notice(at, garcon_command_rejection_notice(command), json!({
                "title": if command == "send-message" { INTER_AGENT_MESSAGE_NOTICE_TITLE } else { "Agent command" },
            }))
        }));
        publication.rejections.push(PendingGarconCommandRejection {
            issues,
            notice_draft_index,
        });
    }
    Ok(publication)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandSource<'a> {
    pub chat_id: &'a str,
    pub view_id: &'a TranscriptViewId,
    pub request_ordinal: u64,
    pub run_id: Option<&'a str>,
    pub at: &'a str,
}

pub enum GarconCommandDispatch<'a> {
    Request {
        source: AgentCommandSource<'a>,
        command: &'a GarconEdgeCommand,
    },
    ChatIdRequest {
        chat_id: &'a str,
        view_id: &'a TranscriptViewId,
        run_id: Option<&'a str>,
        at: &'a str,
    },
    InterAgentMessage {
        source_chat_id: &'a str,
        source_view_id: &'a TranscriptViewId,
        request_at: &'a str,
        recipients: &'a [ChatId],
        hide_sender: bool,
        body: &'a str,
    },
    Rejected {
        chat_id: &'a str,
        view_id: &'a TranscriptViewId,
        notice_ordinal: u64,
        issues: &'a [GarconCommandIssue],
    },
}

pub fn dispatch_garcon_commands<'a>(
    publication: &'a ProducerPublication,
    chat_id: &'a str,
    view_id: &'a TranscriptViewId,
    run_id: Option<&'a str>,
    committed_rows: &'a [LedgerRow],
    mut dispatch: impl FnMut(GarconCommandDispatch<'a>) -> LedgerResult<()>,
) -> LedgerResult<()> {
    use GarconEdgeCommand::*;
    for PendingGarconCommand {
        command,
        at,
        request_draft_index,
    } in &publication.commands
    {
        let request = match command {
            GetChatId => GarconCommandDispatch::ChatIdRequest {
                chat_id,
                view_id,
                run_id,
                at,
            },
            SendMessage {
                recipients,
                hide_sender,
                body,
            } => GarconCommandDispatch::InterAgentMessage {
                source_chat_id: chat_id,
                source_view_id: view_id,
                request_at: at,
                recipients,
                hide_sender: *hide_sender,
                body,
            },
            StartAgent(_) | ResumeAgent(_) | StopAgent(_) | Schedule(_) | Ticket(_) => {
                let row = committed_rows
                    .get(*request_draft_index)
                    .ok_or_else(|| missing_evidence("Committed Garcon request row is missing"))?;
                GarconCommandDispatch::Request {
                    source: AgentCommandSource {
                        chat_id,
                        view_id,
                        run_id,
                        at,
                        request_ordinal: row.ordinal,
                    },
                    command,
                }
            }
        };
        dispatch(request)?;
    }
    for rejection in &publication.rejections {
        let row = committed_rows
            .get(rejection.notice_draft_index)
            .filter(|row| matches!(row.data, LedgerRowData::Notice { .. }))
            .ok_or_else(|| missing_evidence("Committed Garcon rejection notice is missing"))?;
        dispatch(GarconCommandDispatch::Rejected {
            chat_id,
            view_id,
            notice_ordinal: row.ordinal,
            issues: &rejection.issues,
        })?;
    }
    Ok(())
}

fn missing_evidence(message: &str) -> NamedError {
    NamedError {
        name: "Error".into(),
        message: message.into(),
        code: None,
    }
}

fn message_timestamp(message: &ChatMessage) -> &str {
    use ChatMessage::*;
    match message {
        User(value) => &value.timestamp,
        Assistant(value) => &value.timestamp,
        CommandOutput(value) => &value.timestamp,
        CommandResult(value) => &value.timestamp,
        Thinking(value) => &value.timestamp,
        ToolUse(value) => value.timestamp(),
        ToolResult(value) => &value.timestamp,
        Error(value) => &value.timestamp,
        Notice(value) => &value.timestamp,
        CliRow(value) => &value.timestamp,
        PermissionRequest(value) => &value.timestamp,
        PermissionResolved(value) => &value.timestamp,
        PermissionCancelled(value) => &value.timestamp,
        PermissionExpired(value) => &value.timestamp,
        Compaction(value) => &value.timestamp,
        AgentSwitch(value) => &value.timestamp,
    }
}
