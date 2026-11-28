//! Ports `agents/antigravity/antigravity-acp-policy.ts`.

use std::rc::Rc;

use garcon_agents_common::{
    acp::{
        client::AcpClient,
        errors::AcpRpcError,
        policy::{
            AcpAgentPolicy, AcpPrompt, AcpSessionConfigurationContext, AcpSessionStatePatch,
            AcpSteeringProtocol, explicit_acp_model,
        },
        protocol::AcpSessionPromptResult,
        runtime_types::AcpExecutionRequest,
    },
    chats::artificial_native_path::create_artificial_native_path,
    shared::attachments::parse_attachment_data_url,
};
use garcon_contract::{agent_execution::AgentAttachment, chat_modes::PermissionMode};
use garcon_interface::{errors::AgentIntegrationErrorCode as Code, resources::ExecutorResult};
use garcon_js::trim;
use serde_json::{Value, json};

use crate::config::{AntigravityConfig, child_environment, integration_error};

pub const ANTIGRAVITY_AGENT_ID: &str = "antigravity";

pub fn antigravity_mode_for_permission_mode(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Plan => "plan",
        PermissionMode::AcceptEdits => "accept-edits",
        _ => "default",
    }
}

pub fn antigravity_prompt(command: &str, images: &[AgentAttachment]) -> ExecutorResult<AcpPrompt> {
    let text = trim(command);
    if text.is_empty() && images.is_empty() {
        return Err(integration_error(
            Code::PROVIDER_FAILURE,
            "Antigravity needs a message or an image to send.",
        ));
    }
    let mut prompt = Vec::new();
    if !text.is_empty() {
        prompt.push(json!({"type": "text", "text": text}));
    }
    for attachment in images {
        let Some(parts) = parse_attachment_data_url(Some(&attachment.data))
            .filter(|parts| parts.mime_type.starts_with("image/"))
        else {
            return Err(integration_error(
                Code::PROVIDER_FAILURE,
                format!(
                    "Antigravity cannot attach {}: only base64 image data URLs are supported",
                    attachment.name.as_deref().unwrap_or("an attachment")
                ),
            ));
        };
        prompt.push(json!({"type": "image", "mimeType": parts.mime_type, "data": parts.base64}));
    }
    Ok(prompt)
}

async fn configure_session(context: AcpSessionConfigurationContext<'_>) -> ExecutorResult<()> {
    let model = explicit_acp_model(Some(&context.request.model)).or_else(|| {
        offered_model(
            context.models.as_ref(),
            context.agent_default_model_id.as_deref(),
        )
    });
    if let Some(models) = apply_model(
        &context.client,
        &context.session_id,
        context.models.as_ref(),
        model,
    )
    .await?
    {
        (context.apply_state)(AcpSessionStatePatch {
            models: Some(models),
            ..Default::default()
        });
    }
    let mode = antigravity_mode_for_permission_mode(context.request.permission_mode);
    let config_options = apply_mode(
        &context.client,
        &context.session_id,
        context.config_options.as_ref(),
        mode,
    )
    .await?;
    (context.apply_state)(AcpSessionStatePatch {
        config_options: Some(config_options),
        ..Default::default()
    });
    Ok(())
}

fn offered_model<'a>(models: Option<&Value>, model: Option<&'a str>) -> Option<&'a str> {
    let model = model.filter(|model| !model.is_empty())?;
    if let Some(available) = models.and_then(|models| models.get("availableModels")) {
        let available = available.as_array()?;
        if !available.is_empty() && !contains_model(available, model) {
            return None;
        }
    }
    Some(model)
}

fn contains_model(available: &[Value], model: &str) -> bool {
    available
        .iter()
        .any(|entry| entry.get("modelId").and_then(Value::as_str) == Some(model))
}

pub(crate) async fn apply_model(
    client: &AcpClient,
    session_id: &str,
    models: Option<&Value>,
    model: Option<&str>,
) -> ExecutorResult<Option<Value>> {
    let Some(model) = model.filter(|model| !model.is_empty()) else {
        return Ok(None);
    };
    if models
        .and_then(|models| models.get("currentModelId"))
        .and_then(Value::as_str)
        == Some(model)
    {
        return Ok(None);
    }
    if let Some(available) = models
        .and_then(|models| models.get("availableModels"))
        .and_then(Value::as_array)
        && !available.is_empty()
        && !contains_model(available, model)
    {
        return Err(integration_error(
            Code::PROVIDER_FAILURE,
            format!("Antigravity model {model} is not available for this account."),
        ));
    }
    client.set_session_model(session_id, model).await?;
    let mut updated = models
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    updated.insert("currentModelId".into(), Value::from(model));
    Ok(Some(updated.into()))
}

fn session_mode_option(config_options: Option<&Value>) -> ExecutorResult<Option<&Value>> {
    let Some(config_options) = config_options.filter(|options| !options.is_null()) else {
        return Ok(None);
    };
    let options = config_options
        .as_array()
        .filter(|options| {
            options
                .iter()
                .all(|option| option.get("id").is_some_and(Value::is_string))
        })
        .ok_or_else(|| {
            integration_error(
                Code::PROVIDER_FAILURE,
                "Antigravity returned invalid session config options.",
            )
        })?;
    Ok(options
        .iter()
        .find(|option| option.get("id").and_then(Value::as_str) == Some("mode")))
}

pub(crate) async fn apply_mode(
    client: &AcpClient,
    session_id: &str,
    config_options: Option<&Value>,
    mode: &str,
) -> ExecutorResult<Value> {
    if config_options.is_some_and(|options| !options.is_null()) {
        let mode_option = session_mode_option(config_options)?;
        let advertised = mode_option
            .and_then(|option| option.get("options"))
            .and_then(Value::as_array)
            .is_some_and(|choices| {
                choices
                    .iter()
                    .any(|choice| choice.get("value").and_then(Value::as_str) == Some(mode))
            });
        if (mode_option.is_some() || mode != "default") && !advertised {
            return Err(integration_error(
                Code::PROVIDER_FAILURE,
                format!("Antigravity does not offer the {mode} mode for this session."),
            ));
        }
    }

    let result = client
        .set_session_config_option(session_id, "mode", mode)
        .await?;
    let options = result.get("configOptions");
    let applied = session_mode_option(options)?
        .and_then(|option| option.get("currentValue"))
        .and_then(Value::as_str);
    match applied {
        None => Err(integration_error(
            Code::PROVIDER_FAILURE,
            format!("Antigravity did not confirm the requested {mode} mode."),
        )),
        Some(applied) if applied != mode => Err(integration_error(
            Code::PROVIDER_FAILURE,
            format!(
                "Antigravity did not apply the requested mode: expected {mode}, got {applied}."
            ),
        )),
        // INFALLIBLE: a confirmed mode came from the options array.
        Some(_) => Ok(options.expect("confirmed mode has options").clone()),
    }
}

pub fn create_antigravity_native_path(id: &str) -> Option<String> {
    create_artificial_native_path(Some(ANTIGRAVITY_AGENT_ID), Some(id))
}

struct AntigravitySteering;

impl AcpSteeringProtocol for AntigravitySteering {
    fn likely_superseded(&self, result: &AcpSessionPromptResult) -> bool {
        // agy also sends a bare end_turn for natural completions without usage.
        result.get("stopReason").and_then(Value::as_str) == Some("end_turn")
            && result.get("usage").is_none_or(Value::is_null)
    }

    fn refused(&self, error: &AcpRpcError) -> bool {
        error.has_code(-32603.0)
            && error
                .message
                .contains("answer it or send session/cancel, then send this prompt again")
    }
}

pub fn create_antigravity_acp_policy(config: AntigravityConfig) -> AcpAgentPolicy {
    let mut policy = AcpAgentPolicy::new(ANTIGRAVITY_AGENT_ID, "agy");
    policy.command = Rc::new({
        let config = config.clone();
        move || config.binary()
    });
    policy.args = Some(vec!["acp".into()]);
    policy.steering = Some(Rc::new(AntigravitySteering));
    policy.authenticate_method_id = Some(Rc::new({
        let config = config.clone();
        move || config.auth_method().map(str::to_owned)
    }));
    policy.client_capabilities = Some(json!({}));
    policy.configure_session = Some(Rc::new(|context| Box::pin(configure_session(context))));
    policy.build_prompt = Some(Rc::new(|request: &AcpExecutionRequest| {
        antigravity_prompt(
            &request.command,
            request.images.as_deref().unwrap_or_default(),
        )
    }));
    policy.build_env = Some(Rc::new(move |request| {
        child_environment(&config, &request.env_overrides)
    }));
    policy.resolve_native_path = Some(Rc::new(create_antigravity_native_path));
    policy
}
