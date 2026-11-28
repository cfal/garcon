use std::{fs, path::Path, rc::Rc};

use garcon_agents_common::usage::{
    transcript_usage_history::create_transcript_usage_history,
    transcript_usage_scanner::TranscriptUsageScannerOptions,
    usage_aggregator::UsageAggregator,
    usage_record::{
        MalformedUsage, NativeUsageTokenTotals, TranscriptUsageFormat, UsageLine, UsageRecord,
        UsageSpeed, parse_timestamp_ms, token_count,
    },
};
use garcon_base::{event_loop::EventLoopSteps, keyed_lock::LockAborted};
use garcon_contract::usage::{AgentUsageReportStatus, UsageReadRequest, parse_agent_usage_report};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    resources::ExecutorResult,
    usage_history::{AgentUsageHistory, AgentUsageReadRequest},
};
use garcon_js::{
    Number,
    clock::ManualClock,
    date_parse::date_parse,
    json::{from_slice, from_str},
};
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio::task::LocalSet;
use tokio_util::sync::CancellationToken;

struct TestFormat;
impl TranscriptUsageFormat for TestFormat {
    type State = ();

    fn line_markers(&self) -> &[&str] {
        &["\"model\""]
    }
    fn create_state(&self) {}
    fn clone_state(&self, _: &()) {}

    fn parse_line(&self, line: &str, _: &mut ()) -> ExecutorResult<Option<UsageLine>> {
        let row: Value = from_str(line)?;
        let timestamp = parse_timestamp_ms(&row["at"]);
        if row["broken"].as_bool() == Some(true) {
            return Ok(Some(UsageLine::Malformed(MalformedUsage {
                timestamp_ms: timestamp,
            })));
        }
        let (Some(timestamp_ms), Some(model)) = (timestamp, row["model"].as_str()) else {
            return Ok(None);
        };
        Ok(Some(UsageLine::Record(UsageRecord {
            timestamp_ms,
            model: model.into(),
            session_id: row["session"].as_str().unwrap_or_default().into(),
            totals: NativeUsageTokenTotals {
                uncached_input_tokens: Number(token_count(&row["input"])),
                cached_input_tokens: Number(token_count(&row["cached"])),
                cache_write_tokens: Number(0.0),
                output_tokens: Number(token_count(&row["output"])),
                reasoning_tokens: Number(0.0),
            },
            cache_write_1h_tokens: Number(0.0),
            speed: UsageSpeed::Standard,
            dedupe_key: row["id"].as_str().map(str::to_owned),
        })))
    }
}

fn request(zone: &str) -> AgentUsageReadRequest {
    AgentUsageReadRequest {
        request: UsageReadRequest {
            since_day: "2026-10-01".into(),
            until_day: "2026-10-31".into(),
            time_zone: zone.into(),
        },
        signal: None,
    }
}

fn history(root: &Path) -> Rc<dyn AgentUsageHistory> {
    let path = root.to_str().unwrap().to_owned();
    create_transcript_usage_history(TranscriptUsageScannerOptions {
        operation: "usage-history-test".into(),
        roots: Rc::new(move || vec![path.clone()]),
        format: TestFormat,
        clock: Some(Rc::new(ManualClock::new(
            date_parse("2026-10-27T00:00:00Z").unwrap(),
        ))),
    })
}

fn write_rows(path: &Path, rows: &[Value]) {
    fs::write(
        path,
        rows.iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>(),
    )
    .unwrap();
}

#[tokio::test]
async fn reports_the_same_wire_bytes_as_bun_across_zones_and_fork_copies() {
    LocalSet::new().run_until(async {
        let root = tempdir().unwrap();
        write_rows(&root.path().join("a.jsonl"), &[
            json!({"at":"2026-09-30T20:00:00Z","model":"unknown","session":"outside","input":9}),
            json!({"at":"2026-10-05T06:30:00Z","model":"claude-opus-5-5","session":"s1","id":"r1","input":1_000_000,"output":10}),
            json!({"at":"2026-10-06T12:00:00Z","model":"unknown-model","session":"s2","input":10,"cached":2,"output":5}),
            json!({"at":"2026-10-05T12:00:00Z","model":"claude-sonnet-5-5","session":"s1","input":100,"cached":1000,"output":50}),
        ]);
        write_rows(&root.path().join("b.jsonl"), &[
            json!({"at":"2026-10-06T06:30:00Z","model":"claude-opus-5-5","session":"fork","id":"r1","input":1_000_000,"output":20}),
            json!({"at":"2026-09-20T12:00:00Z","model":"claude-opus-5-5","broken":true}),
            json!({"at":"2026-10-10T12:00:00Z","model":"claude-opus-5-5","broken":true}),
        ]);
        let history = history(root.path());
        let mut reports = Vec::new();
        for zone in ["UTC", "America/Los_Angeles", "Asia/Kolkata"] {
            let report = history.read(request(zone)).await.unwrap();
            assert_eq!(report.status, AgentUsageReportStatus::Partial);
            assert!(parse_agent_usage_report(&from_slice(&serde_json::to_vec(&report).unwrap()).unwrap()).is_some());
            reports.push(report);
        }
        assert_eq!(reports[0].counts.distinct_sessions, 2);
        assert_eq!(reports[0].counts.malformed_records, 1);
        assert_eq!(reports[0].buckets[0].totals.output_tokens, 20);
        assert_eq!(reports[1].buckets[0].day, "2026-10-04");
        let oracle = tokio::process::Command::new("bun")
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/oracles/usage-history.ts"))
            .arg(root.path()).output().await.unwrap();
        assert!(oracle.status.success(), "{}", String::from_utf8_lossy(&oracle.stderr));
        assert_eq!(serde_json::to_string(&reports).unwrap(), String::from_utf8(oracle.stdout).unwrap());
    }).await;
}

#[tokio::test]
async fn marks_only_in_window_malformed_rows_and_reports_missing_roots() {
    LocalSet::new().run_until(async {
        let root = tempdir().unwrap();
        let missing = history(&root.path().join("absent"));
        let missing = missing.read(request("UTC")).await.unwrap();
        assert_eq!(missing.status, AgentUsageReportStatus::Missing);
        assert!(missing.buckets.is_empty());
        write_rows(&root.path().join("a.jsonl"), &[
            json!({"at":"2026-09-20T12:00:00Z","model":"claude-opus-5-5","broken":true}),
            json!({"at":"2026-10-05T12:00:00Z","model":"claude-opus-5-5","input":10,"output":1}),
        ]);
        let history = history(root.path());
        assert_eq!(history.read(request("UTC")).await.unwrap().status, AgentUsageReportStatus::Ok);
        let mut wide = request("UTC");
        wide.request.since_day = "2026-09-15".into();
        let report = history.read(wide).await.unwrap();
        assert_eq!(report.status, AgentUsageReportStatus::Partial);
        assert_eq!(report.counts.malformed_records, 1);
    }).await;
}

#[tokio::test]
async fn validates_windows_and_serves_queued_reads_after_cancellation() {
    LocalSet::new().run_until(async {
        let root = tempdir().unwrap();
        let history = history(root.path());
        for (since, until, zone) in [
            ("2026-10-01", "2026-09-01", "UTC"),
            ("2026-01-01", "2026-10-31", "UTC"),
            ("2026-10-01", "2026-10-31", "Not/AZone"),
            ("2026-02-30", "2026-10-31", "UTC"),
        ] {
            let mut invalid = request(zone);
            invalid.request.since_day = since.into();
            invalid.request.until_day = until.into();
            let error = history.read(invalid).await.unwrap_err();
            let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
            assert_eq!(error.code, AgentIntegrationErrorCode::OPERATION_UNSUPPORTED);
            assert_eq!(error.message, "Invalid usage window");
        }
        let rows = (0..5000).map(|index| json!({
            "at":"2026-10-05T12:00:00Z","model":"claude-opus-5-5","id":format!("r{index}"),"input":1,
        })).collect::<Vec<_>>();
        write_rows(&root.path().join("a.jsonl"), &rows);
        let cancel = CancellationToken::new();
        let mut cancelled = request("UTC");
        cancelled.signal = Some(cancel.clone());
        let abort = async { tokio::task::yield_now().await; cancel.cancel(); };
        let (cancelled, queued, ()) = tokio::join!(history.read(cancelled), history.read(request("UTC")), abort);
        assert!(cancelled.unwrap_err().is::<LockAborted>());
        assert_eq!(queued.unwrap().buckets[0].records, 5000);
    }).await;
}

#[tokio::test]
async fn counts_unknown_malformed_times_and_bounds_unpriced_model_names() {
    let mut aggregator = UsageAggregator::new(request("UTC").request).unwrap();
    aggregator.add_malformed(date_parse("2026-10-05")).unwrap();
    aggregator.add_malformed(date_parse("2026-08-05")).unwrap();
    aggregator.add_malformed(None).unwrap();
    let model = "x".repeat(500);
    let row =
        json!({"at":"2026-10-10","model":model,"input":100,"cached":1000,"output":50}).to_string();
    let Some(UsageLine::Record(record)) = TestFormat.parse_line(&row, &mut ()).unwrap() else {
        panic!("test row did not yield usage");
    };
    aggregator.add(&record);
    let result = aggregator
        .finish(&mut EventLoopSteps::new("usage-test"), None)
        .await
        .unwrap();
    assert_eq!(result.buckets[0].model.len(), 200);
    assert_eq!(result.buckets[0].unpriced_tokens, 1150);
    assert_eq!(result.buckets[0].cost_usd.0, 0.0);
    assert_eq!(result.malformed_records, 2);
}

#[tokio::test]
async fn rejects_a_report_with_unrepresentable_native_token_totals() {
    LocalSet::new().run_until(async {
        let root = tempdir().unwrap();
        write_rows(&root.path().join("a.jsonl"), &[json!({
            "at":"2026-10-05T12:00:00Z","model":"claude-opus-5-5","input":1e21,
        })]);
        let error = history(root.path()).read(request("UTC")).await.unwrap_err();
        let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
        assert_eq!(error.code, AgentIntegrationErrorCode::PROVIDER_FAILURE);
        assert_eq!(error.message, "Invalid usage report: totals.uncachedInputTokens is not a non-negative safe integer.");
    }).await;
}
