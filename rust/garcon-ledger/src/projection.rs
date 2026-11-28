use garcon_contract::{
    chat_types::ChatMessage,
    transcript_notice_details::{
        is_carryover_migration_quarantine_notice_detail, is_preamble_application_notice_detail,
        is_publication_gap_notice_detail,
    },
};
use rusqlite::{Connection, params, types::ValueRef};
use serde::Serialize;

use crate::{
    codec::decode_stored_ledger_row,
    contracts::{
        LedgerNoticeDetail, LedgerRow, LedgerRowData, LedgerRowDraft, TranscriptViewId,
        is_conversational_ledger_row, is_presentation_only_provider_row,
    },
    sqlite_operations::{
        LedgerResult, as_error, bind_ordinal, non_negative_integer, read_stored_row,
    },
    store::{TranscriptLedgerStore, assert_current},
};

const PREVIEW_EDGE_ROWS: u64 = 32;
const PREVIEW_ROW_BYTES: i64 = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEdges {
    pub head: Vec<LedgerRow>,
    pub first_omitted_head_ordinal: Option<u64>,
    pub tail: Vec<LedgerRow>,
}

#[derive(Debug, Serialize)]
pub struct PreviewMessages {
    pub first: ChatMessage,
    pub last: ChatMessage,
}

impl TranscriptLedgerStore {
    pub fn preview_edges(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
    ) -> LedgerResult<PreviewEdges> {
        self.read(chat_id, |entry| {
            assert_current(entry, view_id)?;
            read_preview_edges(&entry.db, view_id, entry.next_ordinal - 1)
        })
    }
}

pub fn message_for_conversation_row(row: &LedgerRow) -> Option<ChatMessage> {
    match &row.data {
        LedgerRowData::UserInput { detail } => Some(ChatMessage::User(detail.message.clone())),
        LedgerRowData::ProviderRow { message } if is_conversational_ledger_row(row) => {
            Some(message.clone())
        }
        _ => None,
    }
}

pub fn preview_messages(edges: &PreviewEdges) -> Option<PreviewMessages> {
    let first_user = edges.head.iter().find(|row| {
        matches!(
            &row.data,
            LedgerRowData::UserInput { .. }
                | LedgerRowData::ProviderRow {
                    message: ChatMessage::User(_)
                }
        )
    });
    if edges
        .first_omitted_head_ordinal
        .is_some_and(|omitted| first_user.is_none_or(|row| row.ordinal > omitted))
    {
        return None;
    }
    let head = first_user.or_else(|| {
        edges
            .head
            .iter()
            .find(|row| is_conversational_ledger_row(row))
    })?;
    let tail = edges
        .tail
        .iter()
        .rfind(|row| is_conversational_ledger_row(row))?;
    Some(PreviewMessages {
        first: message_for_conversation_row(head)?,
        last: message_for_conversation_row(tail)?,
    })
}

pub fn frozen_conversation_drafts(rows: &[LedgerRow]) -> Vec<LedgerRowDraft> {
    rows.iter()
        .filter_map(|row| {
            let data = match &row.data {
                LedgerRowData::UserInput { .. } | LedgerRowData::AgentSwitch { .. } => {
                    row.data.clone()
                }
                LedgerRowData::ProviderRow { message }
                    if !is_presentation_only_provider_row(row) =>
                {
                    let mut message = message.clone();
                    if let ChatMessage::Assistant(message) = &mut message {
                        message.questions = None;
                    }
                    LedgerRowData::ProviderRow { message }
                }
                LedgerRowData::Notice {
                    detail: LedgerNoticeDetail::Other(detail),
                    ..
                } if is_carryover_migration_quarantine_notice_detail(detail.as_value())
                    || is_preamble_application_notice_detail(detail.as_value())
                    || is_publication_gap_notice_detail(detail.as_value()) =>
                {
                    row.data.clone()
                }
                _ => return None,
            };
            Some(LedgerRowDraft {
                at: row.at.clone(),
                provider_meta: None,
                data,
            })
        })
        .collect()
}

fn read_preview_edges(
    db: &Connection,
    view_id: &TranscriptViewId,
    last: u64,
) -> LedgerResult<PreviewEdges> {
    let mut statement = db
        .prepare_cached(
            "SELECT view_id, ordinal, kind, at, client_message_id,
            CASE WHEN length(CAST(payload_json AS BLOB)) <= ? THEN payload_json END AS payload_json
        FROM transcript_rows
        WHERE view_id = ? AND ordinal BETWEEN ? AND ? AND kind IN ('user-input', 'provider-row')
        ORDER BY ordinal",
        )
        .map_err(as_error)?;
    let mut edge = |start, end| -> LedgerResult<(Vec<LedgerRow>, Option<u64>)> {
        let mut first_omission = None;
        let mut decoded = Vec::new();
        let mut rows = statement
            .query(params![
                PREVIEW_ROW_BYTES,
                view_id.as_str(),
                bind_ordinal(start),
                bind_ordinal(end)
            ])
            .map_err(as_error)?;
        while let Some(row) = rows.next().map_err(as_error)? {
            if matches!(row.get_ref(5).map_err(as_error)?, ValueRef::Null) {
                if first_omission.is_none() {
                    first_omission = Some(
                        non_negative_integer(row.get(1).map_err(as_error)?, 1).map_err(as_error)?,
                    );
                }
            } else {
                decoded.push(decode_stored_ledger_row(
                    &read_stored_row(row).map_err(as_error)?,
                )?);
            }
        }
        Ok((decoded, first_omission))
    };
    let (head, first_omitted_head_ordinal) = edge(1, PREVIEW_EDGE_ROWS)?;
    let (tail, _) = edge(last.saturating_sub(PREVIEW_EDGE_ROWS - 1).max(1), last)?;
    Ok(PreviewEdges {
        head,
        first_omitted_head_ordinal,
        tail,
    })
}
