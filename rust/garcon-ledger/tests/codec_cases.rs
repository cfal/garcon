use garcon_base::errors::{DiagnosticError, NamedError};
use garcon_cases::{CaseError, replay, text, unknown};
use garcon_js::{
    Number,
    json::{as_number, from_slice},
};
use garcon_ledger::{
    codec::{
        DecodeClonedStoredRowsError, StoredLedgerRow, cli_row_fingerprint,
        decode_cloned_stored_rows, decode_ledger_row, decode_stored_ledger_row,
        encode_ledger_draft, parse_ledger_cli_row_notice_detail,
        parse_ledger_preamble_selection_changed_notice_detail, submission_fingerprint,
    },
    contracts::{
        LedgerRowData, LedgerRowDraft, is_conversational_ledger_row,
        is_ledger_cli_row_notice_detail, is_ledger_cli_row_notice_row,
        is_ledger_preamble_selection_changed_notice_detail,
        is_ledger_preamble_selection_changed_notice_row, is_presentation_only_provider_row,
        project_ledger_agent_command_outcome, project_ledger_ticket_command_outcome,
        transcript_view_id,
    },
    errors::{LedgerCodecError, LedgerError, UndecodableLedgerRowError, safe_fence_diagnostic},
};
use serde::Serialize;
use serde_json::{Value, json};

fn serialized(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn codec_error_properties(error: &LedgerCodecError) -> serde_json::Map<String, Value> {
    match error {
        LedgerCodecError::MalformedStoredJson(error) => {
            [(String::from("subject"), json!(error.subject))]
                .into_iter()
                .collect()
        }
        _ => Default::default(),
    }
}

fn codec_error(error: LedgerCodecError) -> CaseError {
    let mut result = CaseError::new(error.diagnostic_metadata().name, error.to_string());
    for (key, value) in codec_error_properties(&error) {
        result = result.with_property(key, value);
    }
    result
}

fn wrapped_row_error(error: UndecodableLedgerRowError) -> CaseError {
    let metadata = error.diagnostic_metadata();
    let mut wrapped = CaseError::new(metadata.name, error.to_string()).with_property(
        "cause",
        json!({
            "$": "error",
            "name": error.cause.diagnostic_metadata().name,
            "message": error.cause.to_string(),
            "properties": codec_error_properties(&error.cause),
        }),
    );
    if let Some(code) = metadata.code {
        wrapped = wrapped.with_property("code", code);
    }
    wrapped
}

fn row_argument(value: &Value) -> Result<StoredLedgerRow, CaseError> {
    let invalid = || CaseError::undeliverable("expected a SQLite row with the stored shape");
    let string = |key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(invalid)
    };
    Ok(StoredLedgerRow {
        view_id: string("view_id")?,
        ordinal: Number(
            value
                .get("ordinal")
                .and_then(as_number)
                .ok_or_else(invalid)?,
        ),
        kind: string("kind")?,
        at: string("at")?,
        client_message_id: if value.get("client_message_id").is_some_and(Value::is_null) {
            None
        } else {
            Some(string("client_message_id")?)
        },
        payload_json: string("payload_json")?,
    })
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let arg = |index: usize| unknown(function, args.get(index));
    let string = |index: usize| {
        text(function, args.get(index))?
            .ok_or_else(|| CaseError::undeliverable("expected a string"))
    };
    let row = || row_argument(arg(0)?.as_ref());
    let decode = || decode_ledger_row(&row()?).map_err(codec_error);
    match function {
        "decodeLedgerRow" => serialized(decode()?),
        "decodeStoredLedgerRow" => {
            serialized(decode_stored_ledger_row(&row()?).map_err(wrapped_row_error)?)
        }
        "decodeClonedStoredRows" => {
            let input = arg(0)?;
            let rows = input
                .as_array()
                .ok_or_else(|| CaseError::undeliverable("expected an array"))?;
            serialized(
                decode_cloned_stored_rows(rows).map_err(|error| match error {
                    DecodeClonedStoredRowsError::InvalidInput => {
                        CaseError::new("TypeError", error.to_string())
                    }
                    DecodeClonedStoredRowsError::InvalidRow(error) => wrapped_row_error(error),
                })?,
            )
        }
        "encodeDecodedLedgerDraft" => {
            let row = decode()?;
            serialized(
                encode_ledger_draft(&LedgerRowDraft {
                    at: row.at,
                    provider_meta: row.provider_meta,
                    data: row.data,
                })
                .map_err(codec_error)?,
            )
        }
        "classifyDecodedLedgerRow" => {
            let row = decode()?;
            Ok(json!({
                "conversational": is_conversational_ledger_row(&row),
                "presentationOnly": is_presentation_only_provider_row(&row),
                "cliRow": is_ledger_cli_row_notice_row(&row),
                "preambleSelection": is_ledger_preamble_selection_changed_notice_row(&row),
            }))
        }
        "fingerprintDecodedSubmission" => match decode()?.data {
            LedgerRowData::UserInput { detail } => {
                serialized(submission_fingerprint(&detail).map_err(codec_error)?)
            }
            _ => Ok(Value::Null),
        },
        "fingerprintDecodedCliRow" => {
            let detail =
                parse_ledger_cli_row_notice_detail(arg(1)?.as_ref()).map_err(codec_error)?;
            match detail {
                Some(detail) => {
                    serialized(cli_row_fingerprint(string(0)?, &detail).map_err(codec_error)?)
                }
                None => Ok(Value::Null),
            }
        }
        "parseLedgerCliRowNoticeDetail" => {
            serialized(parse_ledger_cli_row_notice_detail(arg(0)?.as_ref()).map_err(codec_error)?)
        }
        "parseLedgerPreambleSelectionChangedNoticeDetail" => serialized(
            parse_ledger_preamble_selection_changed_notice_detail(arg(0)?.as_ref())
                .map_err(codec_error)?,
        ),
        "isLedgerCliRowNoticeDetail" => {
            Ok(json!(is_ledger_cli_row_notice_detail(arg(0)?.as_ref())))
        }
        "isLedgerPreambleSelectionChangedNoticeDetail" => Ok(json!(
            is_ledger_preamble_selection_changed_notice_detail(arg(0)?.as_ref())
        )),
        "projectLedgerAgentCommandOutcome" => {
            serialized(project_ledger_agent_command_outcome(arg(0)?.as_ref()))
        }
        "projectLedgerTicketCommandOutcome" => {
            serialized(project_ledger_ticket_command_outcome(arg(0)?.as_ref()))
        }
        "transcriptViewId" => serialized(transcript_view_id(string(0)?).map_err(codec_error)?),
        "fenceDiagnostic" => {
            let cause = NamedError {
                name: string(0)?.into(),
                message: "synthetic detail".into(),
                code: Some(string(1)?.into()),
            };
            let error: Box<dyn std::error::Error> = if arg(2)?.as_bool() == Some(true) {
                Box::new(LedgerError::Fenced {
                    chat_id: "synthetic-chat".into(),
                    cause: Box::new(cause),
                })
            } else {
                Box::new(cause)
            };
            serialized(safe_fence_diagnostic(error.as_ref()))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn codec_cases_match_bun() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/codec"),
        dispatch,
    );
    assert_eq!(stats.passed, stats.total);
}
