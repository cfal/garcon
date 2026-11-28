use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::{
    agent_execution::{AgentAttachment, AgentAttachmentKind},
    chat_id_discovery::{
        CHAT_ID_DISCOVERY_NOTICE_TITLE, chat_id_disclosure_notice_content, parse_chat_id_disclosure,
    },
    chat_message_coercion::ChatContentMode,
    chat_types::{ChatMessage, UserMessage},
    garcon_command_envelope::GARCON_ELEMENT_PREFIX,
    garcon_command_rejection::{garcon_command_rejection_notice, parse_garcon_command_rejection},
    garcon_command_results::{
        agent_command_outcome_content, agent_command_outcome_title, parse_garcon_command_result,
    },
    garcon_commands::{extract_garcon_commands, parse_garcon_message},
    garcon_ticket_result::{
        parse_garcon_ticket_result, parse_ticket_command_outcome, ticket_command_outcome,
    },
    preamble_prefix::PreamblePrefixReceipt,
    preambles::PendingPreambleBoundary,
    ticket_command_notice::ticket_command_notice_text,
    transcript_notice_details::{AppliedPreambleReference, TranscriptNoticeDetail},
};
use garcon_js::json::Opaque;
use serde_json::{Value, json};

use crate::{
    contracts::{LedgerAgentSwitchDetail, LedgerRowData, LedgerRowDraft, LedgerUserInputDetail},
    garcon_command_publication::message_timestamp,
    garcon_command_request::{notice, request_notice},
    sqlite_operations::LedgerResult,
    store::TranscriptReadSignal,
};

pub struct ImportedRow {
    pub message: ChatMessage,
    pub provider_meta: Option<Opaque>,
    pub preamble_application: Option<PreambleHistoryEvidence>,
}

pub struct PreambleHistoryEvidence {
    pub receipt: PreamblePrefixReceipt,
    pub boundary: PendingPreambleBoundary,
    pub preambles: Vec<AppliedPreambleReference>,
    pub requires_native_occurrence: bool,
}

pub async fn imported_drafts(
    rows: impl IntoIterator<Item = ImportedRow>,
    now: &impl Fn() -> LedgerResult<String>,
    steps: &mut EventLoopSteps,
    signal: Option<TranscriptReadSignal<'_>>,
) -> LedgerResult<Vec<LedgerRowDraft>> {
    let mut drafts = Vec::new();
    steps
        .try_for_each(rows, |row| {
            if let Some(signal) = signal {
                signal.check()?;
            }
            drafts.extend(imported_draft_for(row, now)?);
            Ok::<_, Box<dyn std::error::Error>>(())
        })
        .await?;
    Ok(drafts)
}

pub async fn frozen_drafts(
    messages: impl IntoIterator<Item = ChatMessage>,
    now: &impl Fn() -> LedgerResult<String>,
    steps: &mut EventLoopSteps,
    signal: Option<TranscriptReadSignal<'_>>,
) -> LedgerResult<Vec<LedgerRowDraft>> {
    let mut drafts = Vec::new();
    steps
        .try_for_each(messages, |message| {
            if let Some(signal) = signal {
                signal.check()?;
            }
            drafts.extend(frozen_draft_for(message, now)?);
            Ok::<_, Box<dyn std::error::Error>>(())
        })
        .await?;
    Ok(drafts)
}

fn imported_draft_for(
    row: ImportedRow,
    now: &impl Fn() -> LedgerResult<String>,
) -> LedgerResult<Vec<LedgerRowDraft>> {
    let ImportedRow {
        message,
        provider_meta,
        preamble_application,
    } = row;
    let at = draft_timestamp(&message, now)?;
    let content = match &message {
        ChatMessage::User(user) => Some(user.content.as_str()),
        ChatMessage::Assistant(assistant) => Some(assistant.content.as_str()),
        _ => None,
    };
    let user_input = matches!(&message, ChatMessage::User(user) if is_literal(user))
        || (matches!(message, ChatMessage::User(_)) && preamble_application.is_some());
    if !user_input && content.is_some_and(|content| content.contains(GARCON_ELEMENT_PREFIX)) {
        if let Some(transform) = extract_garcon_commands(&message) {
            let mut drafts = Vec::new();
            if let Some(message) = transform.message {
                drafts.push(provider_draft(
                    &at,
                    ChatMessage::Assistant(message),
                    provider_meta,
                ));
            }
            for command in transform.commands {
                drafts.push(request_notice(&at, &command)?);
            }
            return Ok(drafts);
        }
        if let ChatMessage::User(user) = &message
            && let Some(drafts) = imported_control_input(&user.content, &at, now, &user.timestamp)?
        {
            return Ok(drafts);
        }
    }
    match message {
        ChatMessage::User(user) => {
            let literal = is_literal(&user);
            let client_message_id = literal
                .then(|| user.metadata.as_ref()?.client_message_id.clone())
                .flatten()
                .filter(|id| !id.is_empty());
            // Literal inputs never carry interpreted preamble evidence.
            let preamble_application = preamble_application.filter(|_| !literal);
            let (preamble_boundary, preamble_prefix_receipt, mut drafts) =
                if let Some(evidence) = preamble_application {
                    let row = notice(
                        &at,
                        "Preambles applied",
                        json!({ "type": "preamble-application", "preambles": evidence.preambles }),
                    );
                    (Some(evidence.boundary), Some(evidence.receipt), vec![row])
                } else {
                    (None, None, Vec::new())
                };
            let mut draft = user_draft(at, user, client_message_id, provider_meta);
            if let LedgerRowData::UserInput { detail } = &mut draft.data {
                detail.preamble_boundary = preamble_boundary;
                detail.preamble_prefix_receipt = preamble_prefix_receipt;
            }
            drafts.push(draft);
            Ok(drafts)
        }
        ChatMessage::PermissionRequest(_)
        | ChatMessage::PermissionResolved(_)
        | ChatMessage::PermissionCancelled(_)
        | ChatMessage::PermissionExpired(_) => Ok(Vec::new()),
        other => Ok(vec![provider_draft(&at, other, provider_meta)]),
    }
}

fn imported_control_input(
    content: &str,
    at: &str,
    now: &impl Fn() -> LedgerResult<String>,
    timestamp: &str,
) -> LedgerResult<Option<Vec<LedgerRowDraft>>> {
    if let Some(rejection) = parse_garcon_command_rejection(content) {
        return Ok(Some(
            rejection
                .issues
                .iter()
                .map(|issue| {
                    notice(
                        at,
                        garcon_command_rejection_notice(issue.command.as_str()),
                        json!({"type": "garcon-command-rejection-input", "title": "Agent command"}),
                    )
                })
                .collect(),
        ));
    }
    if let Some(result) = parse_garcon_ticket_result(content) {
        let outcome = ticket_command_outcome(&serde_json::to_value(result)?);
        // The result parser validates the identity and outcome fields used by the notice.
        let typed = parse_ticket_command_outcome(&outcome).ok_or_else(|| {
            crate::errors::LedgerError::Schema("Invalid imported ticket command outcome".into())
        })?;
        let mut detail = outcome.into_value();
        detail["nativeResultInput"] = Value::Bool(true);
        return Ok(Some(vec![notice(
            at,
            ticket_command_notice_text(&typed),
            detail,
        )]));
    }
    if let Some(result) = parse_garcon_command_result(content) {
        let mut detail = serde_json::to_value(&result)?;
        detail["title"] = json!(agent_command_outcome_title(&result));
        detail["nativeResultInput"] = Value::Bool(true);
        return Ok(Some(vec![notice(
            at,
            agent_command_outcome_content(&result)?,
            detail,
        )]));
    }
    if let Some(received) = parse_garcon_message(content) {
        let at = if timestamp.is_empty() {
            now()?
        } else {
            timestamp.into()
        };
        let title = received.from_chat_id.as_ref().map_or_else(
            || "Inter-agent message".to_owned(),
            |id| format!("Message from chat {id}"),
        );
        return Ok(Some(vec![notice(
            &at,
            received.body,
            json!({"type": "inter-agent-message-received", "fromChatId": received.from_chat_id, "title": title}),
        )]));
    }
    if let Some(chat_id) = parse_chat_id_disclosure(content) {
        return Ok(Some(vec![notice(
            at,
            chat_id_disclosure_notice_content(&chat_id),
            json!({"type": "chat-id-disclosure", "title": CHAT_ID_DISCOVERY_NOTICE_TITLE}),
        )]));
    }
    Ok(None)
}

fn frozen_draft_for(
    message: ChatMessage,
    now: &impl Fn() -> LedgerResult<String>,
) -> LedgerResult<Option<LedgerRowDraft>> {
    use ChatMessage::*;
    let at = draft_timestamp(&message, now)?;
    Ok(Some(match message {
        User(user) => {
            let client_id = user
                .metadata
                .as_ref()
                .and_then(|meta| meta.upstream_request_id.clone());
            user_draft(at, user, client_id, None)
        }
        Assistant(_) | CommandOutput(_) | CommandResult(_) | Thinking(_) | ToolUse(_)
        | ToolResult(_) | Error(_) | Compaction(_) => provider_draft(&at, message, None),
        AgentSwitch(switch) => LedgerRowDraft {
            at,
            provider_meta: None,
            data: LedgerRowData::AgentSwitch {
                detail: LedgerAgentSwitchDetail {
                    from_agent_id: switch.from_agent_id,
                    from_executor_id: switch.from_executor_id.filter(|id| !id.is_empty()),
                    to_executor_id: switch.to_executor_id.filter(|id| !id.is_empty()),
                    to_agent_id: switch.to_agent_id,
                    from_model: switch.from_model,
                    to_model: switch.to_model,
                },
            },
        },
        Notice(message) => {
            let detail = match message.detail {
                Some(TranscriptNoticeDetail::PublicationGap) => {
                    let mut detail = json!({"type": "publication-gap"});
                    if let Some(title) = message.title.filter(|title| !title.is_empty()) {
                        detail["title"] = json!(title);
                    }
                    detail
                }
                Some(
                    detail @ (TranscriptNoticeDetail::CarryoverMigrationQuarantine { .. }
                    | TranscriptNoticeDetail::PreambleApplication { .. }),
                ) => serde_json::to_value(detail)?,
                _ => return Ok(None),
            };
            notice(&at, message.content, detail)
        }
        CliRow(_)
        | PermissionRequest(_)
        | PermissionResolved(_)
        | PermissionCancelled(_)
        | PermissionExpired(_) => return Ok(None),
    }))
}

fn draft_timestamp(
    message: &ChatMessage,
    now: &impl Fn() -> LedgerResult<String>,
) -> LedgerResult<String> {
    let timestamp = message_timestamp(message);
    if timestamp.is_empty() {
        now()
    } else {
        Ok(timestamp.into())
    }
}

fn is_literal(user: &UserMessage) -> bool {
    user.metadata.as_ref().and_then(|meta| meta.content_mode) == Some(ChatContentMode::Literal)
}

fn user_draft(
    at: String,
    message: UserMessage,
    client_message_id: Option<String>,
    provider_meta: Option<Opaque>,
) -> LedgerRowDraft {
    let attachments = message
        .images
        .iter()
        .flatten()
        .map(|image| AgentAttachment {
            kind: AgentAttachmentKind::Image,
            data: image.data.clone(),
            name: (!image.name.is_empty()).then(|| image.name.clone()),
            mime_type: image
                .mime_type
                .clone()
                .unwrap_or_else(|| "application/octet-stream".into()),
        })
        .collect();
    LedgerRowDraft {
        at,
        provider_meta,
        data: LedgerRowData::UserInput {
            detail: LedgerUserInputDetail {
                client_message_id,
                message,
                attachments,
                steer: false,
                preamble_boundary: None,
                preamble_prefix_receipt: None,
            },
        },
    }
}

fn provider_draft(at: &str, message: ChatMessage, provider_meta: Option<Opaque>) -> LedgerRowDraft {
    LedgerRowDraft {
        at: at.into(),
        provider_meta,
        data: LedgerRowData::ProviderRow { message },
    }
}
