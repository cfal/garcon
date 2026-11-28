use std::process::Command;

use garcon_chats::token_fitting::budget::{
    COMPACTION_QUERY_ATTEMPTS, TokenDocumentBudget, estimate_handoff_tokens,
    estimate_handoff_tokens_utf16, fit_estimated_token_document, reduced_compaction_entry_budget,
};

#[test]
fn token_estimates_match_bun_on_utf16_and_rust_strings() {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/tokenx-oracle.ts"
        ))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cases: Vec<(Vec<u16>, usize)> = garcon_js::json::from_slice(&output.stdout).unwrap();
    let mut failures = 0;
    for (units, expected) in &cases {
        let exact = estimate_handoff_tokens_utf16(units);
        let projected = estimate_handoff_tokens(&String::from_utf16_lossy(units));
        if exact != *expected || projected != *expected {
            failures += 1;
            if failures <= 16 {
                eprintln!(
                    "{units:04x?}: Bun {expected}, Rust UTF-16 {exact}, Rust str {projected}"
                );
            }
        }
    }
    assert!(cases.len() > 10_000);
    println!("tokenx: {}/{} cases", cases.len() - failures, cases.len());
    assert_eq!(failures, 0);
}

fn budget(usable_tokens: f64, fixed_frame_tokens: f64) -> TokenDocumentBudget {
    TokenDocumentBudget {
        usable_tokens,
        fixed_frame_tokens,
        maximum_entry_budget_tokens: None,
        minimum_entry_budget_tokens: None,
    }
}

#[test]
fn reports_fixed_query_and_retry_policy() {
    assert_eq!(COMPACTION_QUERY_ATTEMPTS, 2);
    assert_eq!(reduced_compaction_entry_budget(10.0), 7.0);
    assert_eq!(reduced_compaction_entry_budget(11.0), 7.0);
    assert_eq!(reduced_compaction_entry_budget(101.0), 70.0);
}

#[test]
fn corrects_a_complete_document_that_exceeds_the_additive_entry_budget() {
    let mut seen = Vec::new();
    let result = fit_estimated_token_document(
        budget(30.0, 2.0),
        |entry_budget| {
            seen.push(entry_budget);
            Some(format!(
                "<frame>{}</frame>",
                "word ".repeat(entry_budget as usize + 10)
            ))
        },
        String::as_str,
        |_| None,
    )
    .unwrap();
    assert!(seen.len() > 1);
    assert_eq!(Some(&result.entry_budget_tokens), seen.last());
    assert!(result.estimated_tokens <= 30);
}

#[test]
fn honors_an_explicit_maximum_and_rejects_a_frame_with_no_entry_room() {
    let result = fit_estimated_token_document(
        TokenDocumentBudget {
            maximum_entry_budget_tokens: Some(20.0),
            ..budget(100.0, 10.0)
        },
        |entry_budget| Some(format!("entry-{entry_budget}")),
        String::as_str,
        |_| None,
    )
    .unwrap();
    assert_eq!(result.entry_budget_tokens, 20.0);
    let result = fit_estimated_token_document(
        budget(10.0, 10.0),
        |_| -> Option<String> { panic!("the frame leaves no room") },
        String::as_str,
        |_| None,
    );
    assert!(result.is_none());
}

#[test]
fn crosses_the_prior_admission_threshold_when_a_whole_entry_selection_stalls() {
    let oversized = "word ".repeat(200);
    let usable = estimate_handoff_tokens(&oversized) - 1;
    let mut seen = Vec::new();
    let result = fit_estimated_token_document(
        budget(usable as f64, usable as f64 - 100.0),
        |entry_budget| {
            seen.push(entry_budget);
            Some(if entry_budget >= 20.0 {
                (oversized.as_str(), 20.0)
            } else {
                ("fits", 1.0)
            })
        },
        |(document, _)| document,
        |(_, admission_cost)| Some(*admission_cost),
    )
    .unwrap();
    assert_eq!(seen, [100.0, 19.0]);
    assert_eq!(result.entry_budget_tokens, 19.0);
    assert!(result.estimated_tokens <= usable);
}

fn check_minimum_bridge(fits_at: f64, expected_attempts: &[f64]) {
    let oversized = "word ".repeat(200);
    let usable = estimate_handoff_tokens(&oversized) - 100;
    let mut seen = Vec::new();
    let result = fit_estimated_token_document(
        TokenDocumentBudget {
            minimum_entry_budget_tokens: Some(5.0),
            ..budget(usable as f64, usable as f64 - 20.0)
        },
        |entry_budget| {
            seen.push(entry_budget);
            Some(if entry_budget == fits_at {
                "fits"
            } else {
                &oversized
            })
        },
        |document| document,
        |_| None,
    )
    .unwrap();
    assert_eq!(seen, expected_attempts);
    assert_eq!(result.entry_budget_tokens, fits_at);
    assert!(result.estimated_tokens <= usable);
}

#[test]
fn tries_one_damped_budget_before_the_minimum_entry_budget() {
    check_minimum_bridge(12.0, &[20.0, 12.0]);
}

#[test]
fn tries_the_minimum_after_a_damped_budget_still_overflows() {
    check_minimum_bridge(5.0, &[20.0, 12.0, 5.0]);
}
