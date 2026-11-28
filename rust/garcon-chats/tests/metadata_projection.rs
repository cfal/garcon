use std::collections::HashSet;

use garcon_cases::{CaseError, replay, round_tripped, unknown};
use garcon_chats::{
    carryover::segments::carry_over_revision,
    chat_activity_status::project_chat_activity_status,
    chat_list_projector::{ChatListMembershipSnapshot, classify_order_group},
    chat_title::resolve_chat_title,
    registry_contracts::CarryOverMigrationQuarantine,
    registry_entry_codec::parse_carry_over_segment_refs,
};
use garcon_contract::{chat_activity::ChatRunOutcome, chat_types::ChatProcessingPhase};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatusInput {
    processing_phase: Option<ChatProcessingPhase>,
    pending_user_action: bool,
    last_run_outcome: Option<ChatRunOutcome>,
}

#[derive(Deserialize)]
struct Groups {
    pinned: HashSet<String>,
    normal: HashSet<String>,
    archived: HashSet<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Quarantine {
    artifact_id: String,
    error_code: String,
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, CaseError> {
    serde_json::from_value(value).map_err(|error| CaseError::new("InputError", error.to_string()))
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let arg = |index| unknown(function, args.get(index));
    let nullable = |index| {
        round_tripped(function, args.get(index))
            .map(|value| value.map_or(Value::Null, |value| value.into_owned()))
    };
    Ok(match function {
        "carryOverRevision" => {
            let refs = parse_carry_over_segment_refs(arg(0)?.as_ref())
                .map_err(|error| CaseError::new("InputError", error.to_string()))?;
            let quarantine: Option<Quarantine> = decode(nullable(1)?)?;
            let quarantine = quarantine.map(|value| CarryOverMigrationQuarantine {
                artifact_id: value.artifact_id,
                error_code: value.error_code,
            });
            json!(carry_over_revision(&refs, quarantine.as_ref()))
        }
        "projectChatActivityStatus" => {
            let input: StatusInput = decode(arg(0)?.into_owned())?;
            json!(project_chat_activity_status(
                input.processing_phase,
                input.pending_user_action,
                input.last_run_outcome
            ))
        }
        "resolveChatTitle" => {
            let name: Option<String> = decode(nullable(0)?)?;
            let first: Option<String> = decode(nullable(1)?)?;
            json!(resolve_chat_title(name.as_deref(), first.as_deref()))
        }
        "classify" => {
            let chat_id: String = decode(arg(0)?.into_owned())?;
            let Groups {
                pinned,
                normal,
                archived,
            } = decode(arg(1)?.into_owned())?;
            json!(classify_order_group(
                &chat_id,
                &ChatListMembershipSnapshot {
                    pinned,
                    normal,
                    archived
                }
            ))
        }
        _ => return Err(CaseError::unhandled(function)),
    })
}

#[test]
fn metadata_projection_leaves_match_bun() {
    let statistics = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/metadata-projection"
        ),
        dispatch,
    );
    assert_eq!(statistics.total, statistics.passed);
    assert_eq!(statistics.with_wildcards, 0);
}
