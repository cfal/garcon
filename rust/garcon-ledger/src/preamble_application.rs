use garcon_contract::{
    preamble_prefix::create_preamble_prefix,
    preambles::{PendingPreambleBoundary, Preamble, render_preamble_content},
    template_tokens::runtime_template_values,
};
use garcon_js::{InvalidTimeValue, date_parse::date_parse};
use rusqlite::{Connection, OptionalExtension, params};

use crate::{
    contracts::{
        LedgerNoticeDetail, LedgerRowData, LedgerRowDraft, LedgerUserInputDetail, TranscriptViewId,
    },
    errors::LedgerCodecError,
    sqlite_operations::{LedgerResult, as_error, bind_ordinal},
};

#[derive(Debug)]
pub struct PreparedPreambleInput {
    pub detail: LedgerUserInputDetail,
    pub drafts: Vec<LedgerRowDraft>,
    pub provider_prefix: String,
}

pub fn has_preamble_boundary_proof(
    db: &Connection,
    view_id: &TranscriptViewId,
    boundary: &PendingPreambleBoundary,
) -> LedgerResult<bool> {
    let (kind, epoch) = match boundary {
        PendingPreambleBoundary::NewChat { ownership_epoch } => ("new-chat", ownership_epoch),
        PendingPreambleBoundary::Fork { ownership_epoch } => ("fork", ownership_epoch),
        PendingPreambleBoundary::Continuation { ownership_epoch } => {
            ("continuation", ownership_epoch)
        }
        PendingPreambleBoundary::AgentSwitch { ownership_epoch } => {
            ("agent-switch", ownership_epoch)
        }
        PendingPreambleBoundary::SelectionChange {
            ownership_epoch,
            selection_revision,
        } => {
            let found = db
                .prepare_cached(
                    "
      SELECT 1 AS found
      FROM transcript_rows
      WHERE view_id = ? AND kind = 'user-input'
        AND json_extract(payload_json, '$.value.preambleBoundary.kind') = ?
        AND json_extract(payload_json, '$.value.preambleBoundary.ownershipEpoch') = ?
        AND json_extract(payload_json, '$.value.preambleBoundary.selectionRevision') = ?
      LIMIT 1
    ",
                )
                .map_err(as_error)?
                .query_row(
                    params![
                        view_id.as_str(),
                        "selection-change",
                        ownership_epoch,
                        bind_ordinal(*selection_revision)
                    ],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(as_error)?;
            return Ok(found.is_some());
        }
    };
    let found = db
        .prepare_cached(
            "
    SELECT 1 AS found
    FROM transcript_rows
    WHERE view_id = ? AND kind = 'user-input'
      AND json_extract(payload_json, '$.value.preambleBoundary.kind') = ?
      AND json_extract(payload_json, '$.value.preambleBoundary.ownershipEpoch') = ?
    LIMIT 1
  ",
        )
        .map_err(as_error)?
        .query_row(params![view_id.as_str(), kind, epoch], |row| {
            row.get::<_, i64>(0)
        })
        .optional()
        .map_err(as_error)?;
    Ok(found.is_some())
}

pub fn prepare_preamble_input(
    chat_id: &str,
    at: &str,
    detail: &LedgerUserInputDetail,
    boundary: Option<&PendingPreambleBoundary>,
    preambles: &[Preamble],
) -> LedgerResult<PreparedPreambleInput> {
    if boundary.is_some()
        && detail
            .client_message_id
            .as_ref()
            .is_none_or(String::is_empty)
    {
        return Err(
            LedgerCodecError::Type("Boundary input requires a client message ID".into()).into(),
        );
    }
    let values = runtime_template_values(chat_id, date_parse(at).ok_or(InvalidTimeValue)?)?;
    let application = if boundary.is_some() {
        let contents = preambles
            .iter()
            .map(|preamble| render_preamble_content(&preamble.definition.content, &values))
            .collect::<Result<Vec<_>, _>>()?;
        create_preamble_prefix(&contents.iter().map(String::as_str).collect::<Vec<_>>())?
    } else {
        None
    };
    let mut detail = detail.clone();
    detail.preamble_boundary = boundary.cloned();
    detail.preamble_prefix_receipt = application.as_ref().map(|value| value.receipt.clone());
    if detail
        .client_message_id
        .as_ref()
        .is_some_and(String::is_empty)
    {
        return Err(LedgerCodecError::Type("Client message ID must be non-empty".into()).into());
    }

    let mut drafts = Vec::new();
    if application.is_some() {
        let refs: Vec<_> = preambles
            .iter()
            .map(|preamble| {
                serde_json::json!({
                    "id": preamble.id, "title": preamble.definition.title,
                })
            })
            .collect();
        drafts.push(LedgerRowDraft {
            at: at.into(),
            provider_meta: None,
            data: LedgerRowData::Notice {
                message: "Preambles applied".into(),
                detail: LedgerNoticeDetail::Other(
                    serde_json::json!({
                        "type": "preamble-application", "preambles": refs,
                    })
                    .into(),
                ),
            },
        });
    }
    drafts.push(LedgerRowDraft {
        at: at.into(),
        provider_meta: None,
        data: LedgerRowData::UserInput {
            detail: detail.clone(),
        },
    });
    Ok(PreparedPreambleInput {
        detail,
        drafts,
        provider_prefix: application.map_or_else(String::new, |value| value.prefix),
    })
}
