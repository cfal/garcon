use rusqlite::{Connection, OptionalExtension, params};

use crate::{
    codec::decode_stored_ledger_row,
    contracts::{LedgerRow, TranscriptView},
    sqlite_operations::{LedgerResult, as_error, bind_ordinal, read_stored_row},
};

// The session row can be near the start of a large view. The index avoids a
// scan of the primary key on every newest-history read.
pub const SESSION_INDEX_SQL: &str = "
  CREATE INDEX transcript_session_rows ON transcript_rows (view_id, ordinal)
  WHERE kind = 'session'
";

pub const CURRENT_SESSION_QUERY_SQL: &str = "
  SELECT view_id, ordinal, kind, at, client_message_id, payload_json
  FROM transcript_rows INDEXED BY transcript_session_rows
  WHERE view_id = ? AND ordinal >= ? AND kind = 'session'
  ORDER BY ordinal DESC LIMIT 1
";

pub fn find_current_session(
    db: &Connection,
    view: &TranscriptView,
) -> LedgerResult<Option<LedgerRow>> {
    let row = db
        .prepare_cached(CURRENT_SESSION_QUERY_SQL)
        .map_err(as_error)?
        .query_row(
            params![
                view.view_id.as_str(),
                bind_ordinal(view.content_start_ordinal)
            ],
            read_stored_row,
        )
        .optional()
        .map_err(as_error)?;
    row.as_ref()
        .map(decode_stored_ledger_row)
        .transpose()
        .map_err(as_error)
}
