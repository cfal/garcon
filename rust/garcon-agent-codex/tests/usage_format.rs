use garcon_agent_codex::usage_format::{CodexUsageFormat, CodexUsageState, parse_codex_usage_line};
use garcon_agents_common::usage::usage_record::{TranscriptUsageFormat, UsageLine};
use garcon_cases::{CaseError, replay, text, unknown};
use garcon_js::json::{from_slice, stringify};
use serde::Serialize;
use serde_json::{Value, json};

fn serialized(value: &impl Serialize) -> Value {
    from_slice(&serde_json::to_vec(value).unwrap()).unwrap()
}

fn snapshot(state: &CodexUsageState) -> Value {
    let mut snapshot = serialized(state);
    let turn = &mut snapshot["turn"];
    if !turn.is_null() {
        *turn = json!([turn["id"], turn["model"], turn["speed"], turn["hasContext"]]);
    }
    snapshot
}

fn parsed(line: Option<UsageLine>) -> Value {
    match line {
        Some(UsageLine::Record(record)) => serialized(&record),
        Some(UsageLine::Malformed(malformed)) => {
            json!({"malformed":true,"timestampMs":malformed.timestamp_ms})
        }
        None => Value::Null,
    }
}

#[test]
fn recorded_codex_usage_lines_match() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/usage-format"),
        |function, args| match function {
            "createCodexUsageState" => Ok(serialized(&CodexUsageFormat.create_state())),
            "parseCodexUsageLine" => {
                let line = text(function, args.first())?.unwrap();
                let mut state: CodexUsageState =
                    serde_json::from_value(unknown(function, args.get(1))?.into_owned())
                        .expect("recorded parser state");
                Ok(parsed(parse_codex_usage_line(line, &mut state)))
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[test]
fn codex_usage_tracks_baselines_and_clone_branches_through_whole_scans() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/usage-format-scan"),
        |function, args| {
            if function != "scanUsage" {
                return Err(CaseError::unhandled(function));
            }
            let format = CodexUsageFormat;
            let run = |index, state: &mut _| -> Result<Vec<Value>, CaseError> {
                let lines = unknown(function, args.get(index))?;
                Ok(lines
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|line| {
                        let buffer;
                        let line = match line.as_str() {
                            Some(text) => text,
                            None => {
                                buffer = stringify(line);
                                &buffer
                            }
                        };
                        parsed(format.parse_line(line, state).unwrap())
                    })
                    .collect())
            };
            let mut state = format.create_state();
            let initial = run(0, &mut state)?;
            let mut copy = format.clone_state(&state);
            let left = run(1, &mut state)?;
            let right = run(2, &mut copy)?;
            Ok(json!({
                "markers": format.line_markers(),
                "initial": initial,
                "left": left,
                "right": right,
                "state": snapshot(&state),
                "copy": snapshot(&copy)
            }))
        },
    );
}
