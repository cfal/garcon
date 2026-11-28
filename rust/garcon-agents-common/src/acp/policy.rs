//! Ports `server-agents/common/src/acp/policy.ts`.

use std::collections::BTreeMap;
use std::rc::Rc;

use futures::future::LocalBoxFuture;
use garcon_interface::resources::ExecutorResult;
use serde_json::Value;

use crate::chats::artificial_native_path::create_artificial_native_path;

use super::client::AcpClient;
use super::errors::AcpRpcError;
use super::protocol::AcpSessionPromptResult;
use super::runtime_helpers::{build_env_fallback, build_prompt_fallback};
use super::runtime_session::SessionRef;
use super::runtime_types::AcpExecutionRequest;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AcpAbortStrategy {
    #[default]
    Cancel,
    ProcessRestart,
}

pub type AcpPrompt = Vec<Value>;
pub type AcpChildEnv = BTreeMap<String, Option<String>>;

pub trait AcpSteeringProtocol {
    fn likely_superseded(&self, result: &AcpSessionPromptResult) -> bool;
    fn refused(&self, error: &AcpRpcError) -> bool;
}

#[derive(Default)]
pub struct AcpSessionStatePatch {
    pub config_options: Option<Value>,
    pub models: Option<Value>,
}

pub type ApplySessionState = Rc<dyn Fn(AcpSessionStatePatch)>;

pub struct AcpSessionConfigurationContext<'a> {
    pub client: Rc<AcpClient>,
    pub session_id: String,
    pub request: &'a AcpExecutionRequest,
    pub config_options: Option<Value>,
    pub models: Option<Value>,
    pub agent_default_model_id: Option<String>,
    pub apply_state: ApplySessionState,
}

pub type ConfigureSession = Rc<
    dyn for<'a> Fn(AcpSessionConfigurationContext<'a>) -> LocalBoxFuture<'a, ExecutorResult<()>>,
>;
pub type BuildEnv = Rc<dyn Fn(&AcpExecutionRequest) -> ExecutorResult<AcpChildEnv>>;
pub type BuildPrompt = Rc<dyn Fn(&AcpExecutionRequest) -> ExecutorResult<AcpPrompt>>;
pub type ResolveNativePath = Rc<dyn Fn(&str) -> Option<String>>;

pub struct AcpAgentPolicy {
    pub agent_id: String,
    pub command: Rc<dyn Fn() -> ExecutorResult<String>>,
    pub args: Option<Vec<String>>,
    pub abort_strategy: AcpAbortStrategy,
    pub steering: Option<Rc<dyn AcpSteeringProtocol>>,
    pub accepts_edits_on_client: bool,
    pub authenticate_method_id: Option<Rc<dyn Fn() -> ExecutorResult<String>>>,
    pub mcp_servers: Option<Vec<Value>>,
    pub client_capabilities: Option<Value>,
    pub configure_session: Option<ConfigureSession>,
    pub build_env: Option<BuildEnv>,
    pub build_prompt: Option<BuildPrompt>,
    pub resolve_native_path: Option<ResolveNativePath>,
}

impl AcpAgentPolicy {
    pub fn new(agent_id: impl Into<String>, command: impl Into<String>) -> Self {
        let command = command.into();
        Self {
            agent_id: agent_id.into(),
            command: Rc::new(move || Ok(command.clone())),
            args: None,
            abort_strategy: AcpAbortStrategy::default(),
            steering: None,
            accepts_edits_on_client: false,
            authenticate_method_id: None,
            mcp_servers: None,
            client_capabilities: None,
            configure_session: None,
            build_env: None,
            build_prompt: None,
            resolve_native_path: None,
        }
    }
}

pub fn explicit_acp_model(model: Option<&str>) -> Option<&str> {
    model.filter(|model| !model.is_empty() && *model != "default")
}

pub(super) async fn configure_session_for(
    policy: &AcpAgentPolicy,
    session: &SessionRef,
    request: &AcpExecutionRequest,
    agent_default_model_id: Option<String>,
) -> ExecutorResult<()> {
    let Some(configure) = &policy.configure_session else {
        return Ok(());
    };
    let context = {
        let current = session.borrow();
        AcpSessionConfigurationContext {
            client: Rc::clone(&current.client),
            session_id: current.id.clone(),
            request,
            config_options: current.config_options.clone(),
            models: current.models.clone(),
            agent_default_model_id,
            apply_state: Rc::new({
                let session = Rc::clone(session);
                move |patch| {
                    let mut current = session.borrow_mut();
                    if let Some(config_options) = patch.config_options {
                        current.config_options = Some(config_options);
                    }
                    if let Some(models) = patch.models {
                        current.models = Some(models);
                    }
                }
            }),
        }
    };
    configure(context).await
}

pub fn prompt_for(
    policy: &AcpAgentPolicy,
    request: &AcpExecutionRequest,
) -> ExecutorResult<AcpPrompt> {
    if let Some(build_prompt) = policy.build_prompt.as_ref() {
        let prompt = build_prompt(request)?;
        if !prompt.is_empty() {
            return Ok(prompt);
        }
    }
    Ok(build_prompt_fallback(request))
}

pub fn child_environment_for(
    policy: &AcpAgentPolicy,
    request: &AcpExecutionRequest,
) -> ExecutorResult<AcpChildEnv> {
    match &policy.build_env {
        Some(build_env) => build_env(request),
        None => Ok(build_env_fallback(request)),
    }
}

pub fn native_path_for(policy: &AcpAgentPolicy, session_id: &str) -> Option<String> {
    match &policy.resolve_native_path {
        Some(resolve) => resolve(session_id),
        None => create_artificial_native_path(Some(&policy.agent_id), Some(session_id)),
    }
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, markers, replay, text};

    use super::*;

    #[test]
    fn recorded_acp_model_selection_matches() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/acp-policy"),
            |function, args| {
                if function != "explicitAcpModel" {
                    return Err(CaseError::unhandled(function));
                }
                Ok(explicit_acp_model(text(function, args.first())?)
                    .map_or_else(markers::undefined, Value::from))
            },
        );
    }
}
