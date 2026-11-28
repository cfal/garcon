//! Ports `server/controller/preambles/catalog-budget.ts`.

use std::collections::{HashMap, HashSet};

use garcon_base::portable_path::parent_executor_path;
use garcon_contract::{
    executors::effective_executor_id,
    preamble_prefix::render_preamble_prefix,
    preambles::{
        PREAMBLE_COMBINED_MAX_LENGTH, PREAMBLE_FILE_CONTEXT_SEPARATOR, PREAMBLE_MAX_COUNT,
        Preamble, PreambleScope, render_preamble_content,
    },
    template_tokens::{TEMPLATE_VALIDATION_VALUES, TemplateExpansionError},
};
use garcon_js::utf16;
use indexmap::IndexMap;

type Mask = u128;
const _: () = assert!(PREAMBLE_MAX_COUNT <= Mask::BITS as usize);

#[derive(Default)]
struct Candidate {
    exact: Mask,
    nested: Mask,
}

type Candidates = IndexMap<(String, String), Candidate>;

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(super) enum Violation {
    CombinedLimit {
        project_path: Option<String>,
        code_unit_length: usize,
    },
    FileContextSeparator {
        project_path: Option<String>,
    },
}

pub(super) fn composition_violation(
    preambles: &[Preamble],
) -> Result<Option<Violation>, TemplateExpansionError> {
    let mut rendered = Vec::new();
    let mut candidates = Candidates::new();
    let mut global = 0;
    for (index, preamble) in preambles.iter().enumerate() {
        let definition = &preamble.definition;
        if !definition.enabled {
            continue;
        }
        let bit: Mask = 1 << index;
        rendered.push((
            bit,
            render_preamble_content(&definition.content, &TEMPLATE_VALIDATION_VALUES)?,
        ));
        match &definition.scope {
            PreambleScope::Global => global |= bit,
            PreambleScope::ProjectPaths { rules } => {
                for rule in rules {
                    let candidate = candidates
                        .entry((
                            effective_executor_id(rule.executor_id.as_deref()),
                            rule.project_path.clone(),
                        ))
                        .or_default();
                    candidate.exact |= bit;
                    if rule.include_nested {
                        candidate.nested |= bit;
                    }
                }
            }
        }
    }

    let mut inherited = HashMap::new();
    let mut checked = HashSet::new();
    let scopes =
        std::iter::once((None, global)).chain(candidates.iter().map(|(key, candidate)| {
            (
                Some(key.1.as_str()),
                global
                    | candidate.exact
                    | inherited_nested(key, candidate, &candidates, &mut inherited),
            )
        }));
    for (path, mask) in scopes {
        if mask == 0 || !checked.insert(mask) {
            continue;
        }
        let contents: Vec<_> = rendered
            .iter()
            .filter(|(bit, _)| bit & mask != 0)
            .map(|(_, content)| content.as_str())
            .collect();
        let prefix = render_preamble_prefix(&contents);
        let code_unit_length = utf16::len(&prefix);
        if prefix.contains(PREAMBLE_FILE_CONTEXT_SEPARATOR) {
            return Ok(Some(Violation::FileContextSeparator {
                project_path: path.map(str::to_owned),
            }));
        }
        if code_unit_length > PREAMBLE_COMBINED_MAX_LENGTH {
            return Ok(Some(Violation::CombinedLimit {
                project_path: path.map(str::to_owned),
                code_unit_length,
            }));
        }
    }
    Ok(None)
}

fn inherited_nested<'a>(
    key: &'a (String, String),
    candidate: &Candidate,
    candidates: &'a Candidates,
    cache: &mut HashMap<&'a (String, String), Mask>,
) -> Mask {
    if let Some(mask) = cache.get(key) {
        return *mask;
    }
    let mut cursor = key.clone();
    let parent = loop {
        let parent = parent_executor_path(&cursor.1);
        if parent == cursor.1 {
            break 0;
        }
        cursor.1 = parent;
        if let Some((parent_key, parent)) = candidates.get_key_value(&cursor) {
            break inherited_nested(parent_key, parent, candidates, cache);
        }
    };
    let mask = candidate.nested | parent;
    cache.insert(key, mask);
    mask
}

#[cfg(test)]
#[path = "catalog_budget_tests.rs"]
mod tests;
