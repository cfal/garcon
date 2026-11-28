//! Replays the unit cases recorded from `server-agents/common/src/shared/transcript-timestamp.ts`.

use garcon_agents_common::shared::transcript_timestamp::deterministic_transcript_timestamp;
use garcon_base::errors::error_metadata;
use garcon_cases::{CaseError, javascript_number, markers, replay};
use serde_json::{Value, json};

#[test]
fn recorded_transcript_timestamp_matches() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/transcript-timestamp"
        ),
        |function, args| {
            if function != "deterministicTranscriptTimestamp" {
                return Err(CaseError::unhandled(function));
            }
            // A position the original reads with `??`, where `null` and `undefined` read alike.
            let position = |argument: Option<&Value>| -> Result<Option<f64>, CaseError> {
                match argument {
                    None => Ok(None),
                    Some(value) if markers::is_undefined(value) || value.is_null() => Ok(None),
                    Some(value) => javascript_number(function, Some(value)).map(Some),
                }
            };
            match deterministic_transcript_timestamp(
                position(args.first())?,
                position(args.get(1))?,
            ) {
                Ok(timestamp) => Ok(json!(timestamp)),
                Err(error) => {
                    let metadata = error_metadata(&error);
                    Err(CaseError::new(metadata.name, error.to_string()))
                }
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
