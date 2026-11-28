use garcon_contract::{
    preamble_prefix::{PreamblePrefixReceipt, parse_preamble_prefix_receipt},
    preambles::{PendingPreambleBoundary, normalize_pending_preamble_boundary},
    transcript_notice_details::{
        AppliedPreambleReference, TranscriptNoticeDetail, parse_transcript_notice_detail,
    },
};
use garcon_js::json::Opaque;
use serde::Serialize;
use serde_json::{Value, json};

use crate::contracts::{LedgerNoticeDetail, LedgerRow, LedgerRowData, RunOrigin};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreambleHistoryEvidence {
    pub receipt: PreamblePrefixReceipt,
    pub boundary: PendingPreambleBoundary,
    pub preambles: Vec<AppliedPreambleReference>,
    pub requires_native_occurrence: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum PreambleHistoryError {
    #[error("Preamble application notice is not adjacent to its input receipt")]
    MissingInput,
    #[error("Preamble input receipt has no adjacent application notice")]
    MissingNotice,
    #[error("Invalid retained preamble history")]
    InvalidRetainedEvidence,
}

pub fn collect_preamble_history_evidence(
    rows: &[LedgerRow],
) -> Result<Vec<PreambleHistoryEvidence>, PreambleHistoryError> {
    let mut collector = PreambleHistoryCollector::default();
    for row in rows {
        collector.add_row(row)?;
    }
    collector.finish()
}

#[derive(Default)]
pub struct PreambleHistoryCollector {
    evidence: Vec<(u64, PreambleHistoryEvidence)>,
    active_applications: Vec<usize>,
    pending_preambles: Option<Vec<AppliedPreambleReference>>,
}

impl PreambleHistoryCollector {
    pub fn add_row(&mut self, row: &LedgerRow) -> Result<(), PreambleHistoryError> {
        use LedgerRowData::*;
        if matches!(&row.data, UserInput { detail } if !detail.steer) {
            self.active_applications.clear();
        }
        if self.pending_preambles.is_some() {
            let UserInput { detail } = &row.data else {
                return Err(PreambleHistoryError::MissingInput);
            };
            let (Some(boundary), Some(receipt)) =
                (&detail.preamble_boundary, &detail.preamble_prefix_receipt)
            else {
                return Err(PreambleHistoryError::MissingInput);
            };
            self.active_applications.push(self.evidence.len());
            self.evidence.push((
                row.ordinal,
                PreambleHistoryEvidence {
                    receipt: receipt.clone(),
                    boundary: boundary.clone(),
                    preambles: self.pending_preambles.take().unwrap_or_default(),
                    requires_native_occurrence: false,
                },
            ));
            return Ok(());
        }

        match &row.data {
            Notice {
                detail: LedgerNoticeDetail::Other(detail),
                ..
            } => {
                self.pending_preambles = parse_application(detail);
            }
            UserInput { detail } if detail.preamble_prefix_receipt.is_some() => {
                return Err(PreambleHistoryError::MissingNotice);
            }
            Session { .. } => {
                if let Some(retained) = row
                    .provider_meta
                    .as_ref()
                    .and_then(|meta| meta.get("garconPreambleHistory"))
                {
                    self.evidence.extend(
                        parse_retained_evidence(retained)?
                            .into_iter()
                            .map(|entry| (row.ordinal, entry)),
                    );
                }
            }
            RunEnded {
                origin: RunOrigin::Provider,
                ..
            } => {
                for index in self.active_applications.drain(..) {
                    self.evidence[index].1.requires_native_occurrence = true;
                }
            }
            _ => {}
        }
        Ok(())
    }

    pub fn finish(self) -> Result<Vec<PreambleHistoryEvidence>, PreambleHistoryError> {
        Ok(self.complete()?.into_iter().map(|(_, item)| item).collect())
    }

    pub fn finish_before(
        self,
        ordinal: u64,
    ) -> Result<Vec<PreambleHistoryEvidence>, PreambleHistoryError> {
        Ok(self
            .complete()?
            .into_iter()
            .filter(|(source, _)| *source < ordinal)
            .map(|(_, item)| item)
            .collect())
    }

    fn complete(self) -> Result<Vec<(u64, PreambleHistoryEvidence)>, PreambleHistoryError> {
        if self.pending_preambles.is_some() {
            return Err(PreambleHistoryError::MissingInput);
        }
        Ok(self.evidence)
    }
}

/// Retains the receipt and immutable title references, not the removed prompt or body.
pub fn retained_preamble_history_metadata(evidence: &[PreambleHistoryEvidence]) -> Option<Opaque> {
    (!evidence.is_empty()).then(|| json!({ "garconPreambleHistory": evidence }).into())
}

fn parse_retained_evidence(
    value: &Value,
) -> Result<Vec<PreambleHistoryEvidence>, PreambleHistoryError> {
    let invalid = || PreambleHistoryError::InvalidRetainedEvidence;
    value
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .map(|entry| {
            let receipt = parse_preamble_prefix_receipt(&entry["receipt"]).ok_or_else(invalid)?;
            let boundary =
                normalize_pending_preamble_boundary(&entry["boundary"]).ok_or_else(invalid)?;
            let preambles = parse_application(&json!({
                "type": "preamble-application", "preambles": entry["preambles"],
            }))
            .ok_or_else(invalid)?;
            let requires_native_occurrence = entry["requiresNativeOccurrence"]
                .as_bool()
                .ok_or_else(invalid)?;
            Ok(PreambleHistoryEvidence {
                receipt,
                boundary,
                preambles,
                requires_native_occurrence,
            })
        })
        .collect()
}

fn parse_application(value: &Value) -> Option<Vec<AppliedPreambleReference>> {
    if value["type"] != "preamble-application" {
        return None;
    }
    match parse_transcript_notice_detail(value)? {
        TranscriptNoticeDetail::PreambleApplication { preambles } => Some(preambles),
        _ => None,
    }
}
