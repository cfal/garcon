use garcon_agents_common::shared::transcript_order::compare_transcript_timestamps;
use garcon_cases::{CaseError, javascript_number, markers, replay};

#[test]
fn recorded_transcript_order_cases_match() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/transcript-order"),
        |function, args| {
            if function != "compareTranscriptTimestamps" {
                return Err(CaseError::unhandled(function));
            }
            let left = javascript_number(function, args.first())?;
            let right = javascript_number(function, args.get(1))?;
            Ok(markers::number(compare_transcript_timestamps(left, right)))
        },
    );
}
