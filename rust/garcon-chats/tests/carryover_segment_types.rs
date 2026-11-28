use garcon_cases::{CaseError, replay, text, unknown};
use garcon_chats::carryover::segment_types::{
    is_carry_over_segment_id, parse_carry_over_segment_index,
};
use serde_json::json;

#[test]
fn carryover_segment_manifests_match_bun() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/carryover-segment-types"
        ),
        |function, args| {
            let input = unknown(function, args.first())?;
            match function {
                "isCarryOverSegmentId" => Ok(json!(is_carry_over_segment_id(&input))),
                "parseCarryOverSegmentIndex" => {
                    let expected_id = text(function, args.get(1))?;
                    let manifest = parse_carry_over_segment_index(&input, expected_id)
                        .map_err(|error| CaseError::new("Error", error.to_string()))?;
                    Ok(serde_json::to_value(manifest).unwrap())
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.passed, stats.total);
    assert_eq!(stats.with_wildcards, 0);
}
