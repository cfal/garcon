//! Ports `server-agents/interface/src/testing/conformance.ts`.

use std::{collections::HashSet, hash::Hash};

use garcon_contract::{
    agent_integration::AgentSettingsEnvelope,
    attachments::{ANY_FILE_ATTACHMENT_MIME_TYPE, FileAttachmentMimeTypes},
    input_format::is_input_format_by_model,
};
use garcon_js::is_safe_integer;
use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::{
    execution::AgentRunningSession,
    integration::{AGENT_INTEGRATION_API_VERSION, AgentIntegration},
    resources::ExecutorResult,
};

#[derive(Clone, Copy)]
pub struct AgentIntegrationConformanceOptions<'a> {
    pub integration_id: &'a str,
    pub api_version: u64,
    pub integration: &'a AgentIntegration,
}

pub fn validate_agent_integration(
    options: AgentIntegrationConformanceOptions<'_>,
) -> ExecutorResult<()> {
    let AgentIntegrationConformanceOptions {
        integration_id,
        api_version,
        integration,
    } = options;
    let descriptor = &integration.descriptor;
    let agent_id = &descriptor.id;
    if api_version != AGENT_INTEGRATION_API_VERSION {
        return Err(format!("Unsupported agent integration API version: {api_version}").into());
    }
    if integration_id != agent_id {
        return Err(
            format!("Agent integration ID mismatch: {integration_id} != {agent_id}").into(),
        );
    }
    // Rust requires the declared facets and their methods at construction.
    if let Some(attachments) = &integration.attachments
        && (matches!(&attachments.file_mime_types, FileAttachmentMimeTypes::Text(text)
                if text != ANY_FILE_ATTACHMENT_MIME_TYPE)
            || attachments
                .inline_text_max_bytes
                .is_some_and(|value| !is_safe_integer(value.0) || value.0 < 0.0))
    {
        return Err(
            format!("Agent integration {agent_id} has an invalid attachments facet").into(),
        );
    }
    if let Some(literal) = &integration.literal_execution
        && (literal.selection_label.is_empty()
            || !is_input_format_by_model(&literal.input_format_by_model)
            || integration.single_query.is_some()
            || integration.compaction.is_some()
            || integration.steering.is_some())
    {
        return Err(format!(
            "Agent integration {agent_id} has an invalid literal execution contract"
        )
        .into());
    }
    unique_descriptor_values(
        agent_id,
        "permission modes",
        &descriptor.supported_permission_modes,
    )?;
    unique_descriptor_values(
        agent_id,
        "thinking modes",
        &descriptor.supported_thinking_modes,
    )?;
    unique_descriptor_values(
        agent_id,
        "endpoint protocols",
        &descriptor.supported_endpoint_protocols,
    )
}

fn unique_descriptor_values<T: Eq + Hash>(
    agent_id: &str,
    label: &str,
    values: &[T],
) -> ExecutorResult<()> {
    let unique: HashSet<_> = values.iter().collect();
    if unique.len() != values.len() {
        return Err(format!("Agent integration {agent_id} declares duplicate {label}").into());
    }
    Ok(())
}

pub async fn run_agent_integration_conformance(
    options: AgentIntegrationConformanceOptions<'_>,
) -> ExecutorResult<()> {
    validate_agent_integration(options)?;
    let integration = options.integration;
    let agent_id = &integration.descriptor.id;
    let descriptors = integration.settings.describe();
    let descriptor_keys: HashSet<_> = descriptors.iter().map(|value| value.key.as_str()).collect();
    if descriptor_keys.len() != descriptors.len() {
        return Err(format!("Agent integration {agent_id} declares duplicate setting keys").into());
    }

    let defaults = integration.settings.defaults();
    let values = settings_values(agent_id, &defaults)?;
    for key in values.keys() {
        if !descriptor_keys.contains(key.as_str()) {
            return Err(format!(
                "Agent integration {agent_id} has an undescribed default setting: {key}"
            )
            .into());
        }
    }
    let parsed = integration.settings.parse(defaults)?;
    settings_values(agent_id, &parsed)?;
    let migrated = integration.settings.migrate(parsed).await?;
    let migrated_again = integration.settings.migrate(migrated.clone()).await?;
    settings_values(agent_id, &migrated)?;
    settings_values(agent_id, &migrated_again)?;
    if !same_settings(&migrated_again, &migrated) {
        return Err(
            format!("Agent integration {agent_id} settings migration is not idempotent").into(),
        );
    }
    let patched = integration
        .settings
        .apply_patch(migrated.clone(), IndexMap::new())?;
    settings_values(agent_id, &patched)?;
    if !same_settings(&patched, &migrated) {
        return Err(
            format!("Agent integration {agent_id} changed settings for an empty patch").into(),
        );
    }

    integration.lifecycle.start().await?;
    let running_sessions = async {
        integration.lifecycle.start().await?;
        assert_running_sessions(
            agent_id,
            &integration.execution.running_sessions(None).await?,
        )
    }
    .await;
    integration.lifecycle.stop().await?;
    integration.lifecycle.stop().await?;
    running_sessions
}

fn assert_running_sessions(agent_id: &str, sessions: &[AgentRunningSession]) -> ExecutorResult<()> {
    let mut seen = HashSet::new();
    if sessions.iter().any(|session| {
        session.agent_session_id.is_empty() || !seen.insert(session.agent_session_id.as_str())
    }) {
        return Err(format!(
            "Agent integration {agent_id} returned an invalid running session snapshot"
        )
        .into());
    }
    Ok(())
}

fn settings_values<'a>(
    agent_id: &str,
    settings: &'a AgentSettingsEnvelope,
) -> ExecutorResult<&'a Map<String, Value>> {
    settings
        .values
        .as_object()
        .filter(|_| {
            settings.owner_id == agent_id
                && is_safe_integer(settings.schema_version as f64)
                && settings.schema_version >= 1
        })
        .ok_or_else(|| {
            format!("Agent integration {agent_id} returned an invalid settings envelope").into()
        })
}

fn same_settings(left: &AgentSettingsEnvelope, right: &AgentSettingsEnvelope) -> bool {
    left.owner_id == right.owner_id
        && left.schema_version == right.schema_version
        && same_json(&left.values, &right.values)
}

fn same_json(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            // isDeepStrictEqual distinguishes positive and negative zero.
            left.as_f64().map(f64::to_bits) == right.as_f64().map(f64::to_bits)
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len() && left.iter().zip(right).all(|(a, b)| same_json(a, b))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| same_json(value, other)))
        }
        _ => left == right,
    }
}
