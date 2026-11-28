use garcon_contract::chat_message_coercion::ChatContentMode;
use rusqlite::{Row, params};
use std::collections::HashSet;

use crate::{
    codec::decode_stored_ledger_row,
    connection_entry::ConnectionEntry,
    contracts::{
        LedgerRow, LedgerRowData, RunOutcome, TranscriptViewId, is_presentation_only_provider_row,
    },
    sqlite_operations::{LedgerResult, as_error, bind_ordinal, read_stored_row, run_query},
};

pub fn read_resend_candidates(
    entry: &ConnectionEntry,
    view_id: &TranscriptViewId,
) -> LedgerResult<Vec<LedgerRow>> {
    let mut statement = entry
        .db
        .prepare(
            "
    SELECT view_id, ordinal, kind, at, client_message_id, payload_json
    FROM transcript_rows
    WHERE view_id = ?
    ORDER BY ordinal DESC
  ",
        )
        .map_err(as_error)?;
    let rows = statement.query([view_id.as_str()]).map_err(as_error)?;
    collect_resend_candidates(rows, None)
}

pub fn compose_input_prompt(
    entry: &ConnectionEntry,
    view_id: &TranscriptViewId,
    current: &LedgerRow,
    excluded_ordinals: Option<&HashSet<u64>>,
) -> LedgerResult<Vec<LedgerRow>> {
    run_query(|| -> LedgerResult<_> {
        let mut statement = entry.db.prepare(
            "
      SELECT view_id, ordinal, kind, at, client_message_id, payload_json
      FROM transcript_rows
      WHERE view_id = ? AND ordinal < ?
      ORDER BY ordinal DESC
    ",
        )?;
        let rows = statement.query(params![view_id.as_str(), bind_ordinal(current.ordinal)])?;
        let mut prompt = collect_resend_candidates(rows, excluded_ordinals)?;
        prompt.push(current.clone());
        Ok(prompt)
    })
}

fn collect_resend_candidates(
    mut rows: rusqlite::Rows<'_>,
    excluded_ordinals: Option<&HashSet<u64>>,
) -> LedgerResult<Vec<LedgerRow>> {
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(as_error)? {
        let row = decode_candidate(row)?;
        match &row.data {
            LedgerRowData::UserInput { detail } => {
                if detail
                    .message
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.content_mode)
                    != Some(ChatContentMode::Literal)
                    && !excluded_ordinals.is_some_and(|ordinals| ordinals.contains(&row.ordinal))
                {
                    result.push(row);
                }
            }
            LedgerRowData::RunEnded {
                outcome: RunOutcome::Interrupted,
                ..
            } => {}
            LedgerRowData::ProviderRow { .. } if is_presentation_only_provider_row(&row) => {}
            LedgerRowData::ProviderRow { .. }
            | LedgerRowData::PermissionRequested { .. }
            | LedgerRowData::RunEnded { .. } => break,
            _ => {}
        }
    }
    result.reverse();
    Ok(result)
}

fn decode_candidate(row: &Row<'_>) -> LedgerResult<LedgerRow> {
    Ok(decode_stored_ledger_row(
        &read_stored_row(row).map_err(as_error)?,
    )?)
}
