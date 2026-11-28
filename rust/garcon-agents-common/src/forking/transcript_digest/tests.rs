use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::chat_types::parse_chat_messages;
use serde_json::Value;

use super::OrderedTranscriptDigest;

#[test]
fn ordered_digest_matches_the_original_bytes() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/transcript-digest"),
        |function, args| {
            if function != "orderedTranscriptDigest" {
                return Err(CaseError::unhandled(function));
            }
            let input = unknown(function, args.first())?;
            let mut digest = OrderedTranscriptDigest::default();
            for row in parse_chat_messages(&input).unwrap() {
                digest.add(&row).unwrap();
            }
            Ok(Value::String(digest.digest()))
        },
    );
}
