use std::process::Command;

use garcon_interface::native_message_source::*;
use garcon_js::json::{Opaque, from_str};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceInput {
    entry_id: Option<String>,
    line_number: Option<f64>,
    byte_offset: Option<f64>,
    within_source_ordinal: Option<f64>,
}

impl SourceInput {
    fn as_input(&self) -> NativeMessageSourceInput<'_> {
        NativeMessageSourceInput {
            entry_id: self.entry_id.as_deref(),
            line_number: self.line_number,
            byte_offset: self.byte_offset,
            within_source_ordinal: self.within_source_ordinal,
        }
    }
}

#[derive(Deserialize)]
struct Fixture {
    sources: Vec<Option<SourceInput>>,
    messages: Vec<NativeSourced<Opaque>>,
}

#[derive(Serialize, Deserialize)]
struct Outcome {
    messages: Opaque,
    public: Opaque,
    revision: Opaque,
}

#[test]
fn native_source_lifecycle_matches_bun() {
    let original = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/native-message-source-fixtures.ts"
        ))
        .output()
        .unwrap();
    assert!(
        original.status.success(),
        "{}",
        String::from_utf8_lossy(&original.stderr)
    );
    let stdout = String::from_utf8(original.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 7);
    for (index, line) in stdout.lines().enumerate() {
        let Fixture {
            sources,
            mut messages,
        } = from_str(line).unwrap();
        let expected: Outcome = from_str(line).unwrap();
        if let Some((first, rest)) = sources.split_first() {
            let source = first.as_ref().map(SourceInput::as_input);
            attach_native_message_source(&mut messages[0], source);
            attach_native_source_to_messages(&mut messages[1..], source);
            for source in rest {
                attach_native_source_to_messages(
                    &mut messages,
                    source.as_ref().map(SourceInput::as_input),
                );
            }
        }

        for (name, actual, expected) in [
            (
                "messages",
                serde_json::to_string(&messages).unwrap(),
                expected.messages,
            ),
            (
                "public",
                serde_json::to_string(
                    &messages
                        .iter()
                        .map(get_native_message_source)
                        .collect::<Vec<_>>(),
                )
                .unwrap(),
                expected.public,
            ),
            (
                "revision",
                serde_json::to_string(
                    &messages
                        .iter()
                        .map(get_native_message_revision_source)
                        .collect::<Vec<_>>(),
                )
                .unwrap(),
                expected.revision,
            ),
        ] {
            assert_eq!(
                actual,
                serde_json::to_string(&expected).unwrap(),
                "fixture {}: {name}",
                index + 1
            );
        }

        let wire = serde_json::to_string(&messages).unwrap();
        let decoded: Vec<NativeSourced<Opaque>> = from_str(&wire).unwrap();
        assert!(
            decoded
                .iter()
                .all(|message| get_native_message_revision_source(message).is_none())
        );
    }
}
