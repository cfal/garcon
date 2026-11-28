//! Omits stored non-tool-use permission requests and malformed preamble
//! selection details that the original renders but its public parser rejects.

use std::sync::LazyLock;

use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_contract::{
    agent_start_progress::parse_agent_start_progress_notice,
    ask_user_question_response::normalize_ask_user_question_decision_response,
    chat_command_contracts::PermissionDecisionResponse,
    chat_types::{
        AgentSwitchMessage, ChatMessage, CliRowMessage, PermissionCancelledMessage,
        PermissionExpiredMessage, PermissionRequestMessage, PermissionResolvedMessage,
        TranscriptNoticeMessage,
    },
    chat_view::TranscriptMessage,
    cli_presentation::is_cli_presentation,
    transcript_notice_details::{TranscriptNoticeDetail, parse_transcript_notice_detail},
};
use garcon_js::Number;
use serde_json::Value;

use crate::contracts::{
    LedgerNoticeDetail, LedgerPermissionLifecycle, LedgerPermissionTool, LedgerRow, LedgerRowData,
    project_ledger_agent_command_outcome, project_ledger_ticket_command_outcome,
};

static LOGGER: LazyLock<ScopedLogger> = LazyLock::new(|| create_logger("ledger:presentation"));

pub fn ledger_rows_to_messages(chat_id: &str, rows: &[LedgerRow]) -> Vec<ChatMessage> {
    rows.iter()
        .filter_map(|row| ledger_row_to_message(chat_id, row))
        .collect()
}

pub fn ledger_rows_to_transcript_messages(
    chat_id: &str,
    rows: &[LedgerRow],
) -> Vec<TranscriptMessage> {
    rows.iter()
        .filter_map(|row| {
            ledger_row_to_message(chat_id, row).map(|message| TranscriptMessage {
                ordinal: Number(row.ordinal as f64),
                message,
            })
        })
        .collect()
}

pub fn ledger_row_to_message(chat_id: &str, row: &LedgerRow) -> Option<ChatMessage> {
    ledger_row_to_message_with_logger(chat_id, row, &*LOGGER)
}

fn ledger_row_to_message_with_logger(
    chat_id: &str,
    row: &LedgerRow,
    logger: &dyn Logger,
) -> Option<ChatMessage> {
    project(row, || {
        logger.warn(&format!(
        "Omitting stored permission request with a non-tool-use requested tool; chat {chat_id:?}, view {:?}, ordinal {}",
        row.view_id.as_str(), row.ordinal,
    ))
    })
}

fn project(row: &LedgerRow, warn_omitted_request: impl FnOnce()) -> Option<ChatMessage> {
    use LedgerPermissionLifecycle::{Cancelled, Expired, Requested, Resolved};
    use LedgerRowData::*;
    let timestamp = &row.at;
    Some(match &row.data {
        UserInput { detail } => {
            let mut message = detail.message.clone();
            if let Some(id) = detail
                .client_message_id
                .as_ref()
                .filter(|id| !id.is_empty())
            {
                message
                    .metadata
                    .get_or_insert_default()
                    .stamp_client_message_id(id.clone());
            }
            ChatMessage::User(message)
        }
        ProviderRow { message } => message.clone(),
        Notice { message, detail } => match detail {
            LedgerNoticeDetail::CliRow(detail) => ChatMessage::CliRow(CliRowMessage {
                timestamp: timestamp.clone(),
                content: message.clone(),
                presentation: {
                    is_cli_presentation(detail.presentation.as_value())?;
                    detail.presentation.clone()
                },
                format: detail.format,
                title: detail.title.clone(),
                disclosure: detail.disclosure,
            }),
            LedgerNoticeDetail::PreambleSelectionChanged(detail) => {
                ChatMessage::Notice(TranscriptNoticeMessage {
                    timestamp: timestamp.clone(),
                    content: message.clone(),
                    title: None,
                    detail: parse_transcript_notice_detail(&serde_json::json!({
                        "type": "preamble-selection-changed", "preambles": detail.preambles,
                    })),
                })
            }
            LedgerNoticeDetail::Other(detail) => {
                let detail = detail.as_value();
                if is_private_notice(detail) {
                    return None;
                }
                let title = detail["title"].as_str();
                let (title, public) = if detail["type"] == "agent-start-progress" {
                    let mut detail = detail.clone();
                    if let Some(fields) = detail.as_object_mut() {
                        fields.shift_remove("title");
                    }
                    (
                        title,
                        parse_agent_start_progress_notice(&detail)
                            .map(TranscriptNoticeDetail::AgentStartProgress),
                    )
                } else {
                    (
                        title.filter(|text| !text.is_empty()),
                        project_ledger_agent_command_outcome(detail)
                            .map(TranscriptNoticeDetail::AgentCommandOutcome)
                            .or_else(|| {
                                project_ledger_ticket_command_outcome(detail)
                                    .map(TranscriptNoticeDetail::TicketCommandOutcome)
                            })
                            .or_else(|| parse_transcript_notice_detail(detail)),
                    )
                };
                ChatMessage::Notice(TranscriptNoticeMessage {
                    timestamp: timestamp.clone(),
                    content: message.clone(),
                    detail: public,
                    title: title.map(str::to_owned),
                })
            }
        },
        AgentSwitch { detail } => ChatMessage::AgentSwitch(AgentSwitchMessage {
            timestamp: timestamp.clone(),
            from_agent_id: detail.from_agent_id.clone(),
            to_agent_id: detail.to_agent_id.clone(),
            from_model: detail.from_model.clone(),
            to_model: detail.to_model.clone(),
            from_executor_id: detail.from_executor_id.clone(),
            to_executor_id: detail.to_executor_id.clone(),
        }),
        PermissionRequested { lifecycle } => {
            let Requested {
                permission_occurrence_id,
                requested_tool,
                reason,
                ..
            } = lifecycle
            else {
                return None;
            };
            let LedgerPermissionTool::ToolUse(tool) = requested_tool else {
                warn_omitted_request();
                return None;
            };
            ChatMessage::PermissionRequest(PermissionRequestMessage {
                timestamp: timestamp.clone(),
                permission_occurrence_id: permission_occurrence_id.clone(),
                requested_tool: tool.as_ref().clone(),
                reason: reason.clone(),
            })
        }
        PermissionResolved { lifecycle } => {
            let Resolved {
                permission_occurrence_id,
                decision,
            } = lifecycle
            else {
                return None;
            };
            let question_response = match &decision.response {
                Some(PermissionDecisionResponse::Provider(value)) => {
                    normalize_ask_user_question_decision_response(value.as_value())
                }
                Some(PermissionDecisionResponse::Structured(response)) => Some(response.clone()),
                None => None,
            };
            ChatMessage::PermissionResolved(PermissionResolvedMessage {
                timestamp: timestamp.clone(),
                permission_occurrence_id: permission_occurrence_id.clone(),
                allowed: decision.allow,
                question_response,
            })
        }
        PermissionCancelled {
            lifecycle:
                Cancelled {
                    permission_occurrence_id,
                    ..
                },
        } => ChatMessage::PermissionCancelled(PermissionCancelledMessage {
            timestamp: timestamp.clone(),
            permission_occurrence_id: permission_occurrence_id.clone(),
            reason: Some(Value::String("cancelled".into()).into()),
        }),
        PermissionExpired {
            lifecycle: Expired {
                permission_occurrence_id,
            },
        } => ChatMessage::PermissionExpired(PermissionExpiredMessage {
            timestamp: timestamp.clone(),
            permission_occurrence_id: permission_occurrence_id.clone(),
        }),
        Session { .. }
        | RunEnded { .. }
        | PermissionCancelled { .. }
        | PermissionExpired { .. } => return None,
    })
}

fn is_private_notice(detail: &Value) -> bool {
    matches!(
        detail["type"].as_str(),
        Some(
            "chat-id-request"
                | "inter-agent-send-request"
                | "agent-start-request"
                | "agent-resume-request"
                | "agent-stop-request"
                | "agent-schedule-request"
                | "ticket-command-request"
        )
    )
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use garcon_base::log::{LogLevel, LogMethod, Sink};

    use super::*;
    use crate::codec::{StoredLedgerRow, decode_ledger_row};

    #[derive(Default)]
    struct Warnings(RefCell<Vec<String>>);

    impl Sink for Warnings {
        fn write(&self, method: LogMethod, line: &str) {
            assert_eq!(method, LogMethod::Warn);
            self.0.borrow_mut().push(line.into());
        }
    }

    #[test]
    fn an_omitted_permission_request_warns_once_with_only_the_chat_and_row_address() {
        let row = decode_ledger_row(&StoredLedgerRow {
            view_id: "synthetic-view".into(), ordinal: Number(5.0),
            kind: "permission-requested".into(), at: "2026-11-28T09:00:00.000Z".into(),
            client_message_id: None,
            payload_json: r#"{"providerMeta":null,"value":{"kind":"requested","incarnation":"private-permission-id","requestedTool":{"type":"tool-result","timestamp":"ts","toolId":"private-tool-id","content":"private tool result"},"options":[],"reason":"private reason"}}"#.into(),
        }).unwrap();
        let warnings = Warnings::default();
        let logger = ScopedLogger::with_sink("ledger:presentation", LogLevel::Info, &warnings);
        assert!(ledger_row_to_message_with_logger("ledger", &row, &logger).is_none());
        assert_eq!(
            *warnings.0.borrow(),
            [
                "[ledger:presentation] Omitting stored permission request with a non-tool-use requested tool; chat \"ledger\", view \"synthetic-view\", ordinal 5"
            ]
        );
    }
}
