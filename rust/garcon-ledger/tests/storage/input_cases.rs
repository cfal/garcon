use garcon_base::errors::{DiagnosticError, ErrorInput, diagnostic_error_code};
use garcon_cases::{CaseError, replay, text, unknown};
use garcon_contract::{
    chat_types::UserMessage,
    preambles::{
        PendingPreambleBoundary, Preamble, PreambleDefinition, PreambleScope, PreambleTagFilter,
        PreambleTagMatchMode,
    },
};
use garcon_js::json::from_slice;
use garcon_ledger::{
    codec::{EncodedLedgerDraft, encode_ledger_draft},
    contracts::LedgerUserInputDetail,
    errors::LedgerCodecError,
    input_submission::input_detail,
    preamble_application::prepare_preamble_input,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareInput {
    at: String,
    client_message_id: Option<String>,
    boundary: Option<PendingPreambleBoundary>,
    preambles: Vec<PreambleContent>,
}

#[derive(Deserialize)]
struct PreambleContent {
    id: String,
    title: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    detail: LedgerUserInputDetail,
    drafts: Vec<EncodedLedgerDraft>,
    provider_prefix: String,
}

fn user_message(at: &str, content: &str) -> UserMessage {
    UserMessage {
        timestamp: at.into(),
        content: content.into(),
        images: None,
        metadata: None,
        presentation: None,
    }
}

fn serialized(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn error_case(error: Box<dyn std::error::Error>) -> CaseError {
    let name = match error.downcast_ref::<LedgerCodecError>() {
        Some(error) => error.diagnostic_metadata().name,
        None => diagnostic_error_code(ErrorInput::Error(error.as_ref())),
    };
    CaseError::new(name, error.to_string())
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "inputDetailFixture" => {
            let arg = |i: usize| text(function, args.get(i));
            let required = |i| arg(i)?.ok_or_else(|| CaseError::undeliverable("expected string"));
            let steer = args
                .get(3)
                .and_then(Value::as_bool)
                .ok_or_else(|| CaseError::undeliverable("expected steer flag"))?;
            serialized(input_detail(
                user_message(required(0)?, required(1)?),
                Vec::new(),
                arg(2)?.map(str::to_owned),
                steer,
            ))
        }
        "preparePreambleInputFixture" => {
            let input: PrepareInput =
                serde_json::from_value(unknown(function, args.first())?.into_owned())
                    .map_err(|error| CaseError::undeliverable(error.to_string()))?;
            let preambles = input
                .preambles
                .into_iter()
                .map(|item| Preamble {
                    id: item.id,
                    created_at: input.at.clone(),
                    updated_at: input.at.clone(),
                    definition: PreambleDefinition {
                        enabled: true,
                        title: item.title,
                        snippet_short_name: None,
                        content: item.content,
                        scope: PreambleScope::Global,
                        agent_ids: Vec::new(),
                        tag_filter: PreambleTagFilter {
                            mode: PreambleTagMatchMode::Any,
                            tags: Vec::new(),
                        },
                    },
                })
                .collect::<Vec<_>>();
            let detail = input_detail(
                user_message(&input.at, "Synthetic prompt"),
                Vec::new(),
                input.client_message_id,
                false,
            );
            let prepared = prepare_preamble_input(
                "synthetic-chat",
                &input.at,
                &detail,
                input.boundary.as_ref(),
                &preambles,
            )
            .map_err(error_case)?;
            let drafts = prepared
                .drafts
                .iter()
                .map(encode_ledger_draft)
                .collect::<Result<_, _>>()
                .map_err(|error| error_case(Box::new(error)))?;
            serialized(Prepared {
                detail: prepared.detail,
                drafts,
                provider_prefix: prepared.provider_prefix,
            })
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn input_cases_match_bun() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/input"),
        dispatch,
    );
    assert_eq!(stats.passed, stats.total);
}
