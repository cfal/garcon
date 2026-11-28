use futures::TryStreamExt;
use garcon_base::{domain_error::DomainError, event_loop::EventLoopSteps};
use garcon_contract::{
    chat_types::ChatMessage,
    error_codes::ErrorCode,
    transcript_seed::{SanitizeCarriedContextResult, sanitize_recorded_carried_context},
};
use garcon_interface::{
    native_history::{AgentHistoryImport, AgentHistoryImportRequest},
    transcript::AgentChatReference,
};

use crate::{
    contracts::LedgerRowDraft,
    imported_drafts::{ImportedRow, imported_drafts},
    preamble_history::PreambleHistoryEvidence,
    preamble_sanitation::{SanitizePreamblePrefixesResult, sanitize_recorded_preamble_prefixes},
    sqlite_operations::LedgerResult,
    store::TranscriptReadSignal,
};

pub type NativeHistoryProgress<'a> = dyn Fn(usize) -> LedgerResult<()> + 'a;

pub struct NativeHistorySeedInput<'a> {
    pub chat: AgentChatReference,
    pub importer: &'a dyn AgentHistoryImport,
    pub signal: TranscriptReadSignal<'a>,
    pub now: &'a dyn Fn() -> LedgerResult<String>,
    pub preamble_evidence: &'a [PreambleHistoryEvidence],
    pub on_rows_read: Option<&'a NativeHistoryProgress<'a>>,
}

/// Imports the selected binding only; callers decide when that source is eligible.
pub async fn import_native_history_drafts(
    input: NativeHistorySeedInput<'_>,
) -> LedgerResult<Vec<LedgerRowDraft>> {
    let session_id = input.chat.agent_session_id.clone();
    let receipt = input.chat.native_seed_receipt.clone();
    let mut source = input.importer.load(
        AgentHistoryImportRequest {
            chat: input.chat,
            signal: input.signal.token().clone(),
        },
        None,
    );
    let mut steps = EventLoopSteps::new("native-history-import");
    let mut rows = Vec::new();
    let mut first_user = None;
    while let Some(batch) = source.try_next().await? {
        input.signal.check()?;
        for row in batch {
            input.signal.check()?;
            if first_user.is_none() && matches!(row.message, ChatMessage::User(_)) {
                first_user = Some(rows.len());
            }
            rows.push(ImportedRow {
                message: row.message,
                provider_meta: row.provider_meta,
                preamble_application: None,
            });
            steps.next().await;
        }
        if let Some(on_rows_read) = input.on_rows_read {
            on_rows_read(rows.len())?;
        }
        steps.next().await;
    }
    input.signal.check()?;
    if let Some(receipt) = receipt.as_ref() {
        let seed_candidate = first_user.map(|index| rows[index].message.clone());
        match sanitize_recorded_carried_context(
            seed_candidate.into_iter().collect(),
            Some(receipt),
            session_id.as_deref(),
        ) {
            SanitizeCarriedContextResult::Mismatch { .. } => {
                return Err(DomainError::new(
                    ErrorCode::CONTEXT_ENVELOPE_MISMATCH,
                    "The native transcript seed does not match this chat.",
                    422,
                    false,
                )
                .into());
            }
            SanitizeCarriedContextResult::StrippedExact { mut messages } => {
                if let (Some(index), Some(message)) = (first_user, messages.pop()) {
                    rows[index].message = message;
                }
            }
            SanitizeCarriedContextResult::NotApplicable { .. }
            | SanitizeCarriedContextResult::Absent { .. } => {}
        }
    }
    match sanitize_recorded_preamble_prefixes(
        rows,
        input.preamble_evidence,
        &mut steps,
        input.signal,
    )
    .await?
    {
        SanitizePreamblePrefixesResult::Sanitized(rows) => {
            imported_drafts(rows, &|| (input.now)(), &mut steps, Some(input.signal)).await
        }
        SanitizePreamblePrefixesResult::NotYetPersisted(_) => Err(DomainError::new(
            ErrorCode::HISTORY_LOAD_FAILED,
            "The native transcript has not persisted the completed turn yet. Try again shortly.",
            409,
            true,
        )
        .into()),
        SanitizePreamblePrefixesResult::Mismatch(_) => Err(DomainError::new(
            ErrorCode::PREAMBLE_ENVELOPE_MISMATCH,
            "The native transcript preamble envelope does not match this chat.",
            422,
            false,
        )
        .into()),
    }
}
