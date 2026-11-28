use garcon_agent_pi::pi_models::parse_pi_model_listing;
use garcon_cases::{CaseError, replay, text};

#[test]
fn recorded_pi_model_listing_matches() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/pi-models"),
        |function, args| {
            if function != "parsePiModelListing" {
                return Err(CaseError::unhandled(function));
            }
            let output = |index| {
                text(function, args.get(index))?
                    .ok_or_else(|| CaseError::undeliverable("expected model listing output"))
            };
            let models = parse_pi_model_listing(output(0)?, output(1)?)
                .map_err(|error| CaseError::new("Error", error.to_string()))?;
            serde_json::to_value(models)
                .map_err(|error| CaseError::undeliverable(error.to_string()))
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
