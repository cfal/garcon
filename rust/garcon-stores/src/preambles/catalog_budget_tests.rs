use garcon_cases::{CaseError, replay};
use garcon_contract::preambles::{
    PreambleDefinition, PreambleProjectPathRule, PreambleTagFilter, PreambleTagMatchMode,
};
use garcon_js::OptionalNullable;
use serde::Deserialize;

use super::*;

#[derive(Deserialize)]
struct Entry {
    path: Option<String>,
    #[serde(default)]
    nested: bool,
    executor: Option<String>,
    size: u32,
    #[serde(default)]
    disabled: bool,
}

#[test]
fn matches_bun_composition_cases() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/preamble-composition"
        ),
        |function, args| {
            if function != "compositionFor" {
                return Err(CaseError::unhandled(function));
            }
            let entries = args
                .first()
                .ok_or_else(|| CaseError::undeliverable("missing entries"))?;
            let entries: Vec<Entry> = serde_json::from_value(entries.clone())
                .map_err(|error| CaseError::undeliverable(error.to_string()))?;
            let preambles: Vec<_> = entries
                .into_iter()
                .enumerate()
                .map(|(index, entry)| Preamble {
                    id: format!("00000000-0000-4000-8000-{index:012}"),
                    definition: PreambleDefinition {
                        enabled: !entry.disabled,
                        title: "Synthetic".into(),
                        snippet_short_name: None,
                        content: "x".repeat(entry.size as usize),
                        scope: match entry.path {
                            Some(project_path) => PreambleScope::ProjectPaths {
                                rules: vec![PreambleProjectPathRule {
                                    project_path,
                                    include_nested: entry.nested,
                                    executor_id: OptionalNullable::from(entry.executor),
                                }],
                            },
                            None => PreambleScope::Global,
                        },
                        agent_ids: vec![],
                        tag_filter: PreambleTagFilter {
                            mode: PreambleTagMatchMode::Any,
                            tags: vec![],
                        },
                    },
                    created_at: "2026-11-28T00:00:00.000Z".into(),
                    updated_at: "2026-11-28T00:00:00.000Z".into(),
                })
                .collect();
            let violation = composition_violation(&preambles)
                .map_err(|error| CaseError::new("TemplateExpansionError", error.to_string()))?;
            serde_json::to_value(violation)
                .map_err(|error| CaseError::undeliverable(error.to_string()))
        },
    );
}
