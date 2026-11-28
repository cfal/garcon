use garcon_agents_common::execution::permission_modes::provider_startup_permission_mode;
use garcon_contract::chat_modes::{ClaudeThinkingMode, PermissionMode, ThinkingMode};
use garcon_interface::errors::AgentIntegrationError;

use crate::model_context::resolve_claude_model;

// Claude 2.1.284 and later can require manual approval even under bypass permissions.
pub const CLAUDE_REMOVAL_TARGET_GUIDANCE: &str = concat!(
    "Claude Code asks a person to approve an rm or rmdir",
    " whose target could expand to the filesystem root or another top-level directory, even when",
    " permissions are bypassed, and the turn waits for that answer. Write removal targets as",
    " literal paths, or guard every variable in them with ${VAR:?}, for example",
    " rm -rf \"${build_dir:?}\"/*.",
);

#[derive(Default)]
pub struct ClaudeCliArgOptions<'a> {
    pub model: Option<&'a str>,
    pub permission_mode: Option<PermissionMode>,
    pub thinking_mode: Option<ThinkingMode>,
    pub claude_thinking_mode: Option<ClaudeThinkingMode>,
    pub prompt: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub resume_session_id: Option<&'a str>,
    pub stream_json: bool,
}

pub fn build_claude_cli_args(
    options: ClaudeCliArgOptions<'_>,
) -> Result<Vec<String>, AgentIntegrationError> {
    let mut args = if options.stream_json {
        [
            "--print",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--replay-user-messages",
            "--verbose",
        ]
        .map(str::to_owned)
        .to_vec()
    } else {
        ["--print", "--no-session-persistence"]
            .map(str::to_owned)
            .to_vec()
    };
    if let Some(model) = options.model.filter(|model| !model.is_empty()) {
        let resolved = resolve_claude_model(model)?;
        args.extend(["--model".to_owned(), resolved.model]);
        if let Some(window) = resolved.auto_compact_window {
            args.extend(["--autocompact".to_owned(), format!("{}k", window / 1000)]);
        }
    }
    let mode = provider_startup_permission_mode(options.permission_mode);
    if mode == PermissionMode::BypassPermissions {
        args.push("--dangerously-skip-permissions".to_owned());
    } else {
        args.extend(["--permission-mode", mode.as_str()].map(str::to_owned));
    }
    if options.stream_json {
        args.extend(
            [
                "--permission-prompt-tool",
                "stdio",
                "--append-system-prompt",
                CLAUDE_REMOVAL_TARGET_GUIDANCE,
            ]
            .map(str::to_owned),
        );
    }
    if let Some(effort) = options
        .thinking_mode
        .filter(|value| *value != ThinkingMode::None)
    {
        args.extend(["--effort", effort.as_str()].map(str::to_owned));
    }
    if options.stream_json {
        if let Some(id) = options.resume_session_id.filter(|id| !id.is_empty()) {
            args.push(format!("--resume={id}"));
        } else if let Some(id) = options.session_id.filter(|id| !id.is_empty()) {
            args.push(format!("--session-id={id}"));
        }
    }
    args.extend(["-p", options.prompt.unwrap_or_default()].map(str::to_owned));
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_cases::{CaseError, replay, unknown};
    use garcon_contract::chat_modes::{coerce_thinking_mode, is_permission_mode};
    use serde_json::json;

    #[test]
    fn recorded_cli_arguments_match() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/cli-invocation"),
            |function, args| {
                if function != "buildClaudeCLIArgs" {
                    return Err(CaseError::unhandled(function));
                }
                let options = unknown(function, args.first())?;
                match build_claude_cli_args(ClaudeCliArgOptions {
                    model: options["model"].as_str(),
                    permission_mode: is_permission_mode(&options["permissionMode"]),
                    thinking_mode: coerce_thinking_mode(&options["thinkingMode"]),
                    claude_thinking_mode: None,
                    prompt: options["prompt"].as_str(),
                    session_id: options["sessionId"].as_str(),
                    resume_session_id: options["resumeSessionId"].as_str(),
                    stream_json: options["streamJson"].as_bool().unwrap_or_default(),
                }) {
                    Ok(args) => Ok(json!(args)),
                    Err(error) => Ok(
                        json!({ "$": "error", "name": "AgentIntegrationError", "message": error.message,
                    "properties": { "code": error.code.as_str(), "retryable": error.retryable } }),
                    ),
                }
            },
        );
    }
}
