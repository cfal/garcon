//! Ports `common/garcon-schedule.ts`.

use std::sync::LazyLock;

use garcon_js::{Number, date_parse::date_parse, to_iso_string, trim, utf16};
use regex::Regex;
use serde::Serialize;

use crate::garcon_command_envelope::{
    decode_garcon_xml_text, escape_garcon_xml_text, parse_garcon_command_envelope,
};
use crate::garcon_command_text::normalize_garcon_command_body;
use crate::schedule_duration::{parse_schedule_duration, parse_schedule_interval};
use crate::scheduled_prompts::{
    SCHEDULED_PROMPT_LABEL_MAX_LENGTH, SCHEDULED_PROMPT_MAX_LENGTH, ScheduleForChatFirstRun,
    ScheduledPromptBusyBehavior, scheduled_prompt_fits_rendered_limit,
};

pub const GARCON_SCHEDULE_NAME: &str = "garcon-schedule";
const ACTION_OPEN: &str = "<garcon-schedule-action>";
const ACTION_CLOSE: &str = "</garcon-schedule-action>";
const EMPTY_ACTION: &str = "<garcon-schedule-action />";

static MINUTE_INSTANT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00)(?:\.000)?(?:Z|([+-])([0-9]{2}):([0-9]{2}))$",
    )
    .expect("valid ASCII instant syntax")
});

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ScheduleTag {
    Schedule,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GarconScheduleCommand {
    #[serde(rename = "type")]
    kind: ScheduleTag,
    pub first_run: ScheduleForChatFirstRun,
    pub interval_minutes: Option<u64>,
    pub end_at_utc: Option<String>,
    pub busy_behavior: ScheduledPromptBusyBehavior,
    pub body: String,
}

pub fn parse_garcon_schedule_instant(value: &str) -> Option<String> {
    let captures = MINUTE_INSTANT.captures(value)?;
    let wall = format!("{}.000Z", captures.get(1)?.as_str());
    let wall_ms = date_parse(&wall)?;
    if to_iso_string(wall_ms).ok()? != wall {
        return None;
    }
    let offset = if let Some(sign) = captures.get(2) {
        let hours: i64 = captures.get(3)?.as_str().parse().ok()?;
        let minutes: i64 = captures.get(4)?.as_str().parse().ok()?;
        if hours > 23 || minutes > 59 {
            return None;
        }
        (hours * 60 + minutes) * if sign.as_str() == "-" { -1 } else { 1 }
    } else {
        0
    };
    let instant = to_iso_string(wall_ms - offset * 60_000).ok()?;
    (!instant.starts_with(['+', '-'])).then_some(instant)
}

pub fn parse_garcon_schedule(content: &str) -> Option<GarconScheduleCommand> {
    let envelope = parse_garcon_command_envelope(
        content,
        GARCON_SCHEDULE_NAME,
        &["in", "at", "every", "until", "busy"],
    )?;
    let a = &envelope.attributes;
    let delay = a.get("in");
    let at = a.get("at");
    let every = a.get("every");
    let until = a.get("until");
    if delay.is_some() && at.is_some()
        || every.is_none() && (delay.is_none() && at.is_none() || until.is_some())
    {
        return None;
    }
    let interval_minutes = match every {
        Some(every) => Some(parse_schedule_interval(every).ok()?.minutes),
        None => None,
    };
    let end_at_utc = match until {
        Some(until) => Some(parse_garcon_schedule_instant(until)?),
        None => None,
    };
    let busy_behavior = match a.get("busy").map(String::as_str) {
        None | Some("queue") => ScheduledPromptBusyBehavior::Queue,
        Some("skip") => ScheduledPromptBusyBehavior::Skip,
        _ => return None,
    };
    let first_run = if let Some(delay) = delay {
        ScheduleForChatFirstRun::After {
            minutes: Number::from(parse_schedule_duration(delay).ok()?.minutes as f64),
        }
    } else if let Some(at) = at {
        let at_utc = parse_garcon_schedule_instant(at)?;
        if end_at_utc.as_ref().is_some_and(|until| until < &at_utc) {
            return None;
        }
        ScheduleForChatFirstRun::At { at_utc }
    } else {
        ScheduleForChatFirstRun::AfterInterval
    };
    let action = garcon_schedule_action_content(&envelope.body);
    if utf16::len(&action) > SCHEDULED_PROMPT_MAX_LENGTH
        || !scheduled_prompt_fits_rendered_limit(&action, None).ok()?
    {
        return None;
    }
    Some(GarconScheduleCommand {
        kind: ScheduleTag::Schedule,
        first_run,
        interval_minutes,
        end_at_utc,
        busy_behavior,
        body: envelope.body,
    })
}

pub fn garcon_schedule_action_content(body: &str) -> String {
    if trim(body).is_empty() {
        EMPTY_ACTION.to_owned()
    } else {
        format!(
            "{ACTION_OPEN}\n{}\n{ACTION_CLOSE}",
            escape_garcon_xml_text(body)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GarconScheduleAction {
    pub body: String,
}

pub fn parse_garcon_schedule_action(content: &str) -> Option<GarconScheduleAction> {
    let body = if content == EMPTY_ACTION {
        String::new()
    } else {
        let encoded = content
            .strip_prefix(ACTION_OPEN)?
            .strip_suffix(ACTION_CLOSE)?;
        let decoded = decode_garcon_xml_text(encoded)?;
        normalize_garcon_command_body(&decoded).to_owned()
    };
    Some(GarconScheduleAction { body })
}

pub fn scheduled_prompt_label(prompt: &str) -> String {
    let action = parse_garcon_schedule_action(prompt);
    let text = action
        .as_ref()
        .map_or(prompt, |action| action.body.as_str());
    let first_line = trim(text.split('\n').next().unwrap_or_default());
    utf16::truncate(first_line, SCHEDULED_PROMPT_LABEL_MAX_LENGTH).to_owned()
}
