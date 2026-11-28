use garcon_contract::{agent_execution::AgentAttachment, chat_types::UserMessage};
use rusqlite::{Connection, OptionalExtension, params};

use crate::{
    codec::{decode_stored_ledger_row, submission_fingerprint},
    contracts::{LedgerRow, LedgerRowData, LedgerUserInputDetail, TranscriptViewId},
    errors::LedgerError,
    sqlite_operations::{LedgerResult, read_stored_row, run_query},
};

pub fn input_detail(
    message: UserMessage,
    attachments: Vec<AgentAttachment>,
    client_message_id: Option<String>,
    steer: bool,
) -> LedgerUserInputDetail {
    LedgerUserInputDetail {
        client_message_id,
        message,
        attachments,
        steer,
        preamble_boundary: None,
        preamble_prefix_receipt: None,
    }
}

pub fn read_submission(
    db: &Connection,
    view_id: &TranscriptViewId,
    client_message_id: &str,
) -> LedgerResult<Option<LedgerRow>> {
    run_query(|| -> LedgerResult<_> {
        let stored = db
            .prepare_cached(
                "
      SELECT view_id, ordinal, kind, at, client_message_id, payload_json
      FROM transcript_rows
      WHERE view_id = ? AND client_message_id = ?
    ",
            )?
            .query_row(
                params![view_id.as_str(), client_message_id],
                read_stored_row,
            )
            .optional()?;
        Ok(stored.as_ref().map(decode_stored_ledger_row).transpose()?)
    })
}

pub fn matching_input_submission(
    db: &Connection,
    view_id: &TranscriptViewId,
    detail: &LedgerUserInputDetail,
) -> LedgerResult<Option<LedgerRow>> {
    let Some(id) = detail
        .client_message_id
        .as_deref()
        .filter(|id| !id.is_empty())
    else {
        return Ok(None);
    };
    let Some(existing) = read_submission(db, view_id, id)? else {
        return Ok(None);
    };
    if let LedgerRowData::UserInput {
        detail: existing_detail,
    } = &existing.data
        && submission_fingerprint(existing_detail)? == submission_fingerprint(detail)?
    {
        Ok(Some(existing))
    } else {
        Err(LedgerError::SubmissionConflict {
            client_message_id: id.into(),
        }
        .into())
    }
}
