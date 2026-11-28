use rusqlite::{Connection, params};

use crate::{
    codec::decode_stored_ledger_row,
    contracts::{TranscriptPage, TranscriptViewId},
    sqlite_operations::{LedgerResult, as_error, bind_ordinal, read_stored_row},
};

pub fn read_raw_page(
    db: &Connection,
    view_id: &TranscriptViewId,
    limit: u64,
    before: Option<u64>,
) -> LedgerResult<TranscriptPage> {
    let stored = if let Some(before) = before {
        db.prepare_cached(
            "
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ? AND ordinal < ?
        ORDER BY ordinal DESC
        LIMIT ?
      ",
        )
        .map_err(as_error)?
        .query_map(
            params![view_id.as_str(), bind_ordinal(before), bind_ordinal(limit)],
            read_stored_row,
        )
        .map_err(as_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
    } else {
        db.prepare_cached(
            "
        SELECT view_id, ordinal, kind, at, client_message_id, payload_json
        FROM transcript_rows
        WHERE view_id = ?
        ORDER BY ordinal DESC
        LIMIT ?
      ",
        )
        .map_err(as_error)?
        .query_map(
            params![view_id.as_str(), bind_ordinal(limit)],
            read_stored_row,
        )
        .map_err(as_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
    }
    .map_err(as_error)?;
    let mut rows = stored
        .iter()
        .map(decode_stored_ledger_row)
        .collect::<Result<Vec<_>, _>>()?;
    rows.reverse();
    let next_before = rows
        .first()
        .map(|row| row.ordinal)
        .filter(|&ordinal| ordinal > 1);
    Ok(TranscriptPage {
        view_id: view_id.clone(),
        rows,
        next_before,
    })
}
