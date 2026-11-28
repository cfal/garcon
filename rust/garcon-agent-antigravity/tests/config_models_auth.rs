use garcon_agent_antigravity::{
    antigravity_acp_policy::{antigravity_mode_for_permission_mode, antigravity_prompt},
    antigravity_auth::validate_antigravity_login_code,
    antigravity_models::{AntigravityCliResult, antigravity_cli_failure, parse_antigravity_models},
    config::resolve_auth_method,
};
use garcon_cases::{CaseError, replay, text, unknown};
use garcon_contract::chat_modes::PermissionMode;
use garcon_interface::{errors::AgentIntegrationError, resources::ExecutorResult};
use serde::Serialize;
use serde_json::{Value, json};

fn undeliverable(error: impl std::fmt::Display) -> CaseError {
    CaseError::undeliverable(error.to_string())
}

fn wire(value: impl Serialize) -> Result<Value, CaseError> {
    garcon_js::json::from_slice(&serde_json::to_vec(&value).map_err(undeliverable)?)
        .map_err(undeliverable)
}

fn result(value: ExecutorResult<impl Serialize>) -> Result<Value, CaseError> {
    match value {
        Ok(value) => wire(value),
        Err(error) => {
            let error = error
                .downcast::<AgentIntegrationError>()
                .map_err(undeliverable)?;
            Ok(json!({
                "$": "error", "name": "AgentIntegrationError", "message": error.message,
                "properties": {
                    "code": error.code.as_str(), "retryable": error.retryable,
                    "details": garcon_cases::markers::undefined(),
                },
            }))
        }
    }
}

fn required_text<'a>(function: &str, arg: Option<&'a Value>) -> Result<&'a str, CaseError> {
    text(function, arg)?.ok_or_else(|| CaseError::undeliverable("expected a string"))
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    let string = || required_text(function, args.first());
    match function {
        "resolveAuthMethod" => result(resolve_auth_method(
            text(function, args.first())?,
            args.get(1)
                .and_then(Value::as_bool)
                .ok_or_else(|| CaseError::undeliverable("expected a boolean"))?,
        )),
        "antigravityPrompt" => {
            let request = unknown(function, args.first())?;
            let command = request
                .get("command")
                .and_then(Value::as_str)
                .ok_or_else(|| CaseError::undeliverable("expected a command"))?;
            let images = request
                .get("images")
                .map(|images| serde_json::from_value(images.clone()))
                .transpose()
                .map_err(undeliverable)?
                .unwrap_or_else(Vec::new);
            result(antigravity_prompt(command, &images))
        }
        "antigravityModeForPermissionMode" => wire(antigravity_mode_for_permission_mode(
            serde_json::from_value::<PermissionMode>(Value::from(string()?))
                .map_err(undeliverable)?,
        )),
        "parseAntigravityModels" => wire(parse_antigravity_models(string()?)),
        "validateAntigravityLoginCode" => wire(validate_antigravity_login_code(string()?)),
        "antigravityCliFailure" => {
            let supplied = unknown(function, args.first())?;
            wire(antigravity_cli_failure(&AntigravityCliResult {
                stdout: required_text(function, supplied.get("stdout"))?.into(),
                stderr: required_text(function, supplied.get("stderr"))?.into(),
                exit_code: supplied
                    .get("exitCode")
                    .and_then(Value::as_i64)
                    .map(i32::try_from)
                    .transpose()
                    .map_err(undeliverable)?,
            }))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn recorded_antigravity_config_models_auth_and_prompt_cases_match() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/config-models-auth"
        ),
        dispatch,
    );
}
