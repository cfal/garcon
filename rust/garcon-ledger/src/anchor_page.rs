use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::transcript_anchor_page::{
    TranscriptAnchorDirection, TranscriptAnchorPageStatus, is_transcript_anchor,
};
use rusqlite::{Connection, params};
use serde::Serialize;

use crate::{
    codec::decode_stored_ledger_row,
    contracts::{LedgerRow, LedgerRowData, TranscriptViewId},
    sqlite_operations::{LedgerResult, as_error, bind_ordinal, read_stored_row},
};

const ANCHOR_SCAN_BATCH_ROWS: usize = 200;

#[derive(Debug, Clone, Copy)]
pub struct AnchorScanInput {
    pub direction: TranscriptAnchorDirection,
    pub cursor_ordinal: u64,
    pub watermark_ordinal: u64,
    pub anchors_remaining: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorScanResult {
    pub rows: Vec<LedgerRow>,
    pub start_ordinal: u64,
    pub end_ordinal: u64,
    pub anchors_remaining: u64,
    pub page_status: TranscriptAnchorPageStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorScanProgress {
    pub cursor_ordinal: u64,
    pub anchors_remaining: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AnchorBatchStop {
    Yield,
    Complete,
    Exhausted,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorBatchResult {
    pub rows: Vec<LedgerRow>,
    pub progress: AnchorScanProgress,
    pub stop: AnchorBatchStop,
}

pub async fn read_anchor_page(
    input: &AnchorScanInput,
    read: impl FnMut(AnchorScanProgress, &dyn Fn() -> bool) -> LedgerResult<AnchorBatchResult>,
    validate_current_read: impl FnOnce() -> LedgerResult<()>,
) -> LedgerResult<AnchorScanResult> {
    read_anchor_page_in_steps(
        input,
        read,
        validate_current_read,
        EventLoopSteps::new("ledger anchor page"),
    )
    .await
}

pub(crate) async fn read_anchor_page_in_steps(
    input: &AnchorScanInput,
    mut read: impl FnMut(AnchorScanProgress, &dyn Fn() -> bool) -> LedgerResult<AnchorBatchResult>,
    validate_current_read: impl FnOnce() -> LedgerResult<()>,
    mut steps: EventLoopSteps,
) -> LedgerResult<AnchorScanResult> {
    let mut rows = Vec::new();
    let mut progress = AnchorScanProgress {
        cursor_ordinal: input.cursor_ordinal,
        anchors_remaining: input.anchors_remaining,
    };
    loop {
        let batch = read(progress, &|| steps.due())?;
        rows.extend(batch.rows);
        progress = batch.progress;
        steps.next().await;
        let page_status = match batch.stop {
            AnchorBatchStop::Yield => continue,
            AnchorBatchStop::Complete => TranscriptAnchorPageStatus::Complete,
            AnchorBatchStop::Exhausted => TranscriptAnchorPageStatus::Exhausted,
        };
        validate_current_read()?;
        let backward = input.direction == TranscriptAnchorDirection::Backward;
        let (start_ordinal, end_ordinal) = if backward {
            rows.reverse();
            (progress.cursor_ordinal, input.cursor_ordinal)
        } else {
            (input.cursor_ordinal + 1, progress.cursor_ordinal + 1)
        };
        return Ok(AnchorScanResult {
            rows,
            start_ordinal,
            end_ordinal,
            anchors_remaining: progress.anchors_remaining,
            page_status,
        });
    }
}

pub fn read_anchor_batch(
    db: &Connection,
    view_id: &TranscriptViewId,
    input: &AnchorScanInput,
    mut progress: AnchorScanProgress,
    mut should_yield: impl FnMut() -> bool,
) -> LedgerResult<AnchorBatchResult> {
    let backward = input.direction == TranscriptAnchorDirection::Backward;
    let at_edge = |cursor| cursor == if backward { 1 } else { input.watermark_ordinal };
    let finish = |rows, progress, stop| {
        Ok(AnchorBatchResult {
            rows,
            progress,
            stop,
        })
    };
    let mut rows = Vec::new();
    if at_edge(progress.cursor_ordinal) {
        return finish(rows, progress, AnchorBatchStop::Exhausted);
    }
    let (comparison, direction) = if backward {
        ("<", "DESC")
    } else {
        (">", "ASC")
    };
    let mut statement = db
        .prepare(&format!(
            "
    SELECT view_id, ordinal, kind, at, client_message_id, payload_json
    FROM transcript_rows
    WHERE view_id = ? AND ordinal {comparison} ? AND ordinal <= ?
    ORDER BY ordinal {direction} LIMIT ?
  "
        ))
        .map_err(as_error)?;
    let selected = statement
        .query_map(
            params![
                view_id.as_str(),
                bind_ordinal(progress.cursor_ordinal),
                bind_ordinal(input.watermark_ordinal),
                ANCHOR_SCAN_BATCH_ROWS as i64,
            ],
            read_stored_row,
        )
        .map_err(as_error)?;
    for stored in selected {
        let stored = stored.map_err(as_error)?;
        let delta = if backward { -1.0 } else { 1.0 };
        if stored.ordinal.0 != progress.cursor_ordinal as f64 + delta {
            return Err(std::io::Error::other(
                "Transcript anchor scan encountered a noncontiguous raw interval",
            )
            .into());
        }
        let row = decode_stored_ledger_row(&stored)?;
        let anchor = match &row.data {
            LedgerRowData::UserInput { .. } => true,
            LedgerRowData::ProviderRow { message } => is_transcript_anchor(message),
            _ => false,
        };
        if anchor && progress.anchors_remaining == 0 {
            return finish(rows, progress, AnchorBatchStop::Complete);
        }
        progress.cursor_ordinal = row.ordinal;
        rows.push(row);
        if anchor {
            progress.anchors_remaining -= 1;
        }
        if at_edge(progress.cursor_ordinal) {
            return finish(rows, progress, AnchorBatchStop::Exhausted);
        }
        if should_yield() {
            return finish(rows, progress, AnchorBatchStop::Yield);
        }
    }
    if rows.len() == ANCHOR_SCAN_BATCH_ROWS {
        return finish(rows, progress, AnchorBatchStop::Yield);
    }
    Err(std::io::Error::other("Transcript anchor scan ended before its fixed history edge").into())
}
