//! Replaying a recording against a port through a dispatcher.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::compare::{self, Difference};
use crate::manifest::{self, RecordedCase};
use crate::markers;

/// How many failing cases are listed before the grouped differences.
const LISTED_FAILURES: usize = 50;

/// What the port did for a call where the original threw, or that it has no
/// port of the function.
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

    fn is_unhandled(&self) -> bool {
        matches!(self.outcome, Outcome::Unhandled)
    }

    // The outcome in the recording's form.
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
                "properties": properties,
            }),
            Outcome::Thrown(value) => markers::marker("throw", value.clone()),
            Outcome::Unhandled => json!({ "$": "unhandled" }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stats {
    pub total: usize,
    pub passed: usize,
    // Cases whose recorded result has a wildcard, which match less than exactly.
    pub with_wildcards: usize,
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

fn check<'a, F>(recording: &'a manifest::Recording, dispatch: &mut F) -> Report<'a>
where
    F: FnMut(&str, &[Value]) -> Result<Value, CaseError>,
{
    let mut failures: Vec<Failure<'a>> = Vec::new();
    let mut with_wildcards = 0;
    for case in &recording.cases {
        let difference = match dispatch(&case.function, &case.args) {
            Err(error) if error.is_unhandled() => Some(Difference {
                path: "$".to_owned(),
                kind: "unhandled",
                expected: "a ported function".to_owned(),
                actual: format!("no port of `{}`", case.function),
            }),
            Ok(value) => compare::first_difference(&case.result, &value).map(in_case),
            Err(error) => compare::first_difference(&case.result, &error.recorded()).map(in_case),
        };
        if !compare::wildcard_paths(&case.result, "$").is_empty() {
            with_wildcards += 1;
        }
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
        },
        failures,
    }
}

fn summary(report: &Report<'_>) -> String {
    format!(
        "{}: {}/{} unit cases match ({} with wildcards)",
        report.module, report.stats.passed, report.stats.total, report.stats.with_wildcards
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
/// case matches. A case file that differs from its recording, a function the
/// dispatcher does not handle, and a result that differs all fail.
pub fn replay<F>(cases_dir: impl AsRef<Path>, mut dispatch: F) -> Stats
where
    F: FnMut(&str, &[Value]) -> Result<Value, CaseError>,
{
    let directory: PathBuf = cases_dir.as_ref().to_path_buf();
    let recording = manifest::read(&directory).unwrap_or_else(|message| panic!("{message}"));
    let report = check(&recording, &mut dispatch);
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
                with_wildcards: 0
            }
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
                with_wildcards: 2
            }
        );
    }
}
