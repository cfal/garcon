//! Ports `common/garcon-commands.ts`.

use std::collections::{HashMap, HashSet};

use garcon_js::{trim, utf16};
use serde::Serialize;
use serde_json::Value;

use crate::chat_id::{ChatId, parse_chat_id};
use crate::chat_types::{AssistantMessage, ChatMessage};
use crate::garcon_command_envelope::{
    GarconEnvelopeCommand, GarconEnvelopeScanner, GarconEnvelopeSpan, ascii_starts_at,
    garcon_envelope_opener_end, unit_space,
};
pub use crate::garcon_command_rejection::{
    GarconCommandIssue, GarconCommandIssueEdge, GarconCommandIssueReason,
};
use crate::garcon_command_text::normalize_garcon_command_body;
use crate::garcon_resume_agent::{GarconResumeAgentCommand, parse_garcon_resume_agent};
use crate::garcon_schedule::{GarconScheduleCommand, parse_garcon_schedule};
use crate::garcon_start_agent::{GarconStartAgentCommand, parse_garcon_start_agent};
use crate::garcon_stop_agent::{GarconStopAgentCommand, parse_garcon_stop_agent};
use crate::garcon_ticket_command::{GarconTicketCommand, parse_garcon_ticket_command};

pub const GARCON_GET_CHAT_ID: &str = "<garcon-get-chat-id />";
pub const GARCON_SEND_MESSAGE_PREFIX: &str = "<garcon-send-message";
pub const GARCON_SEND_MESSAGE_CLOSE: &str = "</garcon-send-message>";
pub const GARCON_MESSAGE_OPEN: &str = "<garcon-message>";
pub const GARCON_MESSAGE_CLOSE: &str = "</garcon-message>";
pub const INTER_AGENT_MESSAGE_NOTICE_TITLE: &str = "Inter-agent message";
pub const MAX_GARCON_MESSAGE_RECIPIENTS: usize = 16;
pub const GARCON_MESSAGE_BODY_MAX_BYTES: usize = 60 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum GarconEdgeCommand {
    GetChatId,
    SendMessage {
        recipients: Vec<ChatId>,
        hide_sender: bool,
        body: String,
    },
    #[serde(untagged)]
    StartAgent(GarconStartAgentCommand),
    #[serde(untagged)]
    ResumeAgent(GarconResumeAgentCommand),
    #[serde(untagged)]
    StopAgent(GarconStopAgentCommand),
    #[serde(untagged)]
    Schedule(GarconScheduleCommand),
    #[serde(untagged)]
    Ticket(Box<GarconTicketCommand>),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GarconCommandTransform {
    pub message: Option<AssistantMessage>,
    pub commands: Vec<GarconEdgeCommand>,
    pub issues: Vec<GarconCommandIssue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarconReceivedMessage {
    pub from_chat_id: Option<ChatId>,
    pub body: String,
}

enum ParsedCommandEdge {
    Valid {
        command: GarconEdgeCommand,
        start: usize,
        end: usize,
    },
    Malformed {
        candidate_start: usize,
        command: GarconEnvelopeCommand,
    },
}

pub fn extract_garcon_commands(message: &ChatMessage) -> Option<GarconCommandTransform> {
    let ChatMessage::Assistant(message) = message else {
        return None;
    };
    if message.questions.is_some() {
        return None;
    }

    let mut scanner = GarconEnvelopeScanner::new(&message.content);
    let mut start = 0;
    let mut end = scanner.content_units().len();
    let parse_end = trim_end_index(scanner.content_units(), start, end);
    let mut leading = Vec::new();
    let mut trailing = Vec::new();
    let mut issues = Vec::new();
    let mut malformed_starts = HashSet::new();

    while start < end {
        let Some(parsed) = parse_leading_command(&mut scanner, start, parse_end) else {
            break;
        };
        match parsed {
            ParsedCommandEdge::Malformed {
                candidate_start,
                command,
            } => {
                record_issue(
                    &mut issues,
                    &mut malformed_starts,
                    command,
                    candidate_start,
                    GarconCommandIssueEdge::Leading,
                );
                break;
            }
            ParsedCommandEdge::Valid { command, end, .. } => {
                leading.push(command);
                start = trim_start_index(scanner.content_units(), end, parse_end);
            }
        }
    }

    for parsed in parse_trailing_commands(&mut scanner, start, parse_end) {
        match parsed {
            ParsedCommandEdge::Malformed {
                candidate_start,
                command,
            } => {
                record_issue(
                    &mut issues,
                    &mut malformed_starts,
                    command,
                    candidate_start,
                    GarconCommandIssueEdge::Trailing,
                );
                break;
            }
            ParsedCommandEdge::Valid {
                command,
                start: command_start,
                ..
            } => {
                trailing.push(command);
                end = trim_end_index(scanner.content_units(), start, command_start);
            }
        }
    }

    if leading.is_empty() && trailing.is_empty() && issues.is_empty() {
        return None;
    }
    let remainder = String::from_utf16_lossy(&scanner.content_units()[start..end]);
    Some(GarconCommandTransform {
        message: (!trim(&remainder).is_empty()).then(|| AssistantMessage {
            timestamp: message.timestamp.clone(),
            content: remainder,
            questions: None,
        }),
        commands: leading
            .into_iter()
            .chain(trailing.into_iter().rev())
            .collect(),
        issues,
    })
}

pub fn garcon_message_content(from_chat_id: Option<&ChatId>, body: &str) -> String {
    let open = from_chat_id.map_or_else(
        || GARCON_MESSAGE_OPEN.to_owned(),
        |id| format!("<garcon-message from=\"{id}\">"),
    );
    format!("{open}\n{body}\n{GARCON_MESSAGE_CLOSE}")
}

pub fn parse_garcon_message(content: &str) -> Option<GarconReceivedMessage> {
    let value = trim(content);
    if !value.ends_with(GARCON_MESSAGE_CLOSE) {
        return None;
    }
    let opener_end = utf16::index_of(value, ">")? as isize + 1;
    let opener = utf16::slice(value, 0, Some(opener_end));
    let from_chat_id = if opener == GARCON_MESSAGE_OPEN {
        None
    } else {
        let from = opener
            .strip_prefix("<garcon-message from=\"")?
            .strip_suffix("\">")?;
        if from.contains('"') {
            return None;
        }
        Some(parse_chat_id(&Value::String(from.to_owned())).ok()?)
    };
    let raw_body = utf16::slice(
        value,
        opener_end,
        Some(-(GARCON_MESSAGE_CLOSE.len() as isize)),
    );
    let body = normalize_garcon_command_body(raw_body);
    is_valid_body(body).then(|| GarconReceivedMessage {
        from_chat_id,
        body: body.to_owned(),
    })
}

fn parse_leading_command(
    scanner: &mut GarconEnvelopeScanner,
    start: usize,
    end: usize,
) -> Option<ParsedCommandEdge> {
    let marker_end = start + GARCON_GET_CHAT_ID.len();
    if marker_end <= end && ascii_starts_at(scanner.content_units(), start, GARCON_GET_CHAT_ID) {
        return Some(ParsedCommandEdge::Valid {
            command: GarconEdgeCommand::GetChatId,
            start,
            end: marker_end,
        });
    }
    let span = scanner.span_at(start as f64, end as f64)?;
    Some(parse_envelope_span(scanner.content_units(), &span))
}

fn parse_envelope_span(content: &[u16], span: &GarconEnvelopeSpan) -> ParsedCommandEdge {
    let start = span.start.0 as usize;
    let malformed = || ParsedCommandEdge::Malformed {
        command: span.command,
        candidate_start: start,
    };
    let Some(end) = span.end else {
        return malformed();
    };
    let envelope = String::from_utf16_lossy(&content[start..end]);
    let command = match span.command.as_str() {
        "start-agent" => parse_garcon_start_agent(&envelope).map(GarconEdgeCommand::StartAgent),
        "resume-agent" => parse_garcon_resume_agent(&envelope).map(GarconEdgeCommand::ResumeAgent),
        "stop-agent" => parse_garcon_stop_agent(&envelope).map(GarconEdgeCommand::StopAgent),
        "schedule" => parse_garcon_schedule(&envelope).map(GarconEdgeCommand::Schedule),
        "send-message" => {
            let opener_end = garcon_envelope_opener_end(&envelope, 0.0);
            parse_send_message(
                utf16::slice(&envelope, 0, Some(opener_end)),
                utf16::slice(
                    &envelope,
                    opener_end,
                    Some(-(GARCON_SEND_MESSAGE_CLOSE.len() as isize)),
                ),
            )
        }
        _ => parse_garcon_ticket_command(&envelope)
            .map(|command| GarconEdgeCommand::Ticket(Box::new(command))),
    };
    command.map_or_else(malformed, |command| ParsedCommandEdge::Valid {
        command,
        start,
        end,
    })
}

fn parse_trailing_commands(
    scanner: &mut GarconEnvelopeScanner,
    start: usize,
    mut end: usize,
) -> Vec<ParsedCommandEdge> {
    let mut trailing_chains = HashMap::new();
    let scan = scanner.spans_with_scanner(start, end, |scanner, span| {
        is_trailing_command_chain(scanner, span.start.0 as usize, end, &mut trailing_chains)
    });
    if let Some(unclosed) = scan.spans.iter().find(|span| span.end.is_none()) {
        return vec![ParsedCommandEdge::Malformed {
            command: unclosed.command,
            candidate_start: unclosed.start.0 as usize,
        }];
    }
    if scan.open_fence {
        return Vec::new();
    }

    let content = scanner.content_units();
    let mut trailing = Vec::new();
    let mut spans = scan.spans.as_slice();
    while start < end {
        while spans
            .last()
            .is_some_and(|last| last.start.0 as usize >= end)
        {
            spans = &spans[..spans.len() - 1];
        }
        let Some(parsed) = parse_trailing_command(content, start, end, spans.last()) else {
            break;
        };
        match parsed {
            ParsedCommandEdge::Malformed { .. } => {
                trailing.push(parsed);
                break;
            }
            ParsedCommandEdge::Valid {
                start: command_start,
                ..
            } => {
                end = trim_end_index(content, start, command_start);
                trailing.push(parsed);
            }
        }
    }
    trailing
}

fn parse_trailing_command(
    content: &[u16],
    start: usize,
    end: usize,
    last: Option<&GarconEnvelopeSpan>,
) -> Option<ParsedCommandEdge> {
    if let Some(last) = last.filter(|span| span.end == Some(end)) {
        return Some(parse_envelope_span(content, last));
    }
    if let Some(marker_start) = end.checked_sub(GARCON_GET_CHAT_ID.len())
        && marker_start >= start
        && (marker_start == start || content[marker_start - 1] == u16::from(b'\n'))
        && ascii_starts_at(content, marker_start, GARCON_GET_CHAT_ID)
        && last.is_none_or(|last| last.end.is_some_and(|end| end <= marker_start))
    {
        return Some(ParsedCommandEdge::Valid {
            command: GarconEdgeCommand::GetChatId,
            start: marker_start,
            end,
        });
    }
    if let Some(last) = last {
        let parsed = parse_envelope_span(content, last);
        if matches!(parsed, ParsedCommandEdge::Malformed { .. }) {
            return Some(parsed);
        }
        let closer = format!("</garcon-{}>", last.command.as_str());
        if end - start >= closer.len() && ascii_starts_at(content, end - closer.len(), &closer) {
            return Some(ParsedCommandEdge::Malformed {
                command: last.command,
                candidate_start: last.start.0 as usize,
            });
        }
    }
    None
}

fn is_trailing_command_chain(
    scanner: &mut GarconEnvelopeScanner,
    start: usize,
    end: usize,
    cache: &mut HashMap<usize, bool>,
) -> bool {
    let mut visited = Vec::new();
    let mut cursor = start;
    let mut removable = true;
    while cursor < end {
        if let Some(cached) = cache.get(&cursor) {
            removable = *cached;
            break;
        }
        visited.push(cursor);
        let Some(ParsedCommandEdge::Valid {
            end: command_end, ..
        }) = parse_leading_command(scanner, cursor, end)
        else {
            removable = false;
            break;
        };
        let content = scanner.content_units();
        cursor = trim_start_index(content, command_end, end);
        if cursor < end && content[cursor - 1] != u16::from(b'\n') {
            removable = false;
            break;
        }
    }
    for position in visited {
        cache.insert(position, removable);
    }
    removable
}

fn parse_send_message(opener: &str, raw_body: &str) -> Option<GarconEdgeCommand> {
    let opener = opener
        .strip_prefix(GARCON_SEND_MESSAGE_PREFIX)?
        .strip_prefix(" to=\"")?;
    let (to, hide_sender) = opener.split_once("\" hide-sender=\"")?;
    let hide_sender = match hide_sender {
        "true\">" => true,
        "false\">" => false,
        _ => return None,
    };
    if to.contains('"') || raw_body.contains(GARCON_SEND_MESSAGE_CLOSE) {
        return None;
    }
    let recipients = parse_recipients(to)?;
    let body = normalize_garcon_command_body(raw_body);
    is_valid_body(body).then(|| GarconEdgeCommand::SendMessage {
        recipients,
        hide_sender,
        body: body.to_owned(),
    })
}

fn parse_recipients(value: &str) -> Option<Vec<ChatId>> {
    let mut recipients = Vec::new();
    let mut seen = HashSet::new();
    for candidate in value.split(',') {
        let trimmed = trim(candidate);
        let chat_id = parse_chat_id(&Value::String(trimmed.to_owned())).ok()?;
        if seen.insert(chat_id.clone()) {
            recipients.push(chat_id);
            if recipients.len() > MAX_GARCON_MESSAGE_RECIPIENTS {
                return None;
            }
        }
    }
    Some(recipients)
}

fn is_valid_body(value: &str) -> bool {
    !trim(value).is_empty() && value.len() <= GARCON_MESSAGE_BODY_MAX_BYTES
}

fn trim_start_index(content: &[u16], start: usize, end: usize) -> usize {
    content
        .get(start..end)
        .unwrap_or_default()
        .iter()
        .position(|&unit| !unit_space(unit))
        .map_or(end, |position| start + position)
}

fn trim_end_index(content: &[u16], start: usize, end: usize) -> usize {
    content
        .get(start..end)
        .unwrap_or_default()
        .iter()
        .rposition(|&unit| !unit_space(unit))
        .map_or(start, |position| start + position + 1)
}

fn record_issue(
    issues: &mut Vec<GarconCommandIssue>,
    starts: &mut HashSet<usize>,
    command: GarconEnvelopeCommand,
    candidate_start: usize,
    edge: GarconCommandIssueEdge,
) {
    if starts.insert(candidate_start) {
        issues.push(GarconCommandIssue {
            command,
            reason: GarconCommandIssueReason::Malformed,
            edge,
        });
    }
}
