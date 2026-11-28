//! Ports `common/garcon-command-results.ts`.

use garcon_js::{is_safe_integer, json::as_number, trim};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::command_request_validation::CommandRequestValidationError;
use crate::garcon_agent_result::{
    AgentChildOutcomeNoticeDetail, InvalidChildResult, agent_child_outcome_content,
    garcon_agent_result_content, parse_agent_child_outcome, parse_garcon_agent_result,
    wire_attribute,
};
use crate::garcon_command_envelope::{parse_garcon_command_envelope, positive_decimal};
use crate::scheduled_prompts::{
    ScheduledPromptBusyBehavior, is_minute_aligned_iso, is_scheduled_prompt_interval_minutes,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandCorrelation {
    pub request_view_id: String,
    pub request_ordinal: u64,
}

pub(crate) fn is_command_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
            }
        })
}

pub(crate) fn parse_command_correlation(raw: &Value) -> Option<AgentCommandCorrelation> {
    let request_view_id = raw["requestViewId"]
        .as_str()
        .filter(|value| is_command_uuid(value))?;
    let ordinal = as_number(&raw["requestOrdinal"])?;
    if !is_safe_integer(ordinal) || ordinal < 1.0 {
        return None;
    }
    Some(AgentCommandCorrelation {
        request_view_id: request_view_id.to_owned(),
        request_ordinal: ordinal as u64,
    })
}

macro_rules! schedule_failure_reasons {
    ($($variant:ident => $wire:literal),+ $(,)?) => {
        pub const AGENT_SCHEDULE_FAILURE_REASONS: &[&str] = &[$($wire),+];

        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        #[serde(rename_all = "kebab-case")]
        pub enum AgentScheduleFailureReason { $($variant),+ }

        impl AgentScheduleFailureReason {
            fn parse(value: &Value) -> Option<Self> {
                match value.as_str()? { $($wire => Some(Self::$variant),)+ _ => None }
            }

            fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire,)+ }
            }
        }
    };
}

schedule_failure_reasons!(
    Disabled => "disabled", SourceUnavailable => "source-unavailable", InvalidSchedule => "invalid-schedule",
    LimitReached => "limit-reached", ActionFailed => "action-failed",
);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentScheduleOutcome {
    Created {
        schedule_id: String,
        next_run_at: String,
        interval_minutes: Option<u64>,
        end_at_utc: Option<String>,
        busy_behavior: ScheduledPromptBusyBehavior,
    },
    Failed {
        reason: AgentScheduleFailureReason,
    },
    OutcomeUnknown {
        #[serde(skip_serializing_if = "Option::is_none")]
        schedule_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AgentScheduleOutcomeTag {
    AgentScheduleOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentScheduleOutcomeNoticeDetail {
    #[serde(rename = "type")]
    kind: AgentScheduleOutcomeTag,
    #[serde(flatten)]
    pub correlation: AgentCommandCorrelation,
    #[serde(flatten)]
    pub outcome: AgentScheduleOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum AgentCommandOutcomeNoticeDetail {
    Child(AgentChildOutcomeNoticeDetail),
    Schedule(AgentScheduleOutcomeNoticeDetail),
}

const BASE_KEYS: &[&str] = &["type", "requestViewId", "requestOrdinal", "status"];
const RESULT_ATTRIBUTES: &[(&str, &str)] = &[
    ("request-view-id", "requestViewId"),
    ("request-ordinal", "requestOrdinal"),
    ("status", "status"),
    ("reason", "reason"),
    ("schedule-id", "scheduleId"),
    ("next-run-at", "nextRunAt"),
    ("interval-minutes", "intervalMinutes"),
    ("until", "endAtUtc"),
    ("busy", "busyBehavior"),
];

pub fn parse_agent_command_outcome(value: &Value) -> Option<AgentCommandOutcomeNoticeDetail> {
    let raw = value.as_object()?;
    if matches!(
        value["type"].as_str(),
        Some("agent-start-outcome" | "agent-resume-outcome")
    ) {
        return parse_agent_child_outcome(value).map(AgentCommandOutcomeNoticeDetail::Child);
    }
    let correlation = parse_command_correlation(value)?;
    if value["type"] != "agent-schedule-outcome" {
        return None;
    }
    let only_keys = |extra: &[&str]| {
        raw.keys()
            .all(|key| BASE_KEYS.contains(&key.as_str()) || extra.contains(&key.as_str()))
    };
    let outcome = match value["status"].as_str()? {
        "created" => {
            let schedule_id = value["scheduleId"]
                .as_str()
                .filter(|value| is_command_uuid(value))?;
            if !is_minute_aligned_iso(&value["nextRunAt"]) {
                return None;
            }
            let next_run_at = value["nextRunAt"].as_str()?;
            let interval = raw.get("intervalMinutes")?;
            let interval_minutes = if interval.is_null() {
                None
            } else if is_scheduled_prompt_interval_minutes(interval) {
                Some(as_number(interval)? as u64)
            } else {
                return None;
            };
            let end = raw.get("endAtUtc")?;
            let end_at_utc = if end.is_null() {
                None
            } else {
                if interval_minutes.is_none() || !is_minute_aligned_iso(end) {
                    return None;
                }
                Some(end.as_str().filter(|&text| text >= next_run_at)?.to_owned())
            };
            let busy_behavior = match value["busyBehavior"].as_str()? {
                "queue" => ScheduledPromptBusyBehavior::Queue,
                "skip" => ScheduledPromptBusyBehavior::Skip,
                _ => return None,
            };
            if !only_keys(&[
                "scheduleId",
                "nextRunAt",
                "intervalMinutes",
                "endAtUtc",
                "busyBehavior",
            ]) {
                return None;
            }
            AgentScheduleOutcome::Created {
                schedule_id: schedule_id.to_owned(),
                next_run_at: next_run_at.to_owned(),
                interval_minutes,
                end_at_utc,
                busy_behavior,
            }
        }
        "failed" if only_keys(&["reason"]) => AgentScheduleOutcome::Failed {
            reason: AgentScheduleFailureReason::parse(&value["reason"])?,
        },
        "outcome-unknown" if only_keys(&["scheduleId"]) => AgentScheduleOutcome::OutcomeUnknown {
            schedule_id: if let Some(schedule_id) = raw.get("scheduleId") {
                Some(
                    schedule_id
                        .as_str()
                        .filter(|value| is_command_uuid(value))?
                        .to_owned(),
                )
            } else {
                None
            },
        },
        _ => return None,
    };
    Some(AgentCommandOutcomeNoticeDetail::Schedule(
        AgentScheduleOutcomeNoticeDetail {
            kind: AgentScheduleOutcomeTag::AgentScheduleOutcome,
            correlation,
            outcome,
        },
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum InvalidCommandResult {
    #[error(transparent)]
    Child(#[from] InvalidChildResult),
    #[error("Invalid agent command outcome")]
    Schedule,
}

pub fn garcon_command_result_content(value: &Value) -> Result<String, InvalidCommandResult> {
    if value["type"] != "agent-schedule-outcome" {
        return Ok(garcon_agent_result_content(value)?);
    }
    let parsed = parse_agent_command_outcome(value).ok_or(InvalidCommandResult::Schedule)?;
    let value = serde_json::to_value(parsed).map_err(|_| InvalidCommandResult::Schedule)?;
    let attributes: Vec<_> = RESULT_ATTRIBUTES
        .iter()
        .filter_map(|&(attribute, field)| {
            value
                .get(field)
                .filter(|v| !v.is_null())
                .map(|v| wire_attribute(attribute, v))
        })
        .collect();
    Ok(format!(
        "<garcon-schedule-result {} />",
        attributes.join(" ")
    ))
}

pub fn parse_garcon_command_result(content: &str) -> Option<AgentCommandOutcomeNoticeDetail> {
    if let Some(child) = parse_garcon_agent_result(content) {
        return Some(AgentCommandOutcomeNoticeDetail::Child(child));
    }
    let allowed: Vec<_> = RESULT_ATTRIBUTES.iter().map(|&(attr, _)| attr).collect();
    let envelope =
        parse_garcon_command_envelope(trim(content), "garcon-schedule-result", &allowed)?;
    if !envelope.self_closing {
        return None;
    }
    let mut raw = json!({"type":"agent-schedule-outcome"});
    for &(attribute, field) in RESULT_ATTRIBUTES {
        if let Some(value) = envelope.attributes.get(attribute) {
            raw[field] = match field {
                "requestOrdinal" | "intervalMinutes" => json!(positive_decimal(value)?),
                _ => json!(value),
            };
        }
    }
    if raw["status"] == "created" {
        for field in ["intervalMinutes", "endAtUtc"] {
            if raw.get(field).is_none() {
                raw[field] = Value::Null;
            }
        }
    }
    parse_agent_command_outcome(&raw)
}

pub fn agent_command_outcome_title(detail: &AgentCommandOutcomeNoticeDetail) -> &'static str {
    match detail {
        AgentCommandOutcomeNoticeDetail::Child(
            AgentChildOutcomeNoticeDetail::AgentStartOutcome(_),
        ) => "Start agent",
        AgentCommandOutcomeNoticeDetail::Child(
            AgentChildOutcomeNoticeDetail::AgentResumeOutcome(_),
        ) => "Resume agent",
        AgentCommandOutcomeNoticeDetail::Schedule(_) => "Schedule prompt",
    }
}

pub fn agent_command_outcome_content(
    detail: &AgentCommandOutcomeNoticeDetail,
) -> Result<String, CommandRequestValidationError> {
    Ok(match detail {
        AgentCommandOutcomeNoticeDetail::Child(child) => agent_child_outcome_content(child)?,
        AgentCommandOutcomeNoticeDetail::Schedule(detail) => match &detail.outcome {
            AgentScheduleOutcome::Created {
                schedule_id,
                next_run_at,
                ..
            } => format!("Scheduled prompt {schedule_id} for {next_run_at}."),
            AgentScheduleOutcome::Failed { reason } => {
                format!("Could not schedule prompt: {}.", reason.as_str())
            }
            AgentScheduleOutcome::OutcomeUnknown { schedule_id } => {
                let target = schedule_id
                    .as_ref()
                    .map_or_else(String::new, |id| format!(" for {id}"));
                format!(
                    "Schedule creation outcome is unknown{target}. Inspect scheduled prompts before retrying."
                )
            }
        },
    })
}
