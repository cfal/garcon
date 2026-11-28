use garcon_cases::{CaseError, replay, text, unknown};
use garcon_contract::{
    chat_export_contracts, chat_handoff_artifact_contracts, chat_id, chat_id_discovery,
    transcript_notice_details,
};
use serde::Serialize;
use serde_json::{Value, json};

fn value(result: impl Serialize) -> Value {
    garcon_js::json::from_str(&serde_json::to_string(&result).unwrap()).unwrap()
}

fn run(unit: &str, dispatch: impl Fn(&str, &[Value]) -> Result<Value, CaseError>) {
    let cases = format!("{}/tests/cases/common/{unit}", env!("CARGO_MANIFEST_DIR"));
    let stats = replay(cases, dispatch);
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn export_formats_categories_and_aliases_are_closed_and_ordered() {
    use chat_export_contracts::*;
    assert_eq!(value(TRANSCRIPT_EXPORT_FORMATS), json!(["markdown", "xml"]));
    assert_eq!(
        value(TRANSCRIPT_EXPORT_CATEGORIES),
        json!([
            "tool-calls",
            "tool-results",
            "reasoning",
            "permissions",
            "diagnostics",
            "handoffs"
        ]),
    );
    let [(alias, categories)] = TRANSCRIPT_EXPORT_CATEGORY_ALIASES else {
        panic!("expected the single export category alias")
    };
    assert_eq!(*alias, "tools");
    assert_eq!(value(categories), json!(["tool-calls", "tool-results"]));
}

#[test]
fn chat_id_discovery_cases_match() {
    use chat_id_discovery::*;
    use transcript_notice_details::ChatIdDiscoveryFailureReason;
    run("chat-id-discovery", |function, args| {
        let content =
            text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
        match function {
            "parseChatIdDisclosure" => Ok(value(parse_chat_id_disclosure(content))),
            "chatIdDisclosureContent" | "chatIdDisclosureNoticeContent" => {
                let chat_id = chat_id::parse_chat_id(&json!(content))
                    .map_err(|_| CaseError::unhandled(function))?;
                if function == "chatIdDisclosureContent" {
                    Ok(json!(chat_id_disclosure_content(&chat_id)))
                } else {
                    Ok(json!(chat_id_disclosure_notice_content(&chat_id)))
                }
            }
            "chatIdDiscoveryFailureContent" => {
                let reason: ChatIdDiscoveryFailureReason = match content {
                    "disabled" => ChatIdDiscoveryFailureReason::Disabled,
                    "delivery-failed" => ChatIdDiscoveryFailureReason::DeliveryFailed,
                    _ => return Err(CaseError::unhandled(function)),
                };
                Ok(json!(chat_id_discovery_failure_content(reason)))
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn chat_export_contract_cases_match() {
    use chat_export_contracts::*;
    run("chat-export-contracts", |function, args| {
        let input = unknown(function, args.first())?;
        match function {
            "parseTranscriptExportResponse" => parse_transcript_export_response(&input)
                .map(value)
                .map_err(|error| {
                    CaseError::new(TranscriptExportContractError::NAME, error.to_string())
                }),
            "new TranscriptExportContractError" => {
                let message =
                    text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
                let error = TranscriptExportContractError::new(message);
                Ok(
                    json!({"$": "error", "name": TranscriptExportContractError::NAME, "message": error.to_string(), "properties": {}}),
                )
            }
            "isTranscriptExportFormat" => Ok(json!(is_transcript_export_format(&input).is_some())),
            "isTranscriptExportCategory" => {
                Ok(json!(is_transcript_export_category(&input).is_some()))
            }
            "canonicalTranscriptExportCategories" => {
                let categories: Vec<TranscriptExportCategory> =
                    serde_json::from_value(input.into_owned())
                        .map_err(|_| CaseError::unhandled(function))?;
                Ok(value(canonical_transcript_export_categories(categories)))
            }
            _ => Err(CaseError::unhandled(function)),
        }
    });
}

#[test]
fn chat_handoff_artifact_cases_match() {
    use chat_handoff_artifact_contracts::*;
    run(
        "chat-handoff-artifact-contracts",
        |function, args| match function {
            "parseChatHandoffArtifactResponse" => {
                let input = unknown(function, args.first())?;
                parse_chat_handoff_artifact_response(&input)
                    .map(value)
                    .map_err(|error| {
                        CaseError::new(ChatHandoffArtifactContractError::NAME, error.to_string())
                    })
            }
            "new ChatHandoffArtifactContractError" => {
                let message =
                    text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
                let error = ChatHandoffArtifactContractError::new(message);
                Ok(
                    json!({"$": "error", "name": ChatHandoffArtifactContractError::NAME, "message": error.to_string(), "properties": {}}),
                )
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
}
