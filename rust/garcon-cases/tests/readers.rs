//! The readers of recorded arguments against a recording on disk: a case
//! whose argument a port cannot receive as JSON fails the replay and names the
//! two ways out.

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use garcon_cases::{javascript_number, markers, replay, unknown};

// NaN as a recording holds it.
fn nan() -> Value {
    json!({ "$": "number", "value": "NaN" })
}

// A recording of `fixture.ts` with one case, written as the recorder writes it.
fn recording(directory: &Path, origin: &str) {
    let case =
        json!({ "id": "f#0", "fn": "f", "args": [nan()], "result": nan(), "origin": origin });
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
    expected = "fixture.ts: 0/1 unit cases match (0 with wildcards)\n  FAIL f#0 at $ (undeliverable): expected an argument the port can receive, got `f` received NaN, which JSON cannot carry. Read the argument with `javascript_number` if the port takes a number there, or record the module again with `--json f:<argument index>`, which keeps the recorder from making that trap."
)]
fn an_argument_a_port_cannot_receive_as_json_fails_the_case() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    recording(directory.path(), "trap:nan@$.args[0]");
    replay(directory.path(), |function, args| {
        unknown(function, args.first()).map(|value| value.into_owned())
    });
}

#[test]
fn the_same_case_is_delivered_to_a_port_that_takes_the_number() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    recording(directory.path(), "test");
    let stats = replay(directory.path(), |function, args| {
        Ok(markers::number(javascript_number(function, args.first())?))
    });
    assert_eq!((stats.passed, stats.total), (1, 1));
}
