use garcon_js::{Number, is_integer, json::as_number, number_to_string, trim};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeupRequest {
    pub delay_seconds: Number,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timer_condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_timing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub noop: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<Number>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronRequest {
    pub expression: String,
    pub prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurring: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub durable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_timing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delay_seconds: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timer_condition: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum ToolScheduleRequest {
    Wakeup(WakeupRequest),
    Cron(CronRequest),
    List,
    Delete {
        #[serde(rename = "jobId")]
        job_id: String,
    },
    StopLoop,
}

pub fn has_schedule_prompt(request: &ToolScheduleRequest) -> bool {
    prompt(request).is_some()
}

fn prompt(request: &ToolScheduleRequest) -> Option<&str> {
    match request {
        ToolScheduleRequest::Wakeup(wakeup) => Some(&wakeup.prompt),
        ToolScheduleRequest::Cron(cron) => Some(&cron.prompt),
        _ => None,
    }
}

fn optional<T>(
    value: &Map<String, Value>,
    key: &str,
    parse: impl FnOnce(&Value) -> Option<T>,
) -> Option<Option<T>> {
    value
        .get(key)
        .map_or(Some(None), |value| parse(value).map(Some))
}

fn valid_timer_condition(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    (text.is_empty() || !trim(text).is_empty()).then(|| text.to_owned())
}

fn string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn empty_string(value: &Value) -> Option<String> {
    value.as_str()?.is_empty().then(String::new)
}

fn zero(value: &Value) -> Option<Number> {
    as_number(value).filter(|number| *number == 0.0).map(Number)
}

pub fn parse_tool_schedule_request(value: &Value) -> Option<ToolScheduleRequest> {
    let value = value.as_object()?;
    match value.get("action")?.as_str()? {
        "wakeup" => {
            let delay_seconds =
                as_number(value.get("delaySeconds")?).filter(|number| number.is_finite())?;
            let prompt = value.get("prompt").and_then(string)?;
            let timer_condition = optional(value, "timerCondition", valid_timer_condition)?;
            let daemon = optional(value, "daemon", Value::as_bool)?;
            let noop = optional(value, "noop", Value::as_bool)?;
            let exact_timing = optional(value, "exactTiming", |value| {
                value.as_bool().filter(|boolean| !boolean)
            })?;
            let expression = optional(value, "expression", empty_string)?;
            let max_iterations = optional(value, "maxIterations", zero)?;
            let reason = optional(value, "reason", string)?;
            Some(ToolScheduleRequest::Wakeup(WakeupRequest {
                delay_seconds: Number(delay_seconds),
                prompt,
                timer_condition,
                daemon,
                exact_timing,
                reason,
                noop,
                expression,
                max_iterations,
            }))
        }
        "cron" => {
            let expression = value.get("expression")?.as_str()?;
            if trim(expression).is_empty() {
                return None;
            }
            let prompt = value.get("prompt").and_then(string)?;
            let recurring = optional(value, "recurring", Value::as_bool)?;
            let exact_timing = optional(value, "exactTiming", Value::as_bool)?;
            let durable = optional(value, "durable", Value::as_bool)?;
            let daemon = optional(value, "daemon", Value::as_bool)?;
            let delay_seconds = optional(value, "delaySeconds", zero)?;
            let timer_condition = optional(value, "timerCondition", empty_string)?;
            let max_iterations = optional(value, "maxIterations", |value| {
                as_number(value)
                    .filter(|number| is_integer(*number) && *number >= 0.0)
                    .map(Number)
            })?;
            Some(ToolScheduleRequest::Cron(CronRequest {
                expression: expression.into(),
                prompt,
                recurring,
                durable,
                daemon,
                max_iterations,
                exact_timing,
                delay_seconds,
                timer_condition,
            }))
        }
        "delete" => {
            let job_id = value.get("jobId")?.as_str()?;
            (!trim(job_id).is_empty()).then(|| ToolScheduleRequest::Delete {
                job_id: job_id.into(),
            })
        }
        "list" => Some(ToolScheduleRequest::List),
        "stop-loop" => Some(ToolScheduleRequest::StopLoop),
        _ => None,
    }
}

pub fn tool_schedule_title(request: &ToolScheduleRequest) -> String {
    match request {
        ToolScheduleRequest::Wakeup(request) => {
            let seconds = request.delay_seconds.0;
            let minutes = seconds / 60.0;
            let (amount, unit) = if is_integer(minutes) && minutes > 0.0 {
                (minutes, "minute")
            } else {
                (seconds, "second")
            };
            let plural = if amount == 1.0 { "" } else { "s" };
            format!(
                "Request wakeup in {} {unit}{plural}",
                number_to_string(amount)
            )
        }
        ToolScheduleRequest::Cron(request) => {
            let recurring = match request.recurring {
                Some(true) => "recurring ",
                Some(false) => "one-time ",
                None => "",
            };
            format!("Request {recurring}cron: {}", request.expression)
        }
        ToolScheduleRequest::List => "List scheduled jobs".into(),
        ToolScheduleRequest::Delete { job_id } => format!("Delete scheduled job: {job_id}"),
        ToolScheduleRequest::StopLoop => "Stop loop wakeups".into(),
    }
}

pub fn tool_schedule_options(request: &ToolScheduleRequest) -> Vec<String> {
    let mut lines = Vec::new();
    let exact_timing = match request {
        ToolScheduleRequest::Wakeup(request) => {
            if let Some(timer_condition) = request.timer_condition.as_deref() {
                lines.push(match timer_condition {
                    "" => "Timer condition: default".into(),
                    "never" => "Incoming messages do not cancel this timer.".into(),
                    "any" => "Cancel on any incoming message.".into(),
                    _ => format!("Cancel on message from: {timer_condition}"),
                });
            }
            if let Some(reason) = &request.reason {
                lines.push(format!("Reason: {reason}"));
            }
            if let Some(noop) = request.noop {
                lines.push(format!("No changes reported: {noop}"));
            }
            if let Some(daemon) = request.daemon {
                lines.push(format!("Daemon requested: {daemon}"));
            }
            request.exact_timing
        }
        ToolScheduleRequest::Cron(request) => {
            if let Some(Number(max)) = request.max_iterations {
                let max = if max == 0.0 {
                    "unlimited".into()
                } else {
                    number_to_string(max)
                };
                lines.push(format!("Maximum iterations: {max}"));
            }
            if let Some(daemon) = request.daemon {
                lines.push(format!("Continue after task ends: {daemon}"));
            }
            if let Some(durable) = request.durable {
                lines.push(format!("Persistence requested: {durable}"));
            }
            request.exact_timing
        }
        _ => None,
    };
    if let Some(exact_timing) = exact_timing {
        lines.push(format!("Exact timing: {exact_timing}"));
    }
    lines
}

pub fn tool_schedule_details(request: &ToolScheduleRequest) -> String {
    let Some(prompt) = prompt(request) else {
        return String::new();
    };
    let mut lines = tool_schedule_options(request);
    lines.push(format!("Prompt: {prompt}"));
    lines.join("\n")
}

pub fn describe_tool_schedule(request: &ToolScheduleRequest) -> String {
    let mut title = tool_schedule_title(request);
    let details = tool_schedule_details(request);
    if !details.is_empty() {
        title.push('\n');
        title.push_str(&details);
    }
    title
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn preserves_inactive_provider_options_without_accepting_active_values() {
        let wakeup = json!({
            "action":"wakeup", "delaySeconds":60.0, "prompt":"synthetic",
            "timerCondition":"", "exactTiming":false, "expression":"", "maxIterations":0,
            "extra":true
        });
        let request = parse_tool_schedule_request(&wakeup).unwrap();
        assert_eq!(
            serde_json::to_string(&request).unwrap(),
            r#"{"action":"wakeup","delaySeconds":60,"prompt":"synthetic","timerCondition":"","exactTiming":false,"expression":"","maxIterations":0}"#,
        );
        assert_eq!(
            describe_tool_schedule(&request),
            "Request wakeup in 1 minute\nTimer condition: default\nExact timing: false\nPrompt: synthetic",
        );
        for (field, value) in [
            ("timerCondition", json!(" \t")),
            ("exactTiming", json!(true)),
            ("expression", json!("* * * * *")),
            ("maxIterations", json!(1)),
            ("noop", Value::Null),
        ] {
            let mut invalid = wakeup.clone();
            invalid[field] = value;
            assert!(parse_tool_schedule_request(&invalid).is_none(), "{field}");
        }
    }

    #[test]
    fn renders_cron_options_in_order_and_recognizes_unlimited_iterations() {
        let request = parse_tool_schedule_request(&json!({
            "action":"cron", "expression":" * * * * * ", "prompt":"synthetic",
            "daemon":true, "durable":false, "recurring":false,
            "maxIterations":0, "exactTiming":true, "delaySeconds":0, "timerCondition":""
        }))
        .unwrap();
        assert_eq!(
            tool_schedule_title(&request),
            "Request one-time cron:  * * * * * "
        );
        assert_eq!(
            tool_schedule_options(&request),
            [
                "Maximum iterations: unlimited",
                "Continue after task ends: true",
                "Persistence requested: false",
                "Exact timing: true",
            ]
        );
        assert!(has_schedule_prompt(&request));
        assert!(!has_schedule_prompt(&ToolScheduleRequest::List));
    }

    #[test]
    fn does_not_round_a_fractional_delay_or_preserve_extraneous_action_fields() {
        let request = parse_tool_schedule_request(&json!({
            "action":"wakeup", "delaySeconds":0.0000001, "prompt":""
        }))
        .unwrap();
        assert_eq!(
            tool_schedule_title(&request),
            "Request wakeup in 1e-7 seconds"
        );
        assert_eq!(
            parse_tool_schedule_request(&json!({"action":"list", "prompt":"ignored"})),
            Some(ToolScheduleRequest::List),
        );
    }
}
