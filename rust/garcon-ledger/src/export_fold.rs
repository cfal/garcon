use std::collections::HashMap;

use garcon_contract::{
    chat_export_contracts::{TranscriptExportCategory, TranscriptExportOmittedCount},
    chat_types::ChatMessage,
    transcript_entry_categories::{
        TranscriptEntryCategory, TranscriptEntryOptionalCategory,
        transcript_entry_category_for_message,
    },
};
use garcon_interface::producer::AgentRunFailureDetail;
use serde::Serialize;

use crate::{
    contracts::{LedgerRow, LedgerRowData, RunOrigin, RunOutcome},
    presentation::ledger_row_to_message,
};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum TranscriptExportEntry {
    Message {
        ordinal: u64,
        category: TranscriptEntryCategory,
        message: Box<ChatMessage>,
    },
    RunEnded {
        ordinal: u64,
        category: TranscriptEntryOptionalCategory,
        at: String,
        outcome: RunOutcome,
        origin: RunOrigin,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<AgentRunFailureDetail>,
    },
}

impl TranscriptExportEntry {
    fn optional_category(&self) -> Option<TranscriptExportCategory> {
        match self {
            Self::Message {
                category: TranscriptEntryCategory::Conversation,
                ..
            } => None,
            Self::Message {
                category: TranscriptEntryCategory::Optional(category),
                ..
            }
            | Self::RunEnded { category, .. } => Some(*category),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct FilteredTranscriptExportEntries {
    pub entries: Vec<TranscriptExportEntry>,
    pub omitted: Vec<TranscriptExportOmittedCount>,
}

pub fn fold_rows_for_export(chat_id: &str, rows: &[LedgerRow]) -> Vec<TranscriptExportEntry> {
    rows.iter()
        .filter_map(|row| {
            let ordinal = row.ordinal;
            match &row.data {
                LedgerRowData::Session { .. } => None,
                LedgerRowData::RunEnded {
                    outcome,
                    origin,
                    error,
                } => Some(TranscriptExportEntry::RunEnded {
                    ordinal,
                    category: TranscriptEntryOptionalCategory::Diagnostics,
                    at: row.at.clone(),
                    outcome: *outcome,
                    origin: *origin,
                    error: error.clone(),
                }),
                _ => ledger_row_to_message(chat_id, row).map(|message| {
                    TranscriptExportEntry::Message {
                        ordinal,
                        category: export_category_for_message(&message),
                        message: Box::new(message),
                    }
                }),
            }
        })
        .collect()
}

pub fn filter_transcript_export_entries(
    entries: Vec<TranscriptExportEntry>,
    exclusions: &[TranscriptExportCategory],
) -> FilteredTranscriptExportEntries {
    let mut counts: HashMap<_, u64> = exclusions.iter().map(|category| (*category, 0)).collect();
    let entries = entries
        .into_iter()
        .filter(|entry| {
            let Some(count) = entry
                .optional_category()
                .and_then(|category| counts.get_mut(&category))
            else {
                return true;
            };
            *count += 1;
            false
        })
        .collect();
    let omitted = exclusions
        .iter()
        .map(|category| TranscriptExportOmittedCount {
            category: *category,
            count: counts[category],
        })
        .collect();
    FilteredTranscriptExportEntries { entries, omitted }
}

pub fn export_category_for_message(message: &ChatMessage) -> TranscriptEntryCategory {
    transcript_entry_category_for_message(message)
}
