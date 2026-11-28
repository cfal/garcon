//! Ports `server/controller/preambles/matching.ts`.

use garcon_contract::{
    executor_path::is_within_executor_path,
    executors::effective_executor_id,
    preambles::{Preamble, PreambleProjectPathRule, PreambleScope, PreambleTagMatchMode},
};

pub struct NewChatPreambleContext<'a> {
    pub executor_id: Option<&'a str>,
    pub canonical_project_path: &'a str,
    pub agent_id: &'a str,
    pub tags: &'a [String],
}

pub fn preamble_rule_matches(
    rule: &PreambleProjectPathRule,
    path: &str,
    executor_id: Option<&str>,
) -> bool {
    effective_executor_id(rule.executor_id.as_deref()) == effective_executor_id(executor_id)
        && (path == rule.project_path
            || (rule.include_nested && is_within_executor_path(&rule.project_path, path)))
}

pub fn applicable_preambles(
    preambles: &[Preamble],
    path: &str,
    executor_id: Option<&str>,
) -> Vec<Preamble> {
    preambles
        .iter()
        .filter(|preamble| preamble_matches_project_path(preamble, path, executor_id))
        .cloned()
        .collect()
}

pub fn preamble_scope_matches(preamble: &Preamble, path: &str, executor_id: Option<&str>) -> bool {
    match &preamble.definition.scope {
        PreambleScope::Global => true,
        PreambleScope::ProjectPaths { rules } => rules
            .iter()
            .any(|rule| preamble_rule_matches(rule, path, executor_id)),
    }
}

pub fn preamble_matches_project_path(
    preamble: &Preamble,
    path: &str,
    executor_id: Option<&str>,
) -> bool {
    preamble.definition.enabled && preamble_scope_matches(preamble, path, executor_id)
}

pub fn preamble_matches_new_chat_defaults(
    preamble: &Preamble,
    context: &NewChatPreambleContext<'_>,
) -> bool {
    if !preamble_matches_project_path(
        preamble,
        context.canonical_project_path,
        context.executor_id,
    ) {
        return false;
    }
    let definition = &preamble.definition;
    if !definition.agent_ids.is_empty()
        && !definition.agent_ids.iter().any(|id| id == context.agent_id)
    {
        return false;
    }
    if definition.tag_filter.tags.is_empty() {
        return true;
    }
    let mut tags = definition.tag_filter.tags.iter();
    match definition.tag_filter.mode {
        PreambleTagMatchMode::All => tags.all(|tag| context.tags.contains(tag)),
        PreambleTagMatchMode::Any => tags.any(|tag| context.tags.contains(tag)),
    }
}
