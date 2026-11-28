//! Replaying a recording against a port through a dispatcher.

use std::path::Path;

use serde_json::{Map, Value, json};

use crate::compare::{self, Difference};
use crate::manifest::{self, RecordedCase};
use crate::markers;

/// How many failing cases are listed before the grouped differences.
const LISTED_FAILURES: usize = 50;

/// What the port did for a call where the original threw, that it has no port
/// of the function, or that it cannot receive an argument of the case.
#[derive(Debug, Clone, PartialEq)]
pub struct CaseError {
    outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq)]
enum Outcome {
    Error {
        name: String,
        message: String,
        properties: Map<String, Value>,
    },
    Thrown(Value),
    Unhandled,
    /// A recorded argument that cannot be given to the port, with the reason.
    Undeliverable(String),
}

impl CaseError {
    /// An `Error` the original threw, with its `name`, its `message`, and its
    /// own enumerable properties such as `code` and `status`.
    pub fn new(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            outcome: Outcome::Error {
                name: name.into(),
                message: message.into(),
                properties: Map::new(),
            },
        }
    }

    pub fn with_property(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        if let Outcome::Error { properties, .. } = &mut self.outcome {
            properties.insert(key.into(), value.into());
        }
        self
    }

    /// A value the original threw that was not an Error.
    pub fn thrown(value: impl Into<Value>) -> Self {
        Self {
            outcome: Outcome::Thrown(value.into()),
        }
    }

    /// The port has no function of that name. The case fails whatever the
    /// recording holds.
    pub fn unhandled(_function: &str) -> Self {
        Self {
            outcome: Outcome::Unhandled,
        }
    }

    /// An argument of the case cannot be given to the port as it was
    /// recorded. The case fails whatever the recording holds: the recording
    /// holds a call the port cannot receive, and `--guard` and `--json` of the
    /// recorder keep those out of it.
    pub fn undeliverable(reason: impl Into<String>) -> Self {
        Self {
            outcome: Outcome::Undeliverable(reason.into()),
        }
    }

    // The outcome in the recording's form, for a throw. The other outcomes
    // fail the case by themselves and are never compared.
    fn recorded(&self) -> Value {
        match &self.outcome {
            Outcome::Error {
                name,
                message,
                properties,
            } => json!({
                "$": "error",
                "name": name,
                "message": message,
                "properties": markers::object_fields(properties.clone()),
            }),
            Outcome::Thrown(value) => markers::marker("throw", value.clone()),
            Outcome::Unhandled | Outcome::Undeliverable(_) => Value::Null,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub total: usize,
    pub passed: usize,
    // Cases whose recorded result has a wildcard, which match less than exactly.
    pub with_wildcards: usize,
    pub known_differences: usize,
}

struct Failure<'a> {
    case: &'a RecordedCase,
    difference: Difference,
}

struct Report<'a> {
    module: String,
    failures: Vec<Failure<'a>>,
    stats: Stats,
}

// The comparison walks the result from its root; in the case file the result
// is the `result` property, so the path is named from there.
fn in_case(difference: Difference) -> Difference {
    Difference {
        path: format!("$.result{}", &difference.path[1..]),
        ..difference
    }
}

fn check_result(
    case: &RecordedCase,
    actual: &Value,
    known_differences: &mut usize,
) -> Option<Difference> {
    let original = compare::first_difference(&case.result, actual).map(in_case);
    let Some(known) = &case.known else {
        return original;
    };
    if original.is_none() {
        return Some(Difference {
            path: "$.result".to_owned(),
            kind: "stale-known-difference",
            expected: format!("a difference still present ({})", known.reason),
            actual: "matches the original recording".to_owned(),
        });
    }
    if let Some(difference) = compare::first_difference_exact(&known.result, actual) {
        return Some(in_case(difference));
    }
    *known_differences += 1;
    None
}

fn wildcard_cases(recording: &manifest::Recording) -> impl Iterator<Item = (&str, Vec<String>)> {
    recording.cases.iter().filter_map(|case| {
        let paths = compare::wildcard_paths(&case.result, "$.result");
        (!paths.is_empty()).then_some((case.id.as_str(), paths))
    })
}

fn check<'a, F>(
    recording: &'a manifest::Recording,
    dispatch: &mut F,
    with_wildcards: usize,
) -> Report<'a>
where
    F: FnMut(&str, &[Value]) -> Result<Value, CaseError>,
{
    let mut failures: Vec<Failure<'a>> = Vec::new();
    let mut known_differences = 0;
    for case in &recording.cases {
        let difference = match dispatch(&case.function, &case.args) {
            Ok(value) => check_result(case, &value, &mut known_differences),
            Err(error) => match &error.outcome {
                Outcome::Error { .. } | Outcome::Thrown(_) => {
                    check_result(case, &error.recorded(), &mut known_differences)
                }
                Outcome::Unhandled => Some(Difference {
                    path: "$".to_owned(),
                    kind: "unhandled",
                    expected: "a ported function".to_owned(),
                    actual: format!("no port of `{}`", case.function),
                }),
                Outcome::Undeliverable(reason) => Some(Difference {
                    path: "$".to_owned(),
                    kind: "undeliverable",
                    expected: "an argument the port can receive".to_owned(),
                    actual: reason.clone(),
                }),
            },
        };
        if let Some(difference) = difference {
            failures.push(Failure { case, difference });
        }
    }
    let total = recording.cases.len();
    Report {
        module: recording.module.clone(),
        stats: Stats {
            total,
            passed: total - failures.len(),
            with_wildcards,
            known_differences,
        },
        failures,
    }
}

fn summary(report: &Report<'_>) -> String {
    format!(
        "{}: {}/{} unit cases match ({} with wildcards, {} known differences)",
        report.module,
        report.stats.passed - report.stats.known_differences,
        report.stats.total,
        report.stats.with_wildcards,
        report.stats.known_differences,
    )
}

/// Failures that differ the same way share one field and kind, so one port
/// bug that breaks forty cases is one line.
fn grouped(failures: &[Failure<'_>]) -> Vec<(usize, String, &'static str, String)> {
    let mut groups: Vec<(String, &'static str, usize, String)> = Vec::new();
    for Failure { case, difference } in failures {
        let field = group_field(&difference.path);
        match groups
            .iter_mut()
            .find(|(known, kind, _, _)| *known == field && *kind == difference.kind)
        {
            Some((_, _, count, _)) => *count += 1,
            None => groups.push((field, difference.kind, 1, case.id.clone())),
        }
    }
    groups.sort_by(|left, right| right.2.cmp(&left.2).then_with(|| left.0.cmp(&right.0)));
    groups
        .into_iter()
        .map(|(field, kind, count, first)| (count, field, kind, first))
        .collect()
}

// Array indexes are dropped, so the same field of different array items
// groups together.
fn group_field(path: &str) -> String {
    let mut grouped = String::with_capacity(path.len());
    let mut chars = path.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '[' && chars.peek().is_some_and(|next| next.is_ascii_digit()) {
            for next in chars.by_ref() {
                if next == ']' {
                    break;
                }
            }
            grouped.push_str("[]");
        } else {
            grouped.push(character);
        }
    }
    grouped
}

fn render(report: &Report<'_>) -> String {
    let mut lines = vec![summary(report)];
    for failure in report.failures.iter().take(LISTED_FAILURES) {
        lines.push(format!(
            "  FAIL {} at {} ({}): expected {}, got {}",
            failure.case.id,
            failure.difference.path,
            failure.difference.kind,
            failure.difference.expected,
            failure.difference.actual,
        ));
    }
    if report.failures.len() > LISTED_FAILURES {
        lines.push(format!(
            "  ... and {} more",
            report.failures.len() - LISTED_FAILURES
        ));
    }
    lines.push("  distinct differences (count, field, kind, first case):".to_owned());
    for (count, field, kind, first) in grouped(&report.failures) {
        lines.push(format!("  {count:>6}  {field}  {kind}  {first}"));
    }
    lines.join("\n")
}

/// Calls `dispatch` for every recorded case of `cases_dir` with the case's
/// function name and arguments, and compares what it returns with the
/// recorded result. Prints the first difference of each failing case and the
/// distinct differences grouped by path and kind, then panics unless every
/// case matches. An approved `known-differences.jsonl` entry must match the
/// port's result exactly and fails if the result matches the original again.
/// An edited case file, an unhandled function, or a wildcard result fails.
pub fn replay<F>(cases_dir: impl AsRef<Path>, dispatch: F) -> Stats
where
    F: FnMut(&str, &[Value]) -> Result<Value, CaseError>,
{
    replay_with_expected_wildcards(cases_dir, 0, dispatch)
}

/// Replays cases only if exactly `expected_wildcards` results contain a
/// wildcard. Prints every case with a wildcard and its paths before dispatch.
pub fn replay_with_expected_wildcards<F>(
    cases_dir: impl AsRef<Path>,
    expected_wildcards: usize,
    mut dispatch: F,
) -> Stats
where
    F: FnMut(&str, &[Value]) -> Result<Value, CaseError>,
{
    let recording =
        manifest::read(cases_dir.as_ref()).unwrap_or_else(|message| panic!("{message}"));
    let mut count = 0;
    for (case, paths) in wildcard_cases(&recording) {
        println!("  WILDCARD {case} at {}", paths.join(", "));
        count += 1;
    }
    assert!(
        count == expected_wildcards,
        "{}: expected {expected_wildcards} wildcard cases, found {count}",
        recording.module,
    );
    let report = check(&recording, &mut dispatch, count);
    if report.failures.is_empty() {
        println!("{}", summary(&report));
        return report.stats;
    }
    panic!("{}", render(&report));
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    use super::*;

    fn check<'a, F>(recording: &'a manifest::Recording, dispatch: &mut F) -> Report<'a>
    where
        F: FnMut(&str, &[Value]) -> Result<Value, CaseError>,
    {
        super::check(recording, dispatch, wildcard_cases(recording).count())
    }

    // A recording on disk with the given cases of one function.
    fn recording(cases: &[(&str, Value, Value)]) -> (tempfile::TempDir, manifest::Recording) {
        let directory = tempfile::tempdir().expect("a temporary directory");
        let lines: Vec<String> = cases
            .iter()
            .enumerate()
            .map(|(index, (function, args, result))| {
                json!({ "id": format!("{function}#{index}"), "fn": function, "args": args, "result": result })
                    .to_string()
            })
            .collect();
        let text = format!("{}\n", lines.join("\n"));
        std::fs::write(directory.path().join("cases.jsonl"), &text).expect("the case file");
        let digest: String = Sha256::digest(text.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        std::fs::write(
            directory.path().join("manifest.json"),
            json!({ "module": "fixture.ts", "cases": cases.len(), "sha256": digest }).to_string(),
        )
        .expect("the manifest");
        let read = manifest::read(directory.path()).expect("the recording reads back");
        (directory, read)
    }

    fn echo(_function: &str, args: &[Value]) -> Result<Value, CaseError> {
        Ok(args.to_vec().into())
    }

    #[test]
    #[should_panic(expected = "expected 0 wildcard cases, found 2")]
    fn replay_rejects_unacknowledged_wildcard_cases() {
        let (directory, _) = recording(&[
            ("random", json!([]), json!("[..]")),
            ("shaped", json!([]), json!({"token": "[..hex:2]"})),
        ]);
        replay(directory.path(), |_, _| {
            panic!("must reject before dispatch")
        });
    }

    #[test]
    fn replay_checks_the_exact_wildcard_case_count() {
        let (directory, _) = recording(&[
            (
                "shaped",
                json!([]),
                json!({"token": "[..hex:2]", "nested": ["[..]"]}),
            ),
            ("plain", json!(["[..]"]), json!(42)),
        ]);
        let replay_with_budget = |budget| {
            replay_with_expected_wildcards(directory.path(), budget, |function, _| {
                Ok(if function == "shaped" {
                    json!({"token": "ab", "nested": [null]})
                } else {
                    json!(42)
                })
            })
        };
        assert_eq!(replay_with_budget(1).with_wildcards, 1);
        let error = std::panic::catch_unwind(|| replay_with_budget(2)).unwrap_err();
        assert!(
            error
                .downcast_ref::<String>()
                .unwrap()
                .contains("expected 2 wildcard cases, found 1")
        );
    }

    #[test]
    fn every_case_must_match() {
        let (_directory, recording) = recording(&[
            ("f", json!([1]), json!([1])),
            ("f", json!([2]), json!([2])),
            ("g", json!([]), json!([])),
        ]);
        let report = check(&recording, &mut echo);
        assert_eq!(report.failures.len(), 0);
        assert_eq!(
            report.stats,
            Stats {
                total: 3,
                passed: 3,
                with_wildcards: 0,
                known_differences: 0,
            }
        );
    }

    fn approval(directory: &Path, line: &Value) -> manifest::Recording {
        std::fs::write(
            directory.join("known-differences.jsonl"),
            format!("{line}\n"),
        )
        .expect("the known difference file");
        manifest::read(directory).expect("the known difference applies to a recorded case")
    }

    #[test]
    fn an_approved_result_must_match_exactly_and_is_counted_apart() {
        let (directory, _) = recording(&[
            ("f", json!([1]), json!({"source": "original"})),
            ("f", json!([2]), json!([2])),
        ]);
        let recording = approval(
            directory.path(),
            &json!({
                "fn": "f", "args": [1], "result": {"source": "[..]"}, "reason": "synthetic fixture"
            }),
        );
        let report = check(&recording, &mut |_, args| {
            if args == [json!(1)] {
                Ok(json!({"source": "[..]"}))
            } else {
                echo("f", args)
            }
        });
        assert_eq!(
            (report.stats.passed, report.stats.known_differences),
            (2, 1)
        );
        assert_eq!(
            summary(&report),
            "fixture.ts: 1/2 unit cases match (0 with wildcards, 1 known differences)"
        );
        let changed = check(&recording, &mut |_, args| {
            if args == [json!(1)] {
                Ok(json!({"source": "different"}))
            } else {
                echo("f", args)
            }
        });
        assert_eq!(changed.failures[0].difference.path, "$.result.source");
        assert_eq!(changed.stats.known_differences, 0);
        let stale = check(&recording, &mut |_, args| {
            if args == [json!(1)] {
                Ok(json!({"source": "original"}))
            } else {
                echo("f", args)
            }
        });
        assert_eq!(stale.failures[0].difference.kind, "stale-known-difference");
    }

    #[test]
    fn an_approval_of_an_error_never_accepts_an_unhandled_call() {
        let (directory, _) = recording(&[("f", json!([]), json!("original"))]);
        let recording = approval(
            directory.path(),
            &json!({
                "fn": "f", "args": [], "result": {"$": "error", "name": "Error", "message": "approved", "properties": {"status": 409}},
                "reason": "synthetic fixture"
            }),
        );
        let approved = check(&recording, &mut |_, _| {
            Err(CaseError::new("Error", "approved").with_property("status", 409))
        });
        assert_eq!(
            (approved.stats.passed, approved.stats.known_differences),
            (1, 1)
        );
        let absent = check(&recording, &mut |fn_name, _| {
            Err(CaseError::unhandled(fn_name))
        });
        assert_eq!(absent.failures[0].difference.kind, "unhandled");
    }

    #[test]
    fn an_approval_without_a_recorded_case_fails_to_load() {
        let (directory, _) = recording(&[("f", json!([1]), json!("original"))]);
        std::fs::write(
            directory.path().join("known-differences.jsonl"),
            r#"{"fn":"f","args":[2],"result":null,"reason":"synthetic fixture"}"#,
        )
        .expect("the known difference file");
        assert!(
            matches!(manifest::read(directory.path()), Err(error) if error.contains("stale known difference"))
        );
    }

    #[test]
    fn a_function_without_a_port_fails_even_against_a_wildcard() {
        let (_directory, recording) = recording(&[
            ("ported", json!([]), json!("[..]")),
            ("absent", json!([]), json!("[..]")),
        ]);
        let report = check(&recording, &mut |function, args| {
            if function == "ported" {
                echo(function, args)
            } else {
                Err(CaseError::unhandled(function))
            }
        });
        assert_eq!(report.stats.passed, 1);
        assert_eq!(report.failures[0].difference.kind, "unhandled");
        assert!(render(&report).contains(
            "FAIL absent#1 at $ (unhandled): expected a ported function, got no port of `absent`"
        ));
    }

    #[test]
    fn an_undeliverable_argument_fails_the_case_with_its_reason() {
        // Even against a wildcard: a port that cannot receive the argument has shown nothing.
        let (_directory, recording) = recording(&[
            (
                "f",
                json!([{ "$": "number", "value": "NaN" }]),
                json!("[..]"),
            ),
            ("g", json!([1]), json!([1])),
        ]);
        let report = check(&recording, &mut |function, args| {
            if function == "f" {
                Err(CaseError::undeliverable(
                    "`f` received NaN, which JSON cannot carry. Read the argument with `javascript_number`.",
                ))
            } else {
                echo(function, args)
            }
        });
        assert_eq!(report.stats.passed, 1);
        assert_eq!(report.failures[0].difference.kind, "undeliverable");
        assert!(render(&report).contains(
            "FAIL f#0 at $ (undeliverable): expected an argument the port can receive, got `f` received NaN, which JSON cannot carry. Read the argument with `javascript_number`."
        ));
    }

    #[test]
    fn an_error_matches_only_the_same_error() {
        let thrown = json!({
            "$": "error",
            "name": "DomainError",
            "message": "nope",
            "properties": { "code": "E_X", "status": 404 },
        });
        let (_directory, recording) = recording(&[("f", json!([1]), thrown.clone())]);
        let same = || {
            CaseError::new("DomainError", "nope")
                .with_property("code", "E_X")
                .with_property("status", 404)
        };
        assert_eq!(check(&recording, &mut |_, _| Err(same())).failures.len(), 0);

        let other_message = || {
            CaseError::new("DomainError", "other")
                .with_property("code", "E_X")
                .with_property("status", 404)
        };
        assert_eq!(
            check(&recording, &mut |_, _| Err(other_message())).failures[0]
                .difference
                .path,
            "$.result.message"
        );

        let other_name = || {
            CaseError::new("Error", "nope")
                .with_property("code", "E_X")
                .with_property("status", 404)
        };
        assert_eq!(
            check(&recording, &mut |_, _| Err(other_name())).failures[0]
                .difference
                .path,
            "$.result.name"
        );

        let no_status = || CaseError::new("DomainError", "nope").with_property("code", "E_X");
        assert_eq!(
            check(&recording, &mut |_, _| Err(no_status())).failures[0]
                .difference
                .kind,
            "missing"
        );

        let extra = || {
            CaseError::new("DomainError", "nope")
                .with_property("code", "E_X")
                .with_property("status", 404)
                .with_property("retryable", true)
        };
        assert_eq!(
            check(&recording, &mut |_, _| Err(extra())).failures[0]
                .difference
                .kind,
            "extra"
        );

        // A value is not an error.
        assert_eq!(
            check(&recording, &mut |_, _| Ok(json!("nope"))).failures[0]
                .difference
                .kind,
            "type"
        );
    }

    #[test]
    fn a_thrown_value_and_a_returned_error_are_apart() {
        let (_directory, recording) = recording(&[
            ("f", json!([]), json!({ "$": "throw", "value": "boom" })),
            (
                "g",
                json!([]),
                json!({ "$": "error", "name": "Error", "message": "returned", "properties": {} }),
            ),
        ]);
        let report = check(&recording, &mut |function, _| match function {
            "f" => Err(CaseError::thrown("boom")),
            _ => Ok(
                json!({ "$": "error", "name": "Error", "message": "returned", "properties": {} }),
            ),
        });
        assert_eq!(report.failures.len(), 0);
        let report = check(&recording, &mut echo);
        assert_eq!(report.failures.len(), 2);
    }

    #[test]
    fn differences_are_grouped_by_field_and_kind() {
        let (_directory, recording) = recording(&[
            ("f", json!([]), json!({ "rows": [1, 2] })),
            ("f", json!([]), json!({ "rows": [1, 2] })),
            ("f", json!([]), json!({ "rows": [1, 2] })),
            ("g", json!([]), json!("text")),
        ]);
        let report = check(&recording, &mut |_, args| {
            Ok(if args.is_empty() {
                json!({ "rows": [1, 3] })
            } else {
                Value::Null
            })
        });
        let groups = grouped(&report.failures);
        assert_eq!(
            groups[0],
            (3, "$.result.rows[]".to_owned(), "value", "f#0".to_owned())
        );
        assert_eq!(
            groups[1],
            (1, "$.result".to_owned(), "type", "g#3".to_owned())
        );
        assert_eq!(group_field("$.a[12].b[3]"), "$.a[].b[]");
    }

    #[test]
    fn wildcards_are_counted() {
        let (_directory, recording) = recording(&[
            ("f", json!([]), json!("[..]")),
            ("f", json!([]), json!("id-[..]")),
            ("f", json!([]), json!(1)),
        ]);
        let report = check(&recording, &mut |_, _| Ok(json!("id-7")));
        assert_eq!(
            report.stats,
            Stats {
                total: 3,
                passed: 2,
                with_wildcards: 2,
                known_differences: 0,
            }
        );
    }
}
