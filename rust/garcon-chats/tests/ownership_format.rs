use garcon_cases::{CaseError, replay, unknown};
use garcon_chats::{
    agent_ownership_journal_format::{
        empty_ownership_journal_v5, is_empty_earlier_journal, is_journal_v5,
    },
    preambles::boundary::{LifecyclePreambleBoundaryKind, create_preamble_boundary_binding},
};
use serde_json::{Value, json};

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    Ok(match function {
        "emptyOwnershipJournalV5" => json!(empty_ownership_journal_v5()),
        "isEmptyEarlierJournal" => json!(is_empty_earlier_journal(
            unknown(function, args.first())?.as_ref()
        )),
        "isJournalV5" => json!(is_journal_v5(unknown(function, args.first())?.as_ref())),
        "createPreambleBoundaryBinding" => {
            let kind: LifecyclePreambleBoundaryKind =
                serde_json::from_value(unknown(function, args.first())?.into_owned())
                    .map_err(|error| CaseError::new("InputError", error.to_string()))?;
            let epoch: String =
                serde_json::from_value(unknown(function, args.get(1))?.into_owned())
                    .map_err(|error| CaseError::new("InputError", error.to_string()))?;
            json!(create_preamble_boundary_binding(kind, epoch))
        }
        _ => return Err(CaseError::unhandled(function)),
    })
}

#[test]
fn journal_format_and_lifecycle_binding_match_bun() {
    let statistics = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/ownership-journal-format"
        ),
        dispatch,
    );
    assert_eq!(statistics.total, statistics.passed);
    assert_eq!(statistics.with_wildcards, 0);
}
