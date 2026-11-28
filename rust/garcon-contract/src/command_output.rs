//! Ports `common/command-output.ts`.

use garcon_js::{is_safe_integer, utf16};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutputContext {
    pub executor_id: String,
    pub project_path: String,
}

pub fn is_command_output_data(value: &Value) -> bool {
    let Some(fields) = value.as_object() else {
        return false;
    };
    let channel = fields.get("channel").and_then(Value::as_str);
    let format = fields.get("format").and_then(Value::as_str);
    fields
        .get("commandId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty())
        && fields.get("content").is_some_and(Value::is_string)
        && fields
            .get("offset")
            .and_then(Value::as_f64)
            .is_some_and(|offset| is_safe_integer(offset) && offset >= 0.0)
        && matches!(channel, Some("stdout" | "stderr"))
        && matches!(format, Some("plain" | "markdown"))
        && (channel != Some("stderr") || format == Some("plain"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CommandWorkingDirectory {
    Reported { path: String },
    Withheld,
    Unavailable { reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandOutcomeKind {
    Finished,
    Failed,
    Interrupted,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandCapture {
    Complete,
    Truncated,
    Incomplete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandOutcome {
    pub outcome: CommandOutcomeKind,
    pub exit_code: Option<u64>,
    pub signal: Option<String>,
    pub capture: CommandCapture,
    pub cwd: CommandWorkingDirectory,
}

pub fn is_clean_command_success(result: &CommandOutcome) -> bool {
    result.outcome == CommandOutcomeKind::Finished
        && result.exit_code == Some(0)
        && result.signal.is_none()
        && result.capture == CommandCapture::Complete
        && !matches!(result.cwd, CommandWorkingDirectory::Unavailable { .. })
}

pub fn parse_command_output_context(value: &Value) -> Option<CommandOutputContext> {
    let fields = value.as_object()?;
    let executor_id = fields.get("executorId")?.as_str()?;
    let project_path = fields.get("projectPath")?.as_str()?;
    if executor_id.is_empty() || !is_non_empty_path(project_path) {
        return None;
    }
    Some(CommandOutputContext {
        executor_id: executor_id.into(),
        project_path: project_path.into(),
    })
}

fn is_non_empty_path(path: &str) -> bool {
    !path.is_empty() && !path.contains('\0')
}

pub fn parse_command_working_directory(value: &Value) -> Option<CommandWorkingDirectory> {
    let fields = value.as_object()?;
    match fields.get("kind")?.as_str()? {
        "reported" => {
            let path = fields.get("path")?.as_str()?;
            is_non_empty_path(path).then(|| CommandWorkingDirectory::Reported { path: path.into() })
        }
        "withheld" => Some(CommandWorkingDirectory::Withheld),
        "unavailable" => {
            let reason = fields.get("reason")?.as_str()?;
            (utf16::len(reason) <= 4096).then(|| CommandWorkingDirectory::Unavailable {
                reason: reason.into(),
            })
        }
        _ => None,
    }
}

pub fn parse_command_outcome(value: &Value) -> Option<CommandOutcome> {
    let fields = value.as_object()?;
    let outcome = match fields.get("outcome")?.as_str()? {
        "finished" => CommandOutcomeKind::Finished,
        "failed" => CommandOutcomeKind::Failed,
        "interrupted" => CommandOutcomeKind::Interrupted,
        "unknown" => CommandOutcomeKind::Unknown,
        _ => return None,
    };
    let exit_code = match fields.get("exitCode")? {
        Value::Null => None,
        value => {
            let code = value.as_f64()?;
            if !is_safe_integer(code) || code < 0.0 {
                return None;
            }
            Some(code as u64)
        }
    };
    let signal = match fields.get("signal")? {
        Value::Null => None,
        value => Some(value.as_str()?.into()),
    };
    let capture = match fields.get("capture")?.as_str()? {
        "complete" => CommandCapture::Complete,
        "truncated" => CommandCapture::Truncated,
        "incomplete" => CommandCapture::Incomplete,
        _ => return None,
    };
    let cwd = parse_command_working_directory(fields.get("cwd")?)?;
    Some(CommandOutcome {
        outcome,
        exit_code,
        signal,
        capture,
        cwd,
    })
}

pub fn command_outcome_text(result: &CommandOutcome) -> String {
    let mut lines = vec![match result.outcome {
        CommandOutcomeKind::Finished => "Completed".into(),
        CommandOutcomeKind::Interrupted => "Interrupted".into(),
        CommandOutcomeKind::Unknown => "Outcome unknown".into(),
        CommandOutcomeKind::Failed => result
            .exit_code
            .map_or_else(|| "Command failed".into(), |code| format!("Exit {code}")),
    }];
    if let Some(signal) = result.signal.as_deref().filter(|signal| !signal.is_empty()) {
        lines.push(format!("Signal: {signal}"));
    }
    match result.capture {
        CommandCapture::Incomplete => lines.push("Output capture incomplete".into()),
        CommandCapture::Truncated => lines.push("Output truncated".into()),
        CommandCapture::Complete => {}
    }
    if let CommandWorkingDirectory::Unavailable { reason } = &result.cwd {
        lines.push(format!("Working directory not captured: {reason}"));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_malformed_output_instead_of_degrading_to_assistant_text() {
        let sample = json!({"commandId":"command-1","content":"text","offset":0,"channel":"stderr","format":"plain"});
        assert!(is_command_output_data(&sample));
        for (field, replacement) in [
            ("format", json!("markdown")),
            ("channel", json!("control")),
            ("commandId", json!("")),
            ("offset", json!(-1)),
            ("offset", json!(0.5)),
            ("offset", json!("0")),
            ("offset", Value::Null),
        ] {
            let mut changed = sample.clone();
            changed[field] = replacement;
            assert!(!is_command_output_data(&changed));
        }
        assert_eq!(
            parse_command_output_context(&json!({"executorId":"local","projectPath":""})),
            None
        );
    }

    #[test]
    fn keeps_wire_paths_executor_native_rather_than_enforcing_posix_syntax() {
        for path in [
            "/workspace",
            "C:/workspace",
            "C:\\workspace",
            "\\\\host\\share\\workspace",
        ] {
            assert_eq!(
                parse_command_working_directory(&json!({"kind":"reported","path":path})),
                Some(CommandWorkingDirectory::Reported {
                    path: path.to_owned()
                })
            );
        }
        for path in ["", "/workspace\0invalid"] {
            assert_eq!(
                parse_command_working_directory(&json!({"kind":"reported","path":path})),
                None
            );
        }
    }

    #[test]
    fn treats_a_withheld_working_directory_as_reported_without_disclosing_it() {
        let record = json!({"outcome":"finished","exitCode":0,"signal":null,"capture":"complete",
            "cwd":{"kind":"withheld","path":"/workspace"}});
        let typed = parse_command_outcome(&record).unwrap();
        assert_eq!(typed.cwd, CommandWorkingDirectory::Withheld);
        assert!(is_clean_command_success(&typed));
        assert_eq!(command_outcome_text(&typed), "Completed");
    }

    #[test]
    fn appends_signal_capture_and_cwd_diagnostics_in_their_original_order() {
        let record = json!({"outcome":"failed","exitCode":3,"signal":"SIGTERM","capture":"incomplete",
            "cwd":{"kind":"unavailable","reason":"Synthetic missing report"}});
        let typed = parse_command_outcome(&record).unwrap();
        assert_eq!(
            command_outcome_text(&typed),
            "Exit 3\nSignal: SIGTERM\nOutput capture incomplete\nWorking directory not captured: Synthetic missing report"
        );
    }

    #[test]
    fn distinguishes_successful_tail_retention_from_capture_failure() {
        let record = json!({"outcome":"finished","exitCode":0,"signal":null,"capture":"truncated",
            "cwd":{"kind":"reported","path":"/workspace/project"}});
        let typed = parse_command_outcome(&record).unwrap();
        assert!(!is_clean_command_success(&typed));
        assert_eq!(command_outcome_text(&typed), "Completed\nOutput truncated");
    }
}
