use garcon_cases::{CaseError, javascript_number, markers, text};
use garcon_contract::schedule_duration::*;
use garcon_js::date_parse::date_parse;
use serde_json::{Value, json};

fn format_duration(result: ScheduleDurationResult) -> Value {
    match result {
        Ok(duration) => json!(duration),
        Err(error) => json!({"ok":false,"error":error}),
    }
}

#[test]
fn schedule_duration_cases_match() {
    crate::helpers::recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/schedule-duration"
        ),
        "common/schedule-duration.ts",
        |function, args| {
            let token =
                || text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function));
            match function {
                "parseScheduleDuration" => Ok(format_duration(parse_schedule_duration(token()?))),
                "parseScheduleInterval" => Ok(format_duration(parse_schedule_interval(token()?))),
                "scheduleInRunAt" => {
                    let date = args
                        .first()
                        .filter(|value| markers::kind(value) == Some("date"))
                        .and_then(|value| value["value"].as_str())
                        .and_then(date_parse)
                        .ok_or_else(|| CaseError::undeliverable("invalid Date marker"))?;
                    schedule_in_run_at(date, javascript_number(function, args.get(1))?)
                        .map(|iso| json!(iso))
                        .map_err(|error| CaseError::new("RangeError", error.to_string()))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}
