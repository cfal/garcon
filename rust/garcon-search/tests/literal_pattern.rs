use std::{collections::HashMap, process::Command};

use garcon_js::{json::from_str, utf16};
use garcon_search::query::LiteralPattern;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Probe {
    literal: String,
    body: String,
    span: Option<[usize; 2]>,
}

#[test]
fn compiled_literal_spans_match_the_bun_corpus() {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/literal-pattern.ts"
        ))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let fixtures = String::from_utf8(output.stdout).unwrap();
    let mut patterns = HashMap::new();
    let mut count = 0;
    let mut failures = 0;
    for line in fixtures.lines() {
        let probe: Probe = from_str(line).unwrap();
        let regex = patterns
            .entry(probe.literal.clone())
            .or_insert_with_key(|literal| LiteralPattern::compile(literal));
        let actual = regex.as_ref().map(|regex| {
            regex.first_span(&probe.body).map(|range| {
                [
                    utf16::len(&probe.body[..range.start]),
                    utf16::len(&probe.body[..range.end]),
                ]
            })
        });
        count += 1;
        if actual.as_ref().ok() != Some(&probe.span) {
            failures += 1;
            if failures <= 80 {
                eprintln!(
                    "literal {:?}, body {:?}: Bun {:?}, regress {:?}",
                    probe.literal.escape_unicode().to_string(),
                    probe.body.escape_unicode().to_string(),
                    probe.span,
                    actual,
                );
            }
        }
    }
    assert_eq!(count, 8_281);
    assert_eq!(
        failures,
        0,
        "{} of {count} literal spans match",
        count - failures
    );
}
