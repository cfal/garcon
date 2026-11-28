//! The readers of recorded arguments against a recording on disk: a case
//! whose argument a port cannot receive as JSON fails the replay and names the
//! two ways out.

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use garcon_cases::{javascript_number, markers, replay, text, unknown};

// NaN as a recording holds it.
fn nan() -> Value {
    json!({ "$": "number", "value": "NaN" })
}

// A recording of `fixture.ts` with one case, written as the recorder writes it.
fn recording(directory: &Path, origin: &str, argument: Value, result: Value) {
    let case =
        json!({ "id": "f#0", "fn": "f", "args": [argument], "result": result, "origin": origin });
    let text = format!("{case}\n");
    let digest: String = Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let manifest = json!({ "module": "fixture.ts", "cases": 1, "sha256": digest });
    fs::write(directory.join("cases.jsonl"), text).expect("the case file");
    fs::write(directory.join("manifest.json"), manifest.to_string()).expect("the manifest");
}

#[test]
#[should_panic(
    expected = "fixture.ts: 0/1 unit cases match (0 with wildcards, 0 known differences)\n  FAIL f#0 at $ (undeliverable): expected an argument the port can receive, got `f` received NaN, which JSON cannot carry. Read the argument with `javascript_number` if the port takes a number there, or record the module again with `--json f:<argument index>`, which keeps the recorder from making that trap."
)]
fn an_argument_a_port_cannot_receive_as_json_fails_the_case() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    recording(directory.path(), "trap:nan@$.args[0]", nan(), nan());
    replay(directory.path(), |function, args| {
        unknown(function, args.first()).map(|value| value.into_owned())
    });
}

#[test]
fn the_same_case_is_delivered_to_a_port_that_takes_the_number() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    recording(directory.path(), "test", nan(), nan());
    let stats = replay(directory.path(), |function, args| {
        Ok(markers::number(javascript_number(function, args.first())?))
    });
    assert_eq!((stats.passed, stats.total), (1, 1));
}

#[test]
fn lone_surrogates_load_from_disk_and_text_delivers_the_json_boundary() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let units = [0xd800, b'a' as u16, 0xd83d, 0xde00, 0xdc00];
    let marker = markers::utf16(&units);
    recording(directory.path(), "test", marker.clone(), marker);
    let stats = replay(directory.path(), |function, args| {
        assert_eq!(
            text(function, args.first())?,
            Some("\u{fffd}a\u{1f600}\u{fffd}")
        );
        Ok(markers::utf16(&units))
    });
    assert_eq!((stats.passed, stats.total), (1, 1));
}

#[test]
#[should_panic(expected = "FAIL f#0 at $.result (type)")]
fn a_lossy_port_result_does_not_match_the_recorded_surrogate_units() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let marker = markers::utf16(&[0xd800]);
    recording(directory.path(), "test", marker.clone(), marker);
    replay(directory.path(), |function, args| {
        Ok(json!(text(function, args.first())?))
    });
}

#[test]
fn surrogate_property_names_are_decoded_at_the_json_boundary() {
    let argument = markers::marker(
        "object-entries",
        json!([
            [markers::utf16(&[0xd800]), markers::utf16(&[0xdc00])],
            [markers::utf16(&[0xd801]), "replacement key wins"]
        ]),
    );
    assert_eq!(
        unknown("f", Some(&argument))
            .expect("a JSON object")
            .into_owned(),
        json!({"\u{fffd}": "replacement key wins"})
    );
}
