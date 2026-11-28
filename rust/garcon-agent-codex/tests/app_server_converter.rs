use garcon_agent_codex::app_server::converter::{
    convert_codex_app_server_live_item, convert_codex_raw_code_mode_item,
};
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::chat_types::CompactionTrigger;
use indexmap::IndexMap;
use serde_json::json;

#[test]
fn live_items_and_raw_call_associations_match_the_original() {
    const TIMESTAMP: &str = "2026-02-21T10:00:00.000Z";
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/app-server-converter"
        ),
        |function, args| {
            let input = unknown(function, args.first())?;
            let items = input.as_array().unwrap();
            let second = unknown(function, args.get(1))?;
            Ok(match function {
                "liveItems" => {
                    let trigger = match second.as_str() {
                        Some("auto") => Some(CompactionTrigger::Auto),
                        Some("manual") => Some(CompactionTrigger::Manual),
                        None if second.is_null() => None,
                        _ => return Err(CaseError::unhandled(function)),
                    };
                    json!(
                        items
                            .iter()
                            .map(|item| {
                                convert_codex_app_server_live_item(item, TIMESTAMP, trigger)
                            })
                            .collect::<Vec<_>>()
                    )
                }
                "rawItems" => {
                    let entries: Option<Vec<(String, String)>> =
                        serde_json::from_value(second.into_owned()).unwrap();
                    let mut pending: IndexMap<_, _> =
                        entries.unwrap_or_default().into_iter().collect();
                    let messages = items
                        .iter()
                        .map(|item| convert_codex_raw_code_mode_item(item, TIMESTAMP, &mut pending))
                        .collect::<Vec<_>>();
                    json!({"messages":messages,"pending":pending.into_iter().collect::<Vec<_>>()})
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}
