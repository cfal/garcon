use std::rc::Rc;

use async_trait::async_trait;
use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::usage::{
    AgentUsageReport, AgentUsageReportStatus, MAX_USAGE_BUCKETS, UsageReadRequest,
    UsageSourceCounts, parse_usage_read_request,
};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    resources::ExecutorResult,
    usage_history::{AgentUsageHistory, AgentUsageReadRequest},
};
use garcon_js::date_parse::date_parse;
use serde_json::json;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use super::{
    model_prices::USAGE_PRICING_AS_OF,
    transcript_usage_scanner::{
        TranscriptUsageScan, TranscriptUsageScanner, TranscriptUsageScannerOptions, check_abort,
    },
    usage_aggregator::{UsageAggregation, UsageAggregator},
    usage_record::TranscriptUsageFormat,
};

const MTIME_SLACK_MS: i64 = 36 * 60 * 60 * 1000;

pub fn create_transcript_usage_history<F>(
    options: TranscriptUsageScannerOptions<F>,
) -> Rc<dyn AgentUsageHistory>
where
    F: TranscriptUsageFormat + 'static,
{
    Rc::new(TranscriptUsageHistory {
        scanner: Rc::new(Mutex::new(TranscriptUsageScanner::new(options))),
    })
}

struct TranscriptUsageHistory<F: TranscriptUsageFormat> {
    scanner: Rc<Mutex<TranscriptUsageScanner<F>>>,
}

#[async_trait(?Send)]
impl<F: TranscriptUsageFormat + 'static> AgentUsageHistory for TranscriptUsageHistory<F> {
    async fn read(&self, request: AgentUsageReadRequest) -> ExecutorResult<AgentUsageReport> {
        let Some(window) = parse_usage_read_request(&json!(&request.request)) else {
            return Err(invalid_window());
        };
        let scanner = self.scanner.clone();
        tokio::task::spawn_local(async move {
            let mut scanner = scanner.lock().await;
            read(&mut scanner, window, request.signal.as_ref()).await
        })
        .await?
    }
}

async fn read<F: TranscriptUsageFormat>(
    scanner: &mut TranscriptUsageScanner<F>,
    window: UsageReadRequest,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<AgentUsageReport> {
    check_abort(signal)?;
    let mut steps = EventLoopSteps::new(scanner.operation());
    let since_ms = date_parse(&format!("{}T00:00:00Z", window.since_day))
        .ok_or_else(invalid_window)?
        - MTIME_SLACK_MS;
    let scan = scanner.scan(since_ms, &mut steps, signal).await?;
    let mut aggregator = UsageAggregator::new(window)?;
    for file in &scan.files {
        check_abort(signal)?;
        steps
            .try_for_each(&file.records, |record| {
                check_abort(signal)?;
                aggregator.add(record);
                Ok::<_, Box<dyn std::error::Error>>(())
            })
            .await?;
        for record in &file.tail_records {
            aggregator.add(record);
        }
        for entry in &file.malformed {
            aggregator.add_malformed(entry.timestamp_ms)?;
        }
    }
    report(&scan, aggregator.finish(&mut steps, signal).await?)
}

fn invalid_window() -> Box<dyn std::error::Error> {
    Box::new(AgentIntegrationError::new(
        AgentIntegrationErrorCode::OPERATION_UNSUPPORTED,
        "Invalid usage window",
        false,
        None,
    ))
}

fn report(
    scan: &TranscriptUsageScan<'_>,
    usage: UsageAggregation,
) -> ExecutorResult<AgentUsageReport> {
    if usage.buckets.len() > MAX_USAGE_BUCKETS {
        return Err(Box::new(AgentIntegrationError::new(
            AgentIntegrationErrorCode::PROVIDER_FAILURE,
            "Usage spans too many models to report",
            false,
            None,
        )));
    }
    let status = if !scan.root_found {
        AgentUsageReportStatus::Missing
    } else if scan.unreadable_paths > 0 || usage.malformed_records > 0 {
        AgentUsageReportStatus::Partial
    } else {
        AgentUsageReportStatus::Ok
    };
    Ok(AgentUsageReport {
        status,
        buckets: usage.buckets,
        counts: UsageSourceCounts {
            scanned_files: scan.files.len() as u64,
            unreadable_files: scan.unreadable_paths,
            malformed_records: usage.malformed_records,
            distinct_sessions: usage.distinct_sessions,
        },
        pricing_as_of: USAGE_PRICING_AS_OF.to_owned(),
    })
}
