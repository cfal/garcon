//! Ports `agents/cursor/cursor-acp-policy.ts`.

use std::{collections::BTreeMap, rc::Rc};

use garcon_agents_common::acp::policy::{
    AcpAbortStrategy, AcpAgentPolicy, AcpChildEnv, AcpSessionStatePatch,
};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::trim;
use serde_json::{Value, json};

use crate::{
    config::CursorConfig,
    cursor_acp_model_config::configure_cursor_acp_session,
    cursor_native_path::{CURSOR_AGENT_ID, create_cursor_acp_native_path},
};

pub const CURSOR_AUTH_METHOD: &str = "cursor_login";

pub(crate) fn cursor_capabilities() -> Value {
    json!({"_meta":{"parameterizedModelPicker":true}})
}

pub(crate) fn cursor_child_env(
    config: &CursorConfig,
    overrides: BTreeMap<String, String>,
) -> ExecutorResult<AcpChildEnv> {
    let mut environment: AcpChildEnv = std::env::vars_os()
        .filter_map(|(key, value)| Some((key.into_string().ok()?, Some(value.into_string().ok()?))))
        .collect();
    if let Some(key) = config.api_key()? {
        environment.insert("CURSOR_API_KEY".into(), Some(key));
    }
    environment.extend(overrides.into_iter().map(|(key, value)| (key, Some(value))));
    Ok(environment)
}

pub fn create_cursor_acp_policy(
    config: CursorConfig,
    logger: Option<Rc<dyn AgentLogger>>,
) -> AcpAgentPolicy {
    let mut policy = AcpAgentPolicy::new(CURSOR_AGENT_ID, "cursor-agent");
    policy.command = Rc::new({
        let config = config.clone();
        move || config.binary()
    });
    policy.args = Some(vec!["acp".into()]);
    policy.abort_strategy = AcpAbortStrategy::ProcessRestart;
    policy.accepts_edits_on_client = true;
    policy.authenticate_method_id = Some(Rc::new(|| Ok(CURSOR_AUTH_METHOD.into())));
    policy.client_capabilities = Some(cursor_capabilities());
    policy.configure_session = Some(Rc::new(move |context| {
        let apply_state = context.apply_state.clone();
        let logger = logger.clone();
        Box::pin(async move {
            let options = configure_cursor_acp_session(context, logger.as_deref()).await?;
            apply_state(AcpSessionStatePatch {
                config_options: Some(options),
                models: None,
            });
            Ok(())
        })
    }));
    policy.build_prompt = Some(Rc::new(move |request| {
        if request
            .images
            .as_ref()
            .is_some_and(|images| !images.is_empty())
        {
            return Err(
                "Cursor ACP does not currently support image attachments in Garcon.".into(),
            );
        }
        Ok(vec![json!({"type":"text","text":trim(&request.command)})])
    }));
    policy.build_env = Some(Rc::new(move |request| {
        cursor_child_env(&config, request.env_overrides.clone())
    }));
    policy.resolve_native_path = Some(Rc::new(|id| create_cursor_acp_native_path(Some(id))));
    policy
}
