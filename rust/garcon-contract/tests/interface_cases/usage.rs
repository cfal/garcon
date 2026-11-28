use std::fmt::Display;

use garcon_cases::{CaseError, javascript_number, markers, text, unknown};
use garcon_contract::usage::*;
use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    bun::bun_fixtures,
    helpers::{recorded_cases, typed},
};

fn wire(value: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&value).unwrap()).unwrap()
}

fn range_error(error: impl Display) -> Value {
    json!({"$":"error", "name":"RangeError", "message":error.to_string(), "properties":{}})
}

#[test]
fn usage_cases_match() {
    recorded_cases(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/usage"),
        "common/usage.ts",
        |function, args| {
            let string = |i: usize| {
                text(function, args.get(i))?.ok_or_else(|| CaseError::unhandled(function))
            };
            let input = || unknown(function, args.first());
            Ok(match function {
                "usageTotalTokens" => markers::number(usage_total_tokens(&typed(
                    function,
                    args,
                    parse_usage_token_totals,
                )?)),
                "isUsageWindowDays" => json!(is_usage_window_days(input()?.as_ref())),
                "isUsageDay" => json!(is_usage_day(input()?.as_ref())),
                "isUsageTimeZone" => json!(is_usage_time_zone(input()?.as_ref())),
                "usageDayFormatter" => match usage_day_formatter(string(0)?) {
                    Err(error) => range_error(error),
                    Ok(_) => return Err(CaseError::unhandled(function)),
                },
                "isUsageWindowInRange" => {
                    let request = garcon_js::json::from_str(&input()?.to_string())
                        .map_err(|_| CaseError::unhandled(function))?;
                    is_usage_window_in_range(&request, javascript_number(function, args.get(1))?)
                        .map_or_else(range_error, |result| json!(result))
                }
                "usageWindowLength" => markers::number(usage_window_length(string(0)?, string(1)?)),
                "enumerateUsageDays" => enumerate_usage_days(string(0)?, string(1)?)
                    .map_or_else(range_error, |days| json!(days)),
                "parseUsageReadRequest" => wire(parse_usage_read_request(input()?.as_ref())),
                "parseAgentUsageReport" => wire(parse_agent_usage_report(input()?.as_ref())),
                "parseUsageSummary" => wire(parse_usage_summary(input()?.as_ref())),
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}

#[test]
fn usage_link_payloads_and_calendar_days_match_bun() {
    let fixtures = garcon_js::json::parse(&bun_fixtures("usage-fixtures.ts")).unwrap();
    let days = fixtures["days"].as_array().unwrap();
    assert_eq!(days.len(), 112);
    for fixture in days {
        let zone = fixture["zone"].as_str().unwrap();
        let time = javascript_number("formatToParts", Some(&fixture["at"])).unwrap();
        let actual = match usage_day_formatter(zone) {
            Ok(formatter) => formatter
                .format(time)
                .map_or_else(range_error, |day| json!(day)),
            Err(error) => range_error(error),
        };
        assert_eq!(actual, fixture["result"], "{zone}, {time}");
    }
    let request_text = fixtures["request"].as_str().unwrap();
    let report_text = fixtures["report"].as_str().unwrap();
    let request: UsageReadRequest = garcon_js::json::from_str(request_text).unwrap();
    let report: AgentUsageReport = garcon_js::json::from_str(report_text).unwrap();
    assert_eq!(serde_json::to_string(&request).unwrap(), request_text);
    assert_eq!(serde_json::to_string(&report).unwrap(), report_text);
    assert_eq!(
        parse_usage_read_request(&garcon_js::json::parse(request_text).unwrap()),
        Some(request)
    );
    assert_eq!(
        parse_agent_usage_report(&garcon_js::json::parse(report_text).unwrap()),
        Some(report)
    );
}

#[test]
fn usage_report_rejects_untransportable_cost_after_json_and_enforces_bucket_cap() {
    let fixtures = garcon_js::json::parse(&bun_fixtures("usage-fixtures.ts")).unwrap();
    let report = garcon_js::json::parse(fixtures["report"].as_str().unwrap()).unwrap();
    let invalid_cost = garcon_js::json::parse(fixtures["invalidReport"].as_str().unwrap()).unwrap();
    assert!(invalid_cost["buckets"][0]["costUsd"].is_null());
    assert!(parse_agent_usage_report(&invalid_cost).is_none());

    let mut large = report;
    let bucket = large["buckets"][0].clone();
    large["buckets"] = Value::Array(vec![bucket.clone(); MAX_USAGE_BUCKETS]);
    assert_eq!(
        parse_agent_usage_report(&large).unwrap().buckets.len(),
        MAX_USAGE_BUCKETS
    );
    large["buckets"].as_array_mut().unwrap().push(bucket);
    assert!(parse_agent_usage_report(&large).is_none());
}
