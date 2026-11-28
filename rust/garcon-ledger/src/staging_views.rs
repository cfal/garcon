use std::collections::HashSet;

use garcon_js::{Number, utf16};
use rusqlite::{Connection, params};

use crate::{
    codec::{
        EncodedLedgerDraft, StoredLedgerRow, decode_ledger_row, decode_stored_ledger_row,
        encode_ledger_draft,
    },
    contracts::{LedgerRow, LedgerRowDraft, TranscriptViewId},
    errors::LedgerError,
    sqlite_operations::{LedgerResult, as_error, bind_ordinal, read_stored_row},
};

mod state;
pub(crate) use state::StagingViews;

const BULK_READ_ROWS: usize = 1000;
const BULK_READ_BYTES: usize = 4 * 1024 * 1024;

pub struct EncodedDraft<'a> {
    pub draft: &'a LedgerRowDraft,
    pub encoded: EncodedLedgerDraft,
}

pub fn encode_drafts(drafts: &[LedgerRowDraft]) -> LedgerResult<Vec<EncodedDraft<'_>>> {
    let mut client_message_ids = HashSet::new();
    drafts
        .iter()
        .map(|draft| encode_draft(draft, &mut client_message_ids))
        .collect()
}

fn encode_draft<'a>(
    draft: &'a LedgerRowDraft,
    client_message_ids: &mut HashSet<String>,
) -> LedgerResult<EncodedDraft<'a>> {
    let encoded = encode_ledger_draft(draft)?;
    if let Some(id) = &encoded.client_message_id
        && !id.is_empty()
        && !client_message_ids.insert(id.clone())
    {
        return Err(LedgerError::Schema(
            "Transcript view contains duplicate client message IDs".into(),
        )
        .into());
    }
    Ok(EncodedDraft { draft, encoded })
}

pub fn materialize_rows(
    view_id: &TranscriptViewId,
    rows: &[EncodedDraft<'_>],
    first_ordinal: u64,
) -> LedgerResult<Vec<LedgerRow>> {
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            decode_ledger_row(&StoredLedgerRow {
                view_id: view_id.as_str().into(),
                ordinal: Number((first_ordinal + index as u64) as f64),
                kind: row.draft.data.kind().into(),
                at: row.draft.at.clone(),
                client_message_id: row.encoded.client_message_id.clone(),
                payload_json: row.encoded.payload_json.clone(),
            })
            .map_err(as_error)
        })
        .collect()
}

pub fn insert_encoded_rows(
    db: &Connection,
    view_id: &TranscriptViewId,
    rows: &[EncodedDraft<'_>],
    first_ordinal: u64,
) -> LedgerResult<()> {
    let mut statement = db
        .prepare_cached(
            "
    INSERT INTO transcript_rows(
      view_id, ordinal, kind, at, client_message_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  ",
        )
        .map_err(as_error)?;
    for (index, row) in rows.iter().enumerate() {
        statement
            .execute(params![
                view_id.as_str(),
                bind_ordinal(first_ordinal + index as u64),
                row.draft.data.kind(),
                row.draft.at,
                row.encoded.client_message_id,
                row.encoded.payload_json,
            ])
            .map_err(as_error)?;
    }
    Ok(())
}

pub fn promote_staging_view(db: &Connection, view_id: &TranscriptViewId) -> LedgerResult<()> {
    let changes = db.prepare_cached("UPDATE transcript_views SET status = 'current' WHERE status = 'staging' AND view_id = ?")
        .and_then(|mut statement| statement.execute([view_id.as_str()])).map_err(as_error)?;
    if changes != 1 {
        return Err(LedgerError::Schema("Transcript staging promotion failed".into()).into());
    }
    Ok(())
}

#[derive(Debug)]
pub struct BoundedPage<Row> {
    pub rows: Vec<Row>,
    pub exhausted: bool,
}

pub fn read_bounded_page(
    db: &Connection,
    view_id: &TranscriptViewId,
    after_ordinal: u64,
    through_ordinal: u64,
) -> LedgerResult<BoundedPage<LedgerRow>> {
    let page = read_bounded_stored_page(db, view_id, after_ordinal, through_ordinal)?;
    let rows = page
        .rows
        .iter()
        .map(decode_stored_ledger_row)
        .collect::<Result<_, _>>()?;
    Ok(BoundedPage {
        rows,
        exhausted: page.exhausted,
    })
}

pub fn read_bounded_stored_page(
    db: &Connection,
    view_id: &TranscriptViewId,
    after_ordinal: u64,
    through_ordinal: u64,
) -> LedgerResult<BoundedPage<StoredLedgerRow>> {
    let mut statement = db
        .prepare(
            "
    SELECT view_id, ordinal, kind, at, client_message_id, payload_json
    FROM transcript_rows
    WHERE view_id = ? AND ordinal > ? AND ordinal <= ?
    ORDER BY ordinal
  ",
        )
        .map_err(as_error)?;
    let mut rows = Vec::new();
    let mut units = 0;
    let selected = statement
        .query_map(
            params![
                view_id.as_str(),
                bind_ordinal(after_ordinal),
                bind_ordinal(through_ordinal)
            ],
            read_stored_row,
        )
        .map_err(as_error)?;
    for row in selected {
        let row = row.map_err(as_error)?;
        units += utf16::len(&row.payload_json);
        rows.push(row);
        if rows.len() >= BULK_READ_ROWS || units >= BULK_READ_BYTES {
            return Ok(BoundedPage {
                rows,
                exhausted: false,
            });
        }
    }
    Ok(BoundedPage {
        rows,
        exhausted: true,
    })
}
