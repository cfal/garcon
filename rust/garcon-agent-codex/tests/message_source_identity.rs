use garcon_agent_codex::message_source_identity::{
    codex_message_source_identity, codex_turn_id_from_entry_id,
};
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::chat_types::parse_chat_message;
use garcon_js::{Number, json::as_number};
use serde_json::json;

#[test]
fn codex_message_source_identity_matches_recorded_cases() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/message-source-identity"
        ),
        |function, args| {
            let input = unknown(function, args.first())?;
            Ok(match function {
                "codexTurnIdFromEntryId" => json!(codex_turn_id_from_entry_id(&input)),
                "codexMessageSourceIdentity" => {
                    let message = parse_chat_message(&input["message"]).unwrap().unwrap();
                    json!(codex_message_source_identity(
                        input["turnId"].as_str(),
                        input["itemId"].as_str(),
                        &message,
                        Number(as_number(&input["fallbackOrdinal"]).unwrap()),
                    ))
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}
