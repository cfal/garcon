use garcon_base::{errors::error_metadata, event_loop::EventLoopSteps};
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::{
    chat_message_coercion::{ChatContentMode, ChatMessageMetadata},
    chat_types::{ChatMessage, UserMessage},
    preamble_prefix::{PreamblePrefixFormat, PreamblePrefixReceipt, preamble_prefix_sha256},
    preambles::PendingPreambleBoundary,
    transcript_notice_details::AppliedPreambleReference,
};
use garcon_js::{json::from_slice, utf16};
use garcon_ledger::{
    imported_drafts::ImportedRow,
    preamble_history::PreambleHistoryEvidence,
    preamble_sanitation::{SanitizePreamblePrefixesResult, sanitize_recorded_preamble_prefixes},
    store::TranscriptReadSignal,
};
use serde::Serialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn fixture_error(error: impl std::fmt::Display) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

async fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    if function != "sanitizePreambleFixture" {
        return Err(CaseError::unhandled(function));
    }
    let raw = unknown(function, args.first())?;
    let evidence = unknown(function, args.get(1))?;
    let raw: Vec<Vec<Value>> = serde_json::from_value(raw.into_owned()).map_err(fixture_error)?;
    let evidence: Vec<(String, bool)> =
        serde_json::from_value(evidence.into_owned()).map_err(fixture_error)?;
    let evidence: Vec<_> = evidence
        .into_iter()
        .enumerate()
        .map(
            |(index, (prefix, requires_native_occurrence))| PreambleHistoryEvidence {
                receipt: PreamblePrefixReceipt {
                    format: PreamblePrefixFormat::PreambleV1,
                    code_unit_length: utf16::len(&prefix),
                    sha256: preamble_prefix_sha256(prefix.encode_utf16()),
                },
                boundary: PendingPreambleBoundary::NewChat {
                    ownership_epoch: format!("epoch-{index}"),
                },
                preambles: vec![AppliedPreambleReference {
                    id: "3502b645-222b-49d2-ac39-1c91f9fb1174".into(),
                    title: "Synthetic rules".into(),
                }],
                requires_native_occurrence,
            },
        )
        .collect();
    let rows = raw
        .into_iter()
        .map(|row| {
            let content = row
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| fixture_error("Expected synthetic message"))?;
            let metadata = row
                .get(1)
                .and_then(Value::as_bool)
                .unwrap_or_default()
                .then(|| {
                    let mut metadata = ChatMessageMetadata::default();
                    metadata.content_mode = Some(ChatContentMode::Literal);
                    metadata
                });
            Ok(ImportedRow {
                message: ChatMessage::User(UserMessage {
                    timestamp: "synthetic-time".into(),
                    content: content.into(),
                    metadata,
                    images: None,
                    presentation: None,
                }),
                provider_meta: None,
                preamble_application: None,
            })
        })
        .collect::<Result<Vec<_>, CaseError>>()?;
    let token = CancellationToken::new();
    let result = sanitize_recorded_preamble_prefixes(
        rows,
        &evidence,
        &mut EventLoopSteps::new("native-history-import"),
        TranscriptReadSignal::new(&token),
    )
    .await
    .map_err(|error| CaseError::new(error_metadata(error.as_ref()).name, error.to_string()))?;
    #[derive(Serialize)]
    struct Message {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        application: Option<PreambleHistoryEvidence>,
    }
    let result = match result {
        SanitizePreamblePrefixesResult::Sanitized(rows) => {
            let messages = rows
                .into_iter()
                .map(|row| {
                    let ChatMessage::User(user) = row.message else {
                        return Err(fixture_error(
                            "The port returned a non-user message for a user-only fixture",
                        ));
                    };
                    Ok(Message {
                        content: user.content,
                        application: row.preamble_application,
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            json!({ "kind": "sanitized", "messages": messages })
        }
        SanitizePreamblePrefixesResult::NotYetPersisted(reason) => {
            json!({ "kind": "not-yet-persisted", "reason": reason })
        }
        SanitizePreamblePrefixesResult::Mismatch(reason) => {
            json!({ "kind": "mismatch", "reason": reason })
        }
    };
    from_slice(&serde_json::to_vec(&result).map_err(fixture_error)?).map_err(fixture_error)
}

#[test]
fn tlv5_preamble_04_native_unit_01_receipts_match_bun() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/preamble-sanitation"
        ),
        |function, args| runtime.block_on(dispatch(function, args)),
    );
    assert_eq!(stats.total, stats.passed);
}
