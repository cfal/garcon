use std::pin::pin;

use futures::TryStreamExt;
use garcon_base::{domain_error::DomainError, event_loop::EventLoopSteps};
use garcon_contract::{
    error_codes::ErrorCode, transcript_notice_details::is_preamble_application_notice_detail,
};
use garcon_js::{is_safe_integer, json::as_number};
use serde_json::json;

use crate::{
    contracts::{
        LedgerNoticeDetail, LedgerRowData, LedgerRowDraft, TranscriptView, TranscriptViewId,
        project_ledger_agent_command_outcome, project_ledger_ticket_command_outcome,
    },
    preamble_history::PreambleHistoryCollector,
    sqlite_operations::LedgerResult,
    store::{StageViewInput, TranscriptReadSignal},
};

use super::{ClearChatEntry, TranscriptClearService, session_draft};

impl TranscriptClearService {
    pub(super) async fn stage_before_message(
        &self,
        chat_id: &str,
        current: &TranscriptView,
        entry: &ClearChatEntry,
        ordinal: u64,
        signal: TranscriptReadSignal<'_>,
    ) -> LedgerResult<TranscriptView> {
        let store = self.0.ledger.store();
        let watermark = store.high_watermark(chat_id)?;
        if ordinal == 0 || !is_safe_integer(ordinal as f64) || ordinal > watermark.ordinal {
            return Err(invalid_target().into());
        }
        let target_rows = store
            .page(chat_id, &current.view_id, 2, Some(ordinal + 1))?
            .rows;
        if !target_rows.last().is_some_and(|row| {
            row.ordinal == ordinal && matches!(row.data, LedgerRowData::UserInput { .. })
        }) {
            return Err(invalid_target().into());
        }
        let retained_start = match target_rows.as_slice() {
            [previous, _]
                if matches!(&previous.data,
                LedgerRowData::Notice { detail: LedgerNoticeDetail::Other(detail), .. }
                if is_preamble_application_notice_detail(detail)) =>
            {
                previous.ordinal
            }
            _ => ordinal,
        };
        let session = store.current_session(chat_id)?;
        let mut collector = PreambleHistoryCollector::default();
        let mut retained = Vec::new();
        let mut steps = EventLoopSteps::new("ledger-clear-before");
        let scan_start = if session.is_some() {
            retained_start.min(current.content_start_ordinal)
        } else {
            retained_start
        };
        let mut pages =
            pin!(store.row_pages_through(chat_id, &watermark, scan_start, Some(signal)));
        while let Some(page) = pages.try_next().await? {
            for row in page {
                signal.check()?;
                if session.is_some() && row.ordinal >= current.content_start_ordinal {
                    collector.add_row(&row)?;
                }
                if row.ordinal >= retained_start {
                    retained.push(LedgerRowDraft {
                        at: row.at,
                        provider_meta: row.provider_meta,
                        data: row.data,
                    });
                }
                steps.next().await;
            }
        }
        self.flush_boundary(chat_id, entry).await?;
        let removed_evidence = collector.finish_before(retained_start)?;
        let retained_frozen_count = current.content_start_ordinal.saturating_sub(retained_start);
        let mut support = session
            .filter(|session| session.ordinal < retained_start || !removed_evidence.is_empty())
            .map(|session| session_draft(session, &removed_evidence));
        let has_support = support.is_some();
        let view_id = store.new_view_id()?;
        let mut drafts = Vec::with_capacity(retained.len() + usize::from(has_support));
        for (index, mut draft) in retained.into_iter().enumerate() {
            signal.check()?;
            if index as u64 == retained_frozen_count
                && let Some(support) = support.take()
            {
                drafts.push(support);
            }
            remap_command_correlation(
                &mut draft,
                &current.view_id,
                &view_id,
                retained_start,
                watermark.ordinal,
                retained_frozen_count,
                has_support,
            );
            drafts.push(draft);
            steps.next().await;
        }
        if let Some(support) = support {
            drafts.push(support);
        }
        signal.check()?;
        store
            .stage_view(
                chat_id,
                StageViewInput {
                    view_id,
                    content_start_ordinal: retained_frozen_count + 1,
                    rows: &drafts,
                },
            )
            .await
    }
}

fn remap_command_correlation(
    draft: &mut LedgerRowDraft,
    original: &TranscriptViewId,
    replacement: &TranscriptViewId,
    from: u64,
    through: u64,
    retained_frozen_count: u64,
    has_support: bool,
) {
    let LedgerRowData::Notice {
        detail: LedgerNoticeDetail::Other(detail),
        ..
    } = &mut draft.data
    else {
        return;
    };
    if detail["requestViewId"].as_str() != Some(original.as_str())
        || (project_ledger_agent_command_outcome(detail).is_none()
            && project_ledger_ticket_command_outcome(detail).is_none())
    {
        return;
    }
    let Some(ordinal) = as_number(&detail["requestOrdinal"])
        .map(|ordinal| ordinal as u64)
        .filter(|ordinal| (from..=through).contains(ordinal))
    else {
        return;
    };
    let retained_index = ordinal - from;
    let new_ordinal =
        retained_index + 1 + u64::from(has_support && retained_index >= retained_frozen_count);
    let mut wire = std::mem::take(detail).into_value();
    wire["requestViewId"] = json!(replacement);
    wire["requestOrdinal"] = json!(new_ordinal);
    *detail = wire.into();
}

fn invalid_target() -> DomainError {
    DomainError::new(
        ErrorCode::VALIDATION_FAILED,
        "Clear before message requires a user message in the confirmed transcript.",
        422,
        false,
    )
}
