//! Ports the independent request validation in `server/controller/preambles/service.ts`.

use std::{collections::HashSet, rc::Rc};

use garcon_contract::{
    executors::effective_executor_id,
    preambles::{
        PreambleDefinition, PreambleErrorCode, PreambleProjectPathRule, PreambleScope,
        is_preamble_id, normalize_ordered_preamble_ids, normalize_preamble_definition_input,
    },
    project_resolution::ProjectInspector,
};
use serde_json::Value;

use super::{Result, errors::PreambleDomainError, project_path_service::resolve_project_path};

pub fn validate_id(id: &Value) -> Result<(), PreambleDomainError> {
    if is_preamble_id(id) {
        Ok(())
    } else {
        Err(validation_error())
    }
}

pub fn validate_order(value: &Value) -> Result<Vec<String>, PreambleDomainError> {
    normalize_ordered_preamble_ids(value).ok_or_else(validation_error)
}

pub async fn validate_definition(
    value: &Value,
    previous: Option<&PreambleDefinition>,
    inspect: Rc<dyn ProjectInspector>,
) -> Result<PreambleDefinition> {
    let mut definition = normalize_preamble_definition_input(value).ok_or_else(validation_error)?;
    let previous = match previous.map(|entry| &entry.scope) {
        Some(PreambleScope::ProjectPaths { rules }) => rules.as_slice(),
        _ => &[],
    };
    if let PreambleScope::ProjectPaths { rules } = &mut definition.scope {
        resolve_rules(rules, previous, inspect).await?;
    }
    Ok(definition)
}

async fn resolve_rules(
    rules: &mut [PreambleProjectPathRule],
    previous: &[PreambleProjectPathRule],
    inspect: Rc<dyn ProjectInspector>,
) -> Result<()> {
    let (send, mut receive) = tokio::sync::mpsc::unbounded_channel();
    let mut pending = 0;
    for (index, rule) in rules.iter().enumerate() {
        if previous.iter().any(|entry| same_rule(entry, rule)) {
            continue;
        }
        let inspect = inspect.clone();
        let rule = rule.clone();
        let send = send.clone();
        pending += 1;
        // Promise.all rejects immediately without cancelling sibling inspections.
        tokio::task::spawn_local(async move {
            let result = resolve_project_path(&*inspect, rule.project_path, rule.executor_id).await;
            let _ = send.send((index, result));
        });
    }
    drop(send);
    for _ in 0..pending {
        let (index, result) = receive
            .recv()
            .await
            .ok_or("Project inspection did not finish")?;
        rules[index].project_path = result?;
    }
    let mut projects = HashSet::new();
    if !rules.iter().all(|rule| {
        projects.insert((
            effective_executor_id(rule.executor_id.as_deref()),
            rule.project_path.as_str(),
        ))
    }) {
        return Err(PreambleDomainError::new(
            PreambleErrorCode::VALIDATION_FAILED,
            "Project paths must be unique",
            400,
        )
        .into());
    }
    Ok(())
}

fn same_rule(a: &PreambleProjectPathRule, b: &PreambleProjectPathRule) -> bool {
    effective_executor_id(a.executor_id.as_deref())
        == effective_executor_id(b.executor_id.as_deref())
        && a.project_path == b.project_path
        && a.include_nested == b.include_nested
}

fn validation_error() -> PreambleDomainError {
    PreambleDomainError::new(
        PreambleErrorCode::VALIDATION_FAILED,
        "Preamble is invalid",
        400,
    )
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
