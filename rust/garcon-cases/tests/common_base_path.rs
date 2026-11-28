//! The demonstration of ADR-020's unit level: `common/base-path.ts` ported
//! here and replayed against its recording in `cases/common/base-path`, which
//! `bun rust/parity/cli.ts unit record common/base-path.ts --tests
//! common/__tests__/base-path.test.js --out rust/garcon-cases/tests/cases/common/base-path`
//! writes.

use std::fs;

use serde_json::{Value, json};

use garcon_cases::{CaseError, replay, text};

const CASES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/base-path");
const INVALID_BASE_PATH: &str = "Invalid base path: use an absolute path of unescaped letters, digits, dots, hyphens, underscores, or tildes, without empty or dot segments";

// Ports `parseBasePath`.
fn parse_base_path(value: &str) -> Result<String, CaseError> {
    if value.is_empty() || value == "/" {
        return Ok(String::new());
    }
    let normalized = value.strip_suffix('/').unwrap_or(value);
    // `.length` counts UTF-16 code units.
    if normalized.encode_utf16().count() > 1024
        || !normalized.starts_with('/')
        || !normalized
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._~/-".contains(character))
        || normalized[1..]
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return Err(CaseError::new("Error", INVALID_BASE_PATH));
    }
    Ok(normalized.to_owned())
}

// Ports `stripBasePath`.
fn strip_base_path(pathname: &str, base_path: &str) -> Option<String> {
    if base_path.is_empty() {
        return pathname.starts_with('/').then(|| pathname.to_owned());
    }
    if pathname == base_path {
        return Some("/".to_owned());
    }
    // The slice starts at the mount's length, so the separator stays.
    pathname
        .starts_with(&format!("{base_path}/"))
        .then(|| pathname[base_path.len()..].to_owned())
}

// Calls the port for a recorded case. Each argument is a string, which the
// reader `text` gives as it was recorded; one that is not a string, which the
// original has no recorded behavior for, is not handled.
fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let argument = |index: usize| {
        text(function, args.get(index))
            .and_then(|value| value.ok_or_else(|| CaseError::unhandled(function)))
    };
    match function {
        "parseBasePath" => parse_base_path(argument(0)?).map(Value::String),
        "stripBasePath" => {
            Ok(strip_base_path(argument(0)?, argument(1)?).map_or(Value::Null, Value::String))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn recorded_cases_match() {
    let stats = replay(CASES, dispatch);
    // A wildcard would let the port return anything for that case.
    assert_eq!(
        stats.with_wildcards, 0,
        "the recording has wildcards; review the recorder's output"
    );
    assert_eq!(stats.passed, stats.total);
}

#[test]
fn normalizes_mount() {
    for (input, expected) in [
        ("", ""),
        ("/", ""),
        ("/garcon", "/garcon"),
        ("/tools/garcon/", "/tools/garcon"),
        ("/a_B-1.2~", "/a_B-1.2~"),
    ] {
        assert_eq!(parse_base_path(input).ok().as_deref(), Some(expected));
    }
}

#[test]
fn rejects_ambiguous_or_unsafe_mount() {
    for input in [
        "relative",
        "//host",
        "/a//b",
        "/a//",
        "/.",
        "/a/../b",
        "/a/./b",
        "/a%2fb",
        "/a%20b",
        "/a?b",
        "/a#b",
        "/a\\b",
        "/a b",
        "/a\nb",
        "/a\n",
        "/a\r\n",
        "/a\t",
        "/<script>",
        "/:id",
        "/*",
    ] {
        assert_eq!(
            parse_base_path(input),
            Err(CaseError::new("Error", INVALID_BASE_PATH)),
            "{input:?}"
        );
    }
    let too_long = format!("/{}", "a".repeat(1024));
    assert_eq!(
        parse_base_path(&too_long),
        Err(CaseError::new("Error", INVALID_BASE_PATH))
    );
}

#[test]
fn checks_the_length_limit_after_normalizing_the_trailing_slash() {
    let longest = format!("/{}", "a".repeat(1023));
    assert_eq!(parse_base_path(&longest).ok(), Some(longest.clone()));
    assert_eq!(
        parse_base_path(&format!("{longest}/")).ok(),
        Some(longest.clone())
    );
    assert_eq!(
        parse_base_path(&format!("{longest}a/")),
        Err(CaseError::new("Error", INVALID_BASE_PATH))
    );
}

#[test]
fn strips_only_complete_mount_segments_preserving_query_independent_encoded_route_data() {
    assert_eq!(
        strip_base_path("/tools/garcon/api/v1/files", "/tools/garcon").as_deref(),
        Some("/api/v1/files")
    );
    assert_eq!(
        strip_base_path("/tools/garcon", "/tools/garcon").as_deref(),
        Some("/")
    );
    assert_eq!(
        strip_base_path("/tools/garcon/", "/tools/garcon").as_deref(),
        Some("/")
    );
    assert_eq!(
        strip_base_path("/tools/garcon-other/api", "/tools/garcon"),
        None
    );
    assert_eq!(strip_base_path("/api", "/tools/garcon"), None);
    assert_eq!(
        strip_base_path("/tools/garcon/a%20b", "/tools/garcon").as_deref(),
        Some("/a%20b")
    );
}

// A copy of the recording, for the failure paths of `replay` below.
fn recording_copy() -> (tempfile::TempDir, std::path::PathBuf) {
    let copy = tempfile::tempdir().expect("a temporary directory");
    let directory = copy.path().join("base-path");
    fs::create_dir(&directory).expect("the directory");
    for name in ["cases.jsonl", "manifest.json"] {
        fs::copy(format!("{CASES}/{name}"), directory.join(name)).expect("the recording");
    }
    (copy, directory)
}

#[test]
#[should_panic(expected = "is not the recorded file (sha256")]
fn an_edited_case_file_fails() {
    let (_copy, directory) = recording_copy();
    let cases = directory.join("cases.jsonl");
    let text = fs::read_to_string(&cases).expect("the case file");
    fs::write(
        &cases,
        text.replacen("\"args\":[\"/\"]", "\"args\":[\"/x\"]", 1),
    )
    .expect("the edit");
    replay(&directory, dispatch);
}

#[test]
#[should_panic(expected = "FAIL stripBasePath#1 at $.result (value): expected \"/\", got \"//\"")]
fn a_result_that_differs_fails_on_that_field() {
    let (_copy, directory) = recording_copy();
    // A planted bug: a path equal to its mount keeps one character too many.
    replay(&directory, |function, args| {
        let value = dispatch(function, args)?;
        Ok(if args.first() == args.get(1) {
            json!(format!("{}/", value.as_str().unwrap_or_default()))
        } else {
            value
        })
    });
}

#[test]
#[should_panic(expected = "not found; run `bun rust/parity/cli.ts unit record`")]
fn a_missing_recording_fails() {
    let empty = tempfile::tempdir().expect("a temporary directory");
    replay(empty.path(), dispatch);
}
