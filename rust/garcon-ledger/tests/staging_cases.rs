use std::error::Error;

use garcon_base::errors::{DiagnosticError, error_metadata};
use garcon_cases::{CaseError, replay, text, unknown};
use garcon_contract::chat_types::UserMessage;
use garcon_js::json::from_slice;
use garcon_ledger::{
    contracts::{LedgerNoticeDetail, LedgerRowData, LedgerRowDraft, transcript_view_id},
    errors::{LedgerCodecError, LedgerError},
    input_submission::input_detail,
    staging_views::{encode_drafts, materialize_rows},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const AT: &str = "2026-11-28T09:00:00.000Z";

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum FixtureDraft {
    Notice { content: String },
    Input { content: String, id: Option<String> },
}

fn draft(item: FixtureDraft) -> LedgerRowDraft {
    let data = match item {
        FixtureDraft::Notice { content } => LedgerRowData::Notice {
            message: content,
            detail: LedgerNoticeDetail::Other(json!({}).into()),
        },
        FixtureDraft::Input { content, id } => LedgerRowData::UserInput {
            detail: input_detail(
                UserMessage {
                    timestamp: AT.into(),
                    content,
                    images: None,
                    metadata: None,
                    presentation: None,
                },
                Vec::new(),
                id,
                false,
            ),
        },
    };
    LedgerRowDraft {
        at: AT.into(),
        provider_meta: None,
        data,
    }
}

fn error_case(error: Box<dyn Error>) -> CaseError {
    let error = error.as_ref();
    let name = if let Some(error) = error.downcast_ref::<LedgerError>() {
        error.diagnostic_metadata().name
    } else if let Some(error) = error.downcast_ref::<LedgerCodecError>() {
        error.diagnostic_metadata().name
    } else {
        error_metadata(error).name
    };
    CaseError::new(name, error.to_string())
}

fn serialize(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let rows: Vec<FixtureDraft> =
        serde_json::from_value(unknown(function, args.first())?.into_owned())
            .map_err(|error| CaseError::undeliverable(error.to_string()))?;
    let rows: Vec<_> = rows.into_iter().map(draft).collect();
    match function {
        "encodeStagedDraftsFixture" => {
            let rows = encode_drafts(&rows).map_err(error_case)?;
            serialize(rows.into_iter().map(|row| row.encoded).collect::<Vec<_>>())
        }
        "materializeStagedDraftsFixture" => {
            let view = text(function, args.get(1))?
                .ok_or_else(|| CaseError::undeliverable("expected view ID"))?;
            let view = transcript_view_id(view).map_err(|error| error_case(Box::new(error)))?;
            let ordinal = args
                .get(2)
                .and_then(Value::as_u64)
                .ok_or_else(|| CaseError::undeliverable("expected unsigned ordinal"))?;
            let rows = encode_drafts(&rows).map_err(error_case)?;
            serialize(materialize_rows(&view, &rows, ordinal).map_err(error_case)?)
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn staging_helpers_replay_against_bun() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/staging"),
        dispatch,
    );
    assert_eq!(stats.passed, stats.total);
}
