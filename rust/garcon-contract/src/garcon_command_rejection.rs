//! Ports `common/garcon-command-rejection.ts`.

use garcon_js::{
    is_safe_integer,
    json::{as_number, from_str, stringify},
    trim,
};
use serde::Serialize;
use serde_json::Value;

use crate::garcon_command_envelope::{
    GARCON_ENVELOPE_COMMANDS, GarconEnvelopeCommand, escape_garcon_xml_text,
    parse_garcon_command_envelope,
};
use crate::garcon_command_results::is_command_uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GarconCommandIssueReason {
    Malformed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GarconCommandIssueEdge {
    Leading,
    Trailing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct GarconCommandIssue {
    pub command: GarconEnvelopeCommand,
    pub reason: GarconCommandIssueReason,
    pub edge: GarconCommandIssueEdge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarconCommandRejection {
    pub source_view_id: String,
    pub source_ordinal: u64,
    pub issues: Vec<GarconCommandIssue>,
    pub message: String,
}

pub const TICKET_COMMAND_REJECTION_GUIDANCE: &str = concat!(
    "Check required ticket attributes, field values, and valid JSON where required. ",
    "For JSON bodies, serialize the JSON first, then XML-escape the body once: & -> &amp;, < -> &lt;, > -> &gt;. ",
    "Keep the outer command tags unchanged. For example, <T> becomes &lt;T&gt; and && becomes &amp;&amp;.",
);

const PROMPT_GUIDANCE: &str = concat!(
    "Use a ref matching [A-Za-z0-9][A-Za-z0-9._-]{0,63}, lowercase true/false flags, ",
    "and a nonblank literal prompt of at most 48 KiB in an envelope of at most 64 KiB. ",
    "Do not XML-escape the prompt. Balance Garcon command tags and complete comments (<!-- -->), ",
    "CDATA (<![CDATA[ ]]>), and processing instructions (<? ?>). Do not embed an unmatched outer closing tag. ",
    "Keep Garcon tags balanced in subsequent commands in the same message.",
);

pub fn garcon_command_issue_guidance(command: &str) -> String {
    match command {
        "start-agent" => format!("Check double-quoted start attributes; selecting agent or provider requires model. {PROMPT_GUIDANCE}"),
        "resume-agent" => format!("Only ref, a 16-digit chat-id, and optional async are allowed. {PROMPT_GUIDANCE}"),
        "stop-agent" => "Use a self-closing command with a 16-digit chat-id and optional remove=\"true|false\"; no body or other attributes.".to_owned(),
        "send-message" => concat!(
            "Use double-quoted to then hide-sender=\"true|false\", 1-16 unique 16-digit recipients, ",
            "and a nonblank literal body of at most 60 KiB. Do not XML-escape the body.",
        ).to_owned(),
        "schedule" => concat!(
            "Check schedule attributes and minute-aligned dates or ordered whole d/h/m durations. ",
            "XML-escape & and < in body text and use lowercase busy=\"queue|skip\".",
        ).to_owned(),
        _ => TICKET_COMMAND_REJECTION_GUIDANCE.to_owned(),
    }
}

pub fn garcon_command_rejection_guidance<'a>(
    commands: impl IntoIterator<Item = &'a str>,
) -> String {
    let mut unique = Vec::new();
    for command in commands {
        let guidance = garcon_command_issue_guidance(command);
        if !unique.contains(&guidance) {
            unique.push(guidance);
        }
    }
    format!(
        "These command candidates were rejected before execution. {} Retry only the rejected commands; independently valid commands may already have executed.",
        unique.join(" "),
    )
}

pub fn garcon_command_rejection_notice(command: &str) -> String {
    let guidance = garcon_command_issue_guidance(command);
    format!("Garcon could not parse a {command} command. Not executed. {guidance}")
}

pub fn garcon_command_rejection_content(rejection: &Value) -> String {
    let body = escape_garcon_xml_text(&stringify(rejection));
    format!("<garcon-command-rejected>\n{body}\n</garcon-command-rejected>")
}

pub fn parse_garcon_command_rejection(content: &str) -> Option<GarconCommandRejection> {
    let envelope =
        parse_garcon_command_envelope(trim(content), "garcon-command-rejected", &[] as &[&str])?;
    if envelope.self_closing {
        return None;
    }
    let value: Value = from_str(&envelope.body).ok()?;
    let raw = value.as_object()?;
    if raw.keys().any(|key| {
        !matches!(
            key.as_str(),
            "sourceViewId" | "sourceOrdinal" | "issues" | "message"
        )
    }) {
        return None;
    }
    let source_view_id = raw
        .get("sourceViewId")?
        .as_str()
        .filter(|value| is_command_uuid(value))?;
    let source_ordinal = as_number(raw.get("sourceOrdinal")?)?;
    if !is_safe_integer(source_ordinal) || source_ordinal < 1.0 {
        return None;
    }
    let message = raw
        .get("message")?
        .as_str()
        .filter(|message| !trim(message).is_empty() && message.len() <= 2048)?;
    let issues = raw
        .get("issues")?
        .as_array()
        .filter(|issues| (1..=2).contains(&issues.len()))?;
    let issues = issues.iter().map(parse_issue).collect::<Option<Vec<_>>>()?;
    Some(GarconCommandRejection {
        source_view_id: source_view_id.to_owned(),
        source_ordinal: source_ordinal as u64,
        issues,
        message: message.to_owned(),
    })
}

fn parse_issue(value: &Value) -> Option<GarconCommandIssue> {
    let issue = value.as_object()?;
    if issue
        .keys()
        .any(|key| !matches!(key.as_str(), "command" | "reason" | "edge"))
    {
        return None;
    }
    let name = issue.get("command")?.as_str()?;
    let command = GARCON_ENVELOPE_COMMANDS
        .iter()
        .copied()
        .find(|command| command.as_str() == name)?;
    if issue.get("reason")? != "malformed" {
        return None;
    }
    let edge = match issue.get("edge")?.as_str()? {
        "leading" => GarconCommandIssueEdge::Leading,
        "trailing" => GarconCommandIssueEdge::Trailing,
        _ => return None,
    };
    Some(GarconCommandIssue {
        command,
        reason: GarconCommandIssueReason::Malformed,
        edge,
    })
}
