//! Ports `agents/cursor/cursor-acp-model-config.ts`.

use garcon_agents_common::acp::{client::AcpClient, policy::AcpSessionConfigurationContext};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Copy)]
enum Family {
    GptReasoning,
    ClaudeEffort,
    Plain,
}

struct Pattern {
    prefix: &'static str,
    model: &'static str,
    family: Family,
    context_for_variant: Option<&'static str>,
    default_context: Option<&'static str>,
    default_reasoning: Option<&'static str>,
    fast_capable: bool,
}

impl Pattern {
    const fn claude(
        prefix: &'static str,
        model: &'static str,
        context_for_variant: Option<&'static str>,
        fast_capable: bool,
    ) -> Self {
        Self {
            prefix,
            model,
            family: Family::ClaudeEffort,
            context_for_variant,
            default_context: None,
            default_reasoning: None,
            fast_capable,
        }
    }

    const fn gpt(model: &'static str, large_context: bool, fast_capable: bool) -> Self {
        Self {
            prefix: model,
            model,
            family: Family::GptReasoning,
            context_for_variant: if large_context { Some("1m") } else { None },
            default_context: if large_context { Some("272k") } else { None },
            default_reasoning: Some("medium"),
            fast_capable,
        }
    }
}

const PATTERNS: &[Pattern] = &[
    Pattern::claude("claude-opus-4-8", "claude-opus-4-8", Some("1m"), true),
    Pattern::claude("claude-opus-4-7", "claude-opus-4-7", Some("1m"), true),
    Pattern::claude("claude-opus-4-6", "claude-opus-4-6", Some("1m"), true),
    Pattern::claude("claude-opus-4-5", "claude-opus-4-5", None, false),
    Pattern::claude("claude-4.6-sonnet", "claude-sonnet-4-6", Some("1m"), false),
    Pattern::claude("claude-4.6-opus", "claude-opus-4-6", Some("1m"), true),
    Pattern::claude("claude-4.5-opus", "claude-opus-4-5", None, false),
    Pattern::claude("claude-4.5-sonnet", "claude-sonnet-4-5", None, false),
    Pattern::claude("claude-4-sonnet", "claude-sonnet-4", None, false),
    Pattern::claude("claude-fable-5", "claude-fable-5", Some("1m"), false),
    Pattern::gpt("gpt-5.1-codex-max", false, true),
    Pattern::gpt("gpt-5.1-codex-mini", false, false),
    Pattern::gpt("gpt-5.3-codex", false, true),
    Pattern::gpt("gpt-5.2-codex", false, true),
    Pattern::gpt("gpt-5.4-mini", false, false),
    Pattern::gpt("gpt-5.4-nano", false, false),
    Pattern {
        prefix: "composer-2.5",
        model: "composer-2.5",
        family: Family::Plain,
        context_for_variant: None,
        default_context: None,
        default_reasoning: None,
        fast_capable: true,
    },
    Pattern::gpt("gpt-5.5", true, true),
    Pattern::gpt("gpt-5.4", true, true),
    Pattern::gpt("gpt-5.2", false, true),
    Pattern::gpt("gpt-5.1", false, false),
];

pub fn cursor_acp_mode_for_permission_mode(permission_mode: &str) -> &'static str {
    if permission_mode == "plan" {
        "plan"
    } else {
        "agent"
    }
}

pub fn cursor_config_selection_for_model(model: &str) -> Option<Value> {
    if matches!(model, "" | "default" | "auto") {
        return Some(json!({"model":"default"}));
    }
    let fast = model.strip_suffix("-fast");
    let base = fast.unwrap_or(model);
    let pattern = PATTERNS
        .iter()
        .filter_map(|pattern| {
            let remaining = base.strip_prefix(pattern.prefix)?;
            let suffix = if remaining.is_empty() {
                ""
            } else {
                remaining.strip_prefix('-')?
            };
            Some((pattern, suffix))
        })
        .max_by_key(|(pattern, _)| pattern.prefix.len());
    let Some((matched, suffix)) = pattern else {
        return Some(if fast.is_some() {
            json!({"model":base,"fast":"true"})
        } else {
            json!({"model":base})
        });
    };

    let mut selection = serde_json::Map::from_iter([("model".into(), json!(matched.model))]);
    let mut push = |name: &str, value: Option<&str>| {
        if let Some(value) = value {
            selection.insert(name.into(), json!(value));
        }
    };
    let explicit_fast = fast.is_some().then_some("true");
    let configured_fast = explicit_fast.or(matched.fast_capable.then_some("false"));
    if suffix.is_empty() {
        push("context", matched.default_context);
        push("reasoning", matched.default_reasoning);
        push("fast", configured_fast);
    } else {
        match matched.family {
            Family::GptReasoning => {
                let reasoning = match suffix {
                    "xhigh" => "extra-high",
                    "none" | "low" | "medium" | "high" | "extra-high" => suffix,
                    _ => return None,
                };
                push("context", matched.context_for_variant);
                push("reasoning", Some(reasoning));
                push("fast", configured_fast);
            }
            Family::ClaudeEffort => {
                push("context", matched.context_for_variant);
                let affixed = suffix
                    .strip_prefix("thinking-")
                    .or_else(|| suffix.strip_suffix("-thinking"));
                if suffix == "thinking" || affixed.is_some() {
                    push("thinking", Some("true"));
                }
                if suffix != "thinking" {
                    let effort = affixed.unwrap_or(suffix);
                    if !matches!(effort, "low" | "medium" | "high" | "xhigh" | "max") {
                        return None;
                    }
                    push("effort", Some(effort));
                }
                push("fast", configured_fast);
            }
            Family::Plain => push("fast", explicit_fast),
        }
    }
    Some(selection.into())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAcpConfigAssignment {
    pub config_id: &'static str,
    pub value: String,
}

pub fn assignments_for_cursor_model(
    model: &str,
    mode: Option<&str>,
) -> ExecutorResult<Vec<CursorAcpConfigAssignment>> {
    let selection = cursor_config_selection_for_model(model)
        .ok_or_else(|| format!("Cursor model is not supported by ACP config mapping: {model}"))?;
    Ok([
        "mode",
        "model",
        "context",
        "reasoning",
        "effort",
        "thinking",
        "fast",
    ]
    .into_iter()
    .filter_map(|config_id| {
        let value = if config_id == "mode" {
            mode
        } else {
            selection.get(config_id).and_then(Value::as_str)
        }?;
        (config_id == "model" || !value.is_empty()).then(|| CursorAcpConfigAssignment {
            config_id,
            value: value.into(),
        })
    })
    .collect())
}

pub async fn configure_cursor_acp_session(
    context: AcpSessionConfigurationContext<'_>,
    logger: Option<&dyn AgentLogger>,
) -> ExecutorResult<Value> {
    let mode = cursor_acp_mode_for_permission_mode(context.request.permission_mode.as_str());
    configure_cursor_acp_session_options(
        &context.client,
        &context.session_id,
        &context.request.model,
        mode,
        context.config_options,
        logger,
    )
    .await
}

pub async fn configure_cursor_acp_session_options(
    client: &AcpClient,
    session_id: &str,
    model: &str,
    mode: &str,
    config_options: Option<Value>,
    logger: Option<&dyn AgentLogger>,
) -> ExecutorResult<Value> {
    let mut options = config_options
        .filter(|options| !options.is_null())
        .unwrap_or_else(|| json!([]));
    let assignments = assignments_for_cursor_model(model, Some(mode))?;
    let result: ExecutorResult<()> = async {
        for assignment in &assignments {
            let id = assignment.config_id;
            let wanted = &assignment.value;
            let option = find_option(&options, id).ok_or_else(|| format!("Cursor did not expose {id} while selecting {model}"))?;
            let values = option.get("options").and_then(Value::as_array).into_iter().flatten()
                .filter_map(|option| option.get("value").and_then(Value::as_str)).collect::<Vec<_>>();
            if !values.contains(&wanted.as_str()) {
                let offered = if values.is_empty() { "no values".to_owned() } else { values.join(", ") };
                return Err(format!("Cursor model {model} requires {id}={wanted}, but Cursor only offered {offered}").into());
            }
            let result = client.set_session_config_option(session_id, id, wanted).await?;
            options = result.get("configOptions").filter(|value| !value.is_null()).cloned().unwrap_or_else(|| json!([]));
            let current = find_option(&options, id).and_then(|option| option.get("currentValue"));
            if current.and_then(Value::as_str) != Some(wanted) {
                let current = current.filter(|value| !value.is_null()).map(|value| garcon_base::errors::js_string(garcon_base::errors::ErrorInput::Json(value)).into_owned()).unwrap_or_else(|| "missing".into());
                return Err(format!("Cursor did not apply requested model {model}. Expected {id}={wanted}, got {current}.").into());
            }
        }
        Ok(())
    }.await;
    if let Some(logger) = logger {
        if let Err(error) = &result {
            logger.warn(
                "Failed to configure Cursor ACP model",
                Some(&IndexMap::from([
                    ("model".into(), json!(model).into()),
                    ("error".into(), json!(error.to_string()).into()),
                ])),
            );
        } else {
            let formatted = assignments
                .iter()
                .map(|assignment| format!("{}={}", assignment.config_id, assignment.value))
                .collect::<Vec<_>>()
                .join(", ");
            logger.info(
                "Configured Cursor ACP model",
                Some(&IndexMap::from([
                    ("sessionId".into(), json!(session_id).into()),
                    ("assignments".into(), json!(formatted).into()),
                ])),
            );
        }
    }
    result?;
    Ok(options)
}

fn find_option<'a>(options: &'a Value, id: &str) -> Option<&'a Value> {
    options
        .as_array()?
        .iter()
        .find(|option| option.get("id").and_then(Value::as_str) == Some(id))
}
