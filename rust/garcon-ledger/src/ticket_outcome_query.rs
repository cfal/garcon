use garcon_js::json::as_number;
use rusqlite::{Connection, OptionalExtension, params};

use crate::{
    codec::decode_stored_ledger_row,
    contracts::{LedgerNoticeDetail, LedgerRowData},
    errors::LedgerError,
    sqlite_operations::{LedgerResult, as_error, bind_ordinal, read_stored_row},
};

pub const TICKET_OUTCOME_INDEX_SQL: &str = "
  CREATE INDEX transcript_ticket_outcome_correlation ON transcript_rows (
    view_id,
    json_extract(payload_json, '$.value.detail.requestViewId'),
    json_extract(payload_json, '$.value.detail.requestOrdinal'),
    ordinal
  ) WHERE kind = 'notice'
  AND json_extract(payload_json, '$.value.detail.type') = 'ticket-command-outcome'
";

pub const TICKET_OUTCOME_QUERY_SQL: &str = "
  SELECT view_id, ordinal, kind, at, client_message_id, payload_json
  FROM transcript_rows INDEXED BY transcript_ticket_outcome_correlation
  WHERE view_id = ? AND kind = 'notice'
  AND json_extract(payload_json, '$.value.detail.type') = 'ticket-command-outcome'
    AND json_extract(payload_json, '$.value.detail.requestViewId') = ?
    AND json_extract(payload_json, '$.value.detail.requestOrdinal') = ?
  ORDER BY ordinal ASC LIMIT 1
";

pub fn find_ticket_outcome_ordinal(
    db: &Connection,
    view_id: &str,
    request_ordinal: u64,
) -> LedgerResult<Option<u64>> {
    let row = db
        .prepare_cached(TICKET_OUTCOME_QUERY_SQL)
        .map_err(as_error)?
        .query_row(
            params![view_id, view_id, bind_ordinal(request_ordinal)],
            read_stored_row,
        )
        .optional()
        .map_err(as_error)?;
    let Some(row) = row else { return Ok(None) };
    let row = decode_stored_ledger_row(&row)?;
    if let LedgerRowData::Notice {
        detail: LedgerNoticeDetail::Other(detail),
        ..
    } = row.data
        && detail["type"] == "ticket-command-outcome"
        && detail["requestViewId"] == view_id
        && as_number(&detail["requestOrdinal"]) == Some(request_ordinal as f64)
    {
        Ok(Some(row.ordinal))
    } else {
        Err(LedgerError::Schema("Invalid ticket outcome correlation".into()).into())
    }
}
