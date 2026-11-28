use garcon_base::errors::DiagnosticError;
use garcon_cases::{CaseError, replay, unknown};
use garcon_js::{
    Number,
    json::{from_slice, stringify},
};
use garcon_ledger::{
    codec::{StoredLedgerRow, decode_ledger_row},
    preamble_history::{
        PreambleHistoryCollector, collect_preamble_history_evidence,
        retained_preamble_history_metadata,
    },
};
use serde_json::{Value, json};

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    if function != "preambleHistoryFixture" {
        return Err(CaseError::unhandled(function));
    }
    let rows = unknown(function, args.first())?;
    let borrowed = rows
        .as_array()
        .ok_or_else(|| CaseError::undeliverable("Expected fixture rows"))?;
    let decoded = borrowed
        .iter()
        .enumerate()
        .map(|(index, spec)| {
            decode_ledger_row(&StoredLedgerRow {
                view_id: "evidence-view".into(),
                kind: spec[0]
                    .as_str()
                    .ok_or_else(|| CaseError::undeliverable("Expected fixture kind"))?
                    .into(),
                ordinal: Number((index + 1) as f64),
                at: "synthetic-time".into(),
                client_message_id: None,
                payload_json: stringify(&json!({"providerMeta": spec[2], "value": spec[1]})),
            })
            .map_err(|error| CaseError::new(error.diagnostic_metadata().name, error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let error = |error: garcon_ledger::preamble_history::PreambleHistoryError| {
        CaseError::new("Error", error.to_string())
    };
    let evidence = if let Some(value) = args.get(1) {
        let ordinal = unknown(function, Some(value))?;
        let ordinal = ordinal
            .as_f64()
            .ok_or_else(|| CaseError::undeliverable("Expected fixture cutoff"))?;
        let mut collector = PreambleHistoryCollector::default();
        for row in &decoded {
            collector.add_row(row).map_err(error)?;
        }
        collector.finish_before(ordinal as u64)
    } else {
        collect_preamble_history_evidence(&decoded)
    }
    .map_err(error)?;
    let metadata = retained_preamble_history_metadata(&evidence);
    let encoded = serde_json::to_vec(&json!({ "evidence": evidence, "metadata": metadata }))
        .map_err(|error| CaseError::undeliverable(error.to_string()))?;
    from_slice(&encoded).map_err(|error| CaseError::undeliverable(error.to_string()))
}

#[test]
fn preamble_history_retains_the_original_receipt_set_at_each_cutoff() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/preamble-history"),
        dispatch,
    );
    assert_eq!(stats.total, stats.passed);
}
