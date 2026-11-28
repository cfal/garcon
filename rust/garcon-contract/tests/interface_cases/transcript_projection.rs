use garcon_cases::{CaseError, text};
use garcon_contract::transcript_projection::{
    PrioritizedProjectionEntry, ProjectionCost, ProjectionInput, projection_priority_level,
    select_prioritized_projection,
};
use garcon_js::{Number, json::from_str, utf16};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{bun::bun_fixtures, helpers::recorded_cases};

#[test]
fn transcript_projection_cases_match() {
    recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/transcript-projection"
        ),
        "transcript-projection",
        |function, args| match function {
            "projectionPriorityLevel" => Ok(json!(projection_priority_level(
                text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?,
            ))),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

#[derive(Deserialize)]
struct Entry {
    level: usize,
    turn: f64,
    text: String,
}

impl PrioritizedProjectionEntry for Entry {
    fn level(&self) -> usize {
        self.level
    }
    fn turn(&self) -> f64 {
        self.turn
    }
    fn text(&self) -> &str {
        &self.text
    }
    fn refit(&self, maximum_cost: f64, cost: &ProjectionCost<'_>) -> String {
        let mut fitted = self.text.as_str();
        while !fitted.is_empty() && cost(fitted) > maximum_cost {
            fitted = utf16::slice(fitted, 0, Some(-1));
        }
        fitted.to_owned()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    entries: Vec<Entry>,
    order: Vec<usize>,
    turn_count: f64,
    maximum_cost: f64,
    truncation_marker_cost: f64,
    recent_turns_verbatim: Option<f64>,
    result: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Outcome<'a> {
    selected: Vec<&'a str>,
    truncated: bool,
    admission_cost: Number,
}

#[test]
fn selector_matches_bun_with_cost_and_refit_callbacks() {
    let fixtures: Vec<Fixture> =
        from_str(&bun_fixtures("transcript-projection-fixtures.ts")).unwrap();
    assert_eq!(fixtures.len(), 8);
    for (index, case) in fixtures.iter().enumerate() {
        let entries: Vec<_> = case
            .order
            .iter()
            .map(|&index| &case.entries[index])
            .collect();
        let projection = select_prioritized_projection(ProjectionInput {
            entries: &entries,
            turn_count: case.turn_count,
            maximum_cost: case.maximum_cost,
            truncation_marker_cost: case.truncation_marker_cost,
            recent_turns_verbatim: case.recent_turns_verbatim,
            cost: &|text| utf16::len(text) as f64,
        });
        let outcome = Outcome {
            selected: projection
                .selected
                .iter()
                .map(|entry| entry.text.as_ref())
                .collect(),
            truncated: projection.truncated,
            admission_cost: projection.admission_cost,
        };
        assert_eq!(
            serde_json::to_string(&outcome).unwrap(),
            case.result,
            "case {index}"
        );
    }
}
