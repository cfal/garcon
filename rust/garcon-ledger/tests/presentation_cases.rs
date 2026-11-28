use garcon_base::errors::DiagnosticError;
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::{
    chat_export_contracts::TranscriptExportCategory, json::stable_json_stringify,
};
use garcon_js::{Number, json::from_slice};
use garcon_ledger::{
    codec::{EncodedLedgerDraft, StoredLedgerRow, decode_ledger_row, encode_ledger_draft},
    contracts::LedgerRow,
    export_fold::{filter_transcript_export_entries, fold_rows_for_export},
    presentation::{
        ledger_row_to_message, ledger_rows_to_messages, ledger_rows_to_transcript_messages,
    },
    projection::{PreviewEdges, frozen_conversation_drafts, preview_messages},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const CHAT_ID: &str = "synthetic-chat";
const AT: &str = "2026-11-28T09:00:00.000Z";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredInput {
    kind: String,
    ordinal: Option<u64>,
    client_message_id: Option<String>,
    value: Value,
}

fn row(input: StoredInput) -> Result<LedgerRow, CaseError> {
    decode_ledger_row(&StoredLedgerRow {
        view_id: "presentation-fixture".into(),
        ordinal: Number(input.ordinal.unwrap_or(1) as f64),
        kind: input.kind,
        at: AT.into(),
        client_message_id: input.client_message_id,
        payload_json: stable_json_stringify(&json!({"providerMeta":null,"value":input.value})),
    })
    .map_err(|error| CaseError::new(error.diagnostic_metadata().name, error.to_string()))
}

fn write(value: impl Serialize) -> Result<Value, CaseError> {
    serde_json::to_vec(&value)
        .map_err(|error| CaseError::undeliverable(error.to_string()))
        .and_then(|bytes| {
            from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
        })
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let arg = |index| unknown(function, args.get(index)).map(|value| value.into_owned());
    let one = || -> Result<LedgerRow, CaseError> {
        row(serde_json::from_value(arg(0)?)
            .map_err(|error| CaseError::undeliverable(error.to_string()))?)
    };
    let rows = |index| -> Result<Vec<LedgerRow>, CaseError> {
        let inputs: Vec<StoredInput> = serde_json::from_value(arg(index)?)
            .map_err(|error| CaseError::undeliverable(error.to_string()))?;
        inputs.into_iter().map(row).collect()
    };
    match function {
        "ledgerRowToMessageFixture" => write(ledger_row_to_message(CHAT_ID, &one()?)),
        "ledgerRowToMessageBytesFixture" => {
            serde_json::to_string(&ledger_row_to_message(CHAT_ID, &one()?))
                .map(Value::String)
                .map_err(|error| CaseError::undeliverable(error.to_string()))
        }
        "ledgerRowsToMessagesFixture" => write(ledger_rows_to_messages(CHAT_ID, &rows(0)?)),
        "ledgerRowsToTranscriptMessagesFixture" => {
            write(ledger_rows_to_transcript_messages(CHAT_ID, &rows(0)?))
        }
        "previewMessagesFixture" => write(preview_messages(&PreviewEdges {
            head: rows(0)?,
            first_omitted_head_ordinal: arg(1)?.as_u64(),
            tail: rows(2)?,
        })),
        "frozenDraftsFixture" => {
            #[derive(Serialize)]
            struct Draft<'a> {
                kind: &'static str,
                at: &'a str,
                #[serde(flatten)]
                encoded: EncodedLedgerDraft,
            }
            let drafts = frozen_conversation_drafts(&rows(0)?);
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
            write(encoded)
        }
        "exportFoldFixture" => {
            let exclusions: Vec<TranscriptExportCategory> = serde_json::from_value(arg(1)?)
                .map_err(|error| CaseError::undeliverable(error.to_string()))?;
            write(filter_transcript_export_entries(
                fold_rows_for_export(CHAT_ID, &rows(0)?),
                &exclusions,
            ))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn presentation_and_folds_match_recorded_bun_values_and_wire_bytes() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/presentation"),
        dispatch,
    );
    assert_eq!(stats.passed, stats.total);
}
