//! Ports `common/garcon-agent-result.ts`.

use std::borrow::Cow;

use garcon_js::{
    json::{self, Opaque},
    trim,
};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};

use crate::chat_id::parse_chat_id;
use crate::chat_row_contracts::parse_chat_row_content;
use crate::command_request_validation::CommandRequestValidationError;
use crate::error_codes::{ErrorCode, is_error_code};
use crate::garcon_agent_request::{GarconAgentRequestOptions, parse_garcon_agent_request_options};
use crate::garcon_command_envelope::{
    GARCON_COMMAND_ENVELOPE_MAX_BYTES, escape_attribute, escape_garcon_xml_text,
    invalid_text_controls, parse_garcon_xml_envelope, positive_decimal,
};
use crate::garcon_command_results::{AgentCommandCorrelation, parse_command_correlation};

pub const GARCON_AGENT_OUTPUT_MAX_BYTES: usize = 48 * 1024;

macro_rules! wire_enum {
    ($name:ident, $($variant:ident => $wire:literal),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        #[serde(rename_all = "kebab-case")]
        pub enum $name { $($variant),+ }

        impl $name {
            fn parse(value: &Value) -> Option<Self> {
                match value.as_str()? { $($wire => Some(Self::$variant),)+ _ => None }
            }
        }
    };
}

wire_enum!(AgentChildRejectionReason,
    Disabled => "disabled", UnsupportedAgent => "unsupported-agent", UnknownProvider => "unknown-provider",
    AmbiguousProvider => "ambiguous-provider", AmbiguousModel => "ambiguous-model", UnknownModel => "unknown-model",
    UnsupportedPermissionMode => "unsupported-permission-mode", UnsupportedReasoningEffort => "unsupported-reasoning-effort",
    ProjectUnavailable => "project-unavailable", SourceUnavailable => "source-unavailable", ActionFailed => "action-failed",
    NotDelegated => "not-delegated", TargetUnavailable => "target-unavailable", Busy => "busy",
    InvalidConfiguration => "invalid-configuration",
);

pub const AGENT_CHILD_REJECTION_REASONS: &[&str] = &[
    "disabled",
    "unsupported-agent",
    "unknown-provider",
    "ambiguous-provider",
    "ambiguous-model",
    "unknown-model",
    "unsupported-permission-mode",
    "unsupported-reasoning-effort",
    "project-unavailable",
    "source-unavailable",
    "action-failed",
    "not-delegated",
    "target-unavailable",
    "busy",
    "invalid-configuration",
];

wire_enum!(AgentChildCompleteness, Complete => "complete", BestEffort => "best-effort");
wire_enum!(
    AgentChildOutputReason, NoFinalResponse => "no-final-response", TooLarge => "too-large",
    RetentionPressure => "retention-pressure", InvalidText => "invalid-text",
);
wire_enum!(AgentPreambleRejectionReason, SlashCommandBlocked => "slash-command-blocked", CompositionInvalid => "composition-invalid");
wire_enum!(AgentChildInterruptionReason, UserStop => "user-stop", ChatDeleted => "chat-deleted");
wire_enum!(AgentChildReceiptFailureReason, ReceiptUnavailable => "receipt-unavailable", ReceiptExpired => "receipt-expired");

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "availability", rename_all = "lowercase")]
pub enum AgentChildOutput {
    Available {
        completeness: AgentChildCompleteness,
        text: String,
    },
    Unavailable {
        reason: AgentChildOutputReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentChildAdmissionOutcome {
    Accepted {
        chat_id: String,
    },
    Rejected {
        reason: AgentChildRejectionReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_id: Option<String>,
    },
    PreambleRejected {
        chat_id: String,
        reason: AgentPreambleRejectionReason,
    },
    OutcomeUnknown {
        #[serde(skip_serializing_if = "Option::is_none")]
        chat_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentChildTerminalOutcome {
    Completed {
        chat_id: String,
        output: AgentChildOutput,
    },
    Failed {
        chat_id: String,
        #[serde(serialize_with = "serialize_error_code")]
        error_code: ErrorCode,
        output: AgentChildOutput,
    },
    Interrupted {
        chat_id: String,
        reason: AgentChildInterruptionReason,
        output: AgentChildOutput,
    },
    ResultUnavailable {
        chat_id: String,
        reason: AgentChildReceiptFailureReason,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum AgentChildOutcome {
    Admission(AgentChildAdmissionOutcome),
    Terminal(AgentChildTerminalOutcome),
}

fn serialize_error_code<S: Serializer>(code: &ErrorCode, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(code.as_str())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChildResultBase {
    #[serde(flatten)]
    pub request: GarconAgentRequestOptions,
    #[serde(flatten)]
    pub correlation: AgentCommandCorrelation,
    #[serde(flatten)]
    pub outcome: AgentChildOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum AgentChildOutcomeNoticeDetail {
    AgentStartOutcome(ChildResultBase),
    AgentResumeOutcome(ChildResultBase),
}

const BASE_KEYS: &[&str] = &[
    "type",
    "ref",
    "async",
    "requestViewId",
    "requestOrdinal",
    "status",
];
const ATTRIBUTES: &[(&str, &str)] = &[
    ("ref", "ref"),
    ("async", "async"),
    ("request-view-id", "requestViewId"),
    ("request-ordinal", "requestOrdinal"),
    ("status", "status"),
    ("chat-id", "chatId"),
    ("reason", "reason"),
    ("error-code", "errorCode"),
];
const OUTPUT_ATTRIBUTES: &[&str] = &["output", "completeness", "output-reason"];

fn parse_output(value: &Value) -> Option<AgentChildOutput> {
    let raw = value.as_object()?;
    match value["availability"].as_str()? {
        "available" => {
            let text = value["text"].as_str()?;
            let completeness = AgentChildCompleteness::parse(&value["completeness"])?;
            if raw
                .keys()
                .any(|key| !matches!(key.as_str(), "availability" | "completeness" | "text"))
                || invalid_text_controls(text)
                || text.len() > GARCON_AGENT_OUTPUT_MAX_BYTES
            {
                return None;
            }
            Some(AgentChildOutput::Available {
                completeness,
                text: text.into(),
            })
        }
        "unavailable"
            if raw
                .keys()
                .all(|key| matches!(key.as_str(), "availability" | "reason")) =>
        {
            Some(AgentChildOutput::Unavailable {
                reason: AgentChildOutputReason::parse(&value["reason"])?,
            })
        }
        _ => None,
    }
}

pub fn parse_agent_child_outcome(value: &Value) -> Option<AgentChildOutcomeNoticeDetail> {
    let raw = value.as_object()?;
    let start = match value["type"].as_str()? {
        "agent-start-outcome" => true,
        "agent-resume-outcome" => false,
        _ => return None,
    };
    let asynchronous = value["async"].as_bool()?;
    let request = parse_garcon_agent_request_options(&json!({
        "ref": value["ref"],
        "async": if asynchronous { "true" } else { "false" },
    }))?;
    let correlation = parse_command_correlation(value)?;
    let keys = |extra: &[&str]| {
        raw.keys()
            .all(|key| BASE_KEYS.contains(&key.as_str()) || extra.contains(&key.as_str()))
    };
    let chat_id = value["chatId"]
        .as_str()
        .filter(|_| parse_chat_id(&value["chatId"]).is_ok());
    let optional_chat_id = !raw.contains_key("chatId") || chat_id.is_some();
    let status = value["status"].as_str()?;
    use AgentChildAdmissionOutcome::*;
    let outcome = match status {
        "accepted" if keys(&["chatId"]) => AgentChildOutcome::Admission(Accepted {
            chat_id: chat_id?.into(),
        }),
        "rejected" if optional_chat_id && keys(&["chatId", "reason"]) => {
            AgentChildOutcome::Admission(Rejected {
                reason: AgentChildRejectionReason::parse(&value["reason"])?,
                chat_id: chat_id.map(str::to_owned),
            })
        }
        "preamble-rejected" if keys(&["chatId", "reason"]) => {
            AgentChildOutcome::Admission(PreambleRejected {
                reason: AgentPreambleRejectionReason::parse(&value["reason"])?,
                chat_id: chat_id?.into(),
            })
        }
        "outcome-unknown" if optional_chat_id && keys(&["chatId"]) => {
            AgentChildOutcome::Admission(OutcomeUnknown {
                chat_id: chat_id.map(str::to_owned),
            })
        }
        _ => {
            if asynchronous {
                return None;
            }
            let chat_id = chat_id?.to_owned();
            use AgentChildTerminalOutcome::*;
            let terminal = if status == "result-unavailable" && keys(&["chatId", "reason"]) {
                ResultUnavailable {
                    chat_id,
                    reason: AgentChildReceiptFailureReason::parse(&value["reason"])?,
                }
            } else {
                let output = parse_output(&value["output"])?;
                if matches!(status, "failed" | "interrupted")
                    && !matches!(
                        output,
                        AgentChildOutput::Unavailable {
                            reason: AgentChildOutputReason::NoFinalResponse
                        }
                    )
                {
                    return None;
                }
                match status {
                    "completed" if keys(&["chatId", "output"]) => Completed { chat_id, output },
                    "failed" if keys(&["chatId", "output", "errorCode"]) => Failed {
                        chat_id,
                        output,
                        error_code: is_error_code(&value["errorCode"])?,
                    },
                    "interrupted" if keys(&["chatId", "output", "reason"]) => Interrupted {
                        chat_id,
                        output,
                        reason: AgentChildInterruptionReason::parse(&value["reason"])?,
                    },
                    _ => return None,
                }
            };
            AgentChildOutcome::Terminal(terminal)
        }
    };
    let base = ChildResultBase {
        request,
        correlation,
        outcome,
    };
    let detail = if start {
        AgentChildOutcomeNoticeDetail::AgentStartOutcome(base)
    } else {
        AgentChildOutcomeNoticeDetail::AgentResumeOutcome(base)
    };
    let wire = serde_json::to_value(&detail).ok()?;
    (serialize_child_result(&wire).len() <= GARCON_COMMAND_ENVELOPE_MAX_BYTES).then_some(detail)
}

pub(crate) fn wire_attribute(name: &str, value: &Value) -> String {
    let value = value
        .as_str()
        .map_or_else(|| Cow::Owned(json::stringify(value)), Cow::Borrowed);
    format!("{name}=\"{}\"", escape_attribute(&value))
}

fn serialize_child_result(detail: &Value) -> String {
    let name = if detail["type"] == "agent-start-outcome" {
        "garcon-start-agent-result"
    } else {
        "garcon-resume-agent-result"
    };
    let mut attrs: Vec<_> = ATTRIBUTES
        .iter()
        .filter_map(|&(name, field)| detail.get(field).map(|v| wire_attribute(name, v)))
        .collect();
    let mut body = "";
    if let Some(output) = detail.get("output") {
        attrs.push(wire_attribute("output", &output["availability"]));
        if output["availability"] == "available" {
            attrs.push(wire_attribute("completeness", &output["completeness"]));
            body = output["text"].as_str().unwrap_or_default();
        } else {
            attrs.push(wire_attribute("output-reason", &output["reason"]));
        }
    }
    let attrs = attrs.join(" ");
    if body.is_empty() {
        format!("<{name} {attrs} />")
    } else {
        format!(
            "<{name} {attrs}>\n{}\n</{name}>",
            escape_garcon_xml_text(body)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Invalid child result")]
pub struct InvalidChildResult;

pub fn garcon_agent_result_content(detail: &Value) -> Result<String, InvalidChildResult> {
    let parsed = parse_agent_child_outcome(detail).ok_or(InvalidChildResult)?;
    let wire = serde_json::to_value(parsed).map_err(|_| InvalidChildResult)?;
    Ok(serialize_child_result(&wire))
}

pub fn bound_agent_child_result(detail: &Value) -> Opaque {
    let text = detail["output"]["text"].as_str();
    if detail["output"]["availability"] == "unavailable" || text.is_none() {
        return detail.clone().into();
    }
    let text = text.unwrap_or_default();
    let reason = if invalid_text_controls(text) {
        "invalid-text"
    } else if text.len() > GARCON_AGENT_OUTPUT_MAX_BYTES
        || serialize_child_result(detail).len() > GARCON_COMMAND_ENVELOPE_MAX_BYTES
    {
        "too-large"
    } else {
        return detail.clone().into();
    };
    let mut bounded = detail.clone();
    bounded["output"] = json!({"availability":"unavailable","reason":reason});
    bounded.into()
}

pub fn parse_garcon_agent_result(content: &str) -> Option<AgentChildOutcomeNoticeDetail> {
    let allowed: Vec<_> = ATTRIBUTES
        .iter()
        .map(|&(name, _)| name)
        .chain(OUTPUT_ATTRIBUTES.iter().copied())
        .collect();
    for (name, kind) in [
        ("garcon-start-agent-result", "agent-start-outcome"),
        ("garcon-resume-agent-result", "agent-resume-outcome"),
    ] {
        let Some(envelope) = parse_garcon_xml_envelope(trim(content), name, &allowed) else {
            continue;
        };
        let attr = |name| envelope.attributes.get(name).map(String::as_str);
        let mut raw = json!({"type":kind});
        for &(attribute, field) in ATTRIBUTES {
            if let Some(value) = attr(attribute) {
                raw[field] = match field {
                    "requestOrdinal" => json!(positive_decimal(value)?),
                    "async" => match value {
                        "true" => Value::Bool(true),
                        "false" => Value::Bool(false),
                        _ => return None,
                    },
                    _ => json!(value),
                };
            }
        }
        if attr("output") == Some("available") && attr("output-reason").is_none() {
            let text = envelope.body.strip_prefix('\n').unwrap_or(&envelope.body);
            let text = text.strip_suffix('\n').unwrap_or(text);
            raw["output"] =
                json!({"availability":"available","completeness":attr("completeness"),"text":text});
        } else if attr("output") == Some("unavailable")
            && attr("completeness").is_none()
            && envelope.self_closing
        {
            raw["output"] = json!({"availability":"unavailable","reason":attr("output-reason")});
        } else if OUTPUT_ATTRIBUTES
            .iter()
            .any(|attribute| attr(attribute).is_some())
            || !envelope.self_closing
        {
            return None;
        }
        return parse_agent_child_outcome(&raw);
    }
    None
}

pub fn agent_child_outcome_content(
    detail: &AgentChildOutcomeNoticeDetail,
) -> Result<String, CommandRequestValidationError> {
    let value = json!(detail);
    let subject = if value["type"] == "agent-start-outcome" {
        "Start"
    } else {
        "Resume"
    };
    let reference = value["ref"].as_str().unwrap_or_default();
    let status = value["status"].as_str().unwrap_or_default();
    let mut content = format!("{subject} agent ({reference}): {status}");
    if let Some(chat_id) = value["chatId"].as_str() {
        content.push_str(&format!("; chat {chat_id}"));
    }
    if let Some(reason) = value["reason"]
        .as_str()
        .or_else(|| value["errorCode"].as_str())
    {
        content.push_str(&format!(": {reason}"));
    }
    content.push('.');
    if let Some(text) = value["output"]["text"]
        .as_str()
        .filter(|text| !text.is_empty())
    {
        content.push_str("\n\n");
        content.push_str(text);
    }
    parse_chat_row_content(&json!(content)).map(str::to_owned)
}
