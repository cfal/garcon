use std::cell::Cell;

use garcon_base::{
    errors::{DiagnosticError, error_metadata},
    event_loop::EventLoopSteps,
};
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::{
    chat_types::parse_chat_message, preamble_prefix::PreamblePrefixReceipt,
    preambles::PendingPreambleBoundary, transcript_notice_details::AppliedPreambleReference,
};
use garcon_interface::native_history::AgentImportedTranscriptRow;
use garcon_js::json::from_slice;
use garcon_ledger::{
    codec::{EncodedLedgerDraft, encode_ledger_draft},
    imported_drafts::{ImportedRow, PreambleHistoryEvidence, frozen_drafts, imported_drafts},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedRowInput {
    #[serde(flatten)]
    row: AgentImportedTranscriptRow,
    preamble_application: Option<PreambleHistoryInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreambleHistoryInput {
    receipt: PreamblePrefixReceipt,
    boundary: PendingPreambleBoundary,
    preambles: Vec<PreambleRefInput>,
    requires_native_occurrence: bool,
}

#[derive(Deserialize)]
struct PreambleRefInput {
    id: String,
    title: String,
}

#[derive(Serialize)]
struct Draft<'a> {
    kind: &'static str,
    at: &'a str,
    #[serde(flatten)]
    encoded: EncodedLedgerDraft,
}

fn fixture_error(error: impl std::fmt::Display) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

async fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let rows = unknown(function, args.first())?;
    let timestamp = unknown(function, args.get(1))?;
    if !(timestamp.is_string() || timestamp.is_array()) {
        return Err(fixture_error("Expected timestamp or clock sequence"));
    }
    let tick = Cell::new(0);
    let now = || {
        timestamp
            .as_str()
            .or_else(|| {
                let index = tick.get();
                tick.set(index + 1);
                timestamp.get(index).and_then(Value::as_str)
            })
            .map(str::to_owned)
            .ok_or_else(|| "Fixture clock exhausted".into())
    };
    let mut steps = EventLoopSteps::new("transcript-import-conversion");
    let drafts = match function {
        "importedDraftsFixture" => {
            let rows: Vec<ImportedRowInput> =
                serde_json::from_value(rows.into_owned()).map_err(fixture_error)?;
            let rows = rows.into_iter().map(|input| ImportedRow {
                message: input.row.message,
                provider_meta: input.row.provider_meta,
                preamble_application: input.preamble_application.map(|item| {
                    PreambleHistoryEvidence {
                        receipt: item.receipt,
                        boundary: item.boundary,
                        preambles: item
                            .preambles
                            .into_iter()
                            .map(|reference| AppliedPreambleReference {
                                id: reference.id,
                                title: reference.title,
                            })
                            .collect(),
                        requires_native_occurrence: item.requires_native_occurrence,
                    }
                }),
            });
            imported_drafts(rows, &now, &mut steps, None).await
        }
        "frozenDraftsFixture" => {
            let messages = rows
                .as_array()
                .ok_or_else(|| fixture_error("Expected messages"))?
                .iter()
                .map(|raw| {
                    parse_chat_message(raw)
                        .map_err(fixture_error)?
                        .ok_or_else(|| fixture_error("Invalid fixture message"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            frozen_drafts(messages, &now, &mut steps, None).await
        }
        _ => return Err(CaseError::unhandled(function)),
    }
    .map_err(|error| CaseError::new(error_metadata(error.as_ref()).name, error.to_string()))?;
    let encoded = drafts
        .iter()
        .map(|draft| {
            let encoded = encode_ledger_draft(draft).map_err(|error| {
                CaseError::new(error.diagnostic_metadata().name, error.to_string())
            })?;
            Ok(Draft {
                kind: draft.data.kind(),
                at: &draft.at,
                encoded,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    from_slice(&serde_json::to_vec(&encoded).map_err(fixture_error)?).map_err(fixture_error)
}

#[test]
fn imported_and_frozen_drafts_match_bun_payload_bytes() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/imported-drafts"),
        |function, args| runtime.block_on(dispatch(function, args)),
    );
    assert_eq!(stats.passed, stats.total);
}
