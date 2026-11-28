use std::{ffi::OsString, path::PathBuf, rc::Rc};

use garcon_agents_common::execution::permission_modes::provider_startup_permission_mode;
use garcon_agents_common::shared::single_query_control::{
    SingleQueryControlOptions, with_single_query_control,
};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use indexmap::IndexMap;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::{
    cli_version::ClaudeCliVersionProbe,
    single_query_process::{ClaudeSingleQueryProcessOptions, run_claude_single_query_process},
};
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

#[derive(Default)]
pub struct ClaudeSingleQueryOptions<'a> {
    pub model: Option<String>,
    pub cwd: Option<PathBuf>,
    pub permission_mode: Option<PermissionMode>,
    pub thinking_mode: Option<ThinkingMode>,
    pub claude_thinking_mode: Option<ClaudeThinkingMode>,
    pub env_overrides: IndexMap<OsString, OsString>,
    pub timeout_ms: Option<&'a Value>,
    pub signal: Option<CancellationToken>,
}

pub async fn run_single_query(
    prompt: String,
    options: ClaudeSingleQueryOptions<'_>,
    executable: Rc<dyn Fn() -> ExecutorResult<OsString>>,
    logger: Rc<dyn AgentLogger>,
    version_probe: Rc<ClaudeCliVersionProbe>,
) -> ExecutorResult<String> {
    with_single_query_control(
        SingleQueryControlOptions {
            signal: options.signal,
            timeout_ms: options.timeout_ms,
        },
        |signal| async move {
            let binary = executable()?;
            version_probe.assert_compatible(&binary).await?;
            let args = build_claude_cli_args(ClaudeCliArgOptions {
                model: options.model.as_deref(),
                permission_mode: options.permission_mode,
                thinking_mode: options.thinking_mode,
                claude_thinking_mode: options.claude_thinking_mode,
                prompt: Some(&prompt),
                ..Default::default()
            })?;
            let cwd = match options.cwd.filter(|path| !path.as_os_str().is_empty()) {
                Some(path) => path,
                None => std::env::current_dir()?,
            };
            // The caller may stop waiting on timeout, but the process still owns teardown.
            let _cancel_on_drop = signal.clone().drop_guard();
            tokio::task::spawn_local(async move {
                run_claude_single_query_process(ClaudeSingleQueryProcessOptions {
                    binary,
                    args: args.into_iter().map(OsString::from).collect(),
                    model: options.model.as_deref(),
                    cwd,
                    env_overrides: options.env_overrides,
                    signal: &signal,
                    logger: logger.as_ref(),
                })
                .await
            })
            .await?
        },
    )
    .await
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

    #[cfg(unix)]
    #[tokio::test]
    async fn single_query_matches_the_original_binary_arguments_environment_and_output() {
        use std::os::unix::fs::PermissionsExt;

        use garcon_agents_common::direct::conformance_host::conformance_host;
        use tokio::{fs, process::Command, task::LocalSet};

        LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let executable = root.path().join("fake-claude-query");
            fs::write(&executable, r#"#!/bin/sh
if [ "$1" = --version ]; then
  printf '%s\n' '2.1.238 (Claude Code)'
  exit 0
fi
[ "$GARCON_SYNTHETIC_QUERY" = expected ] || exit 2
[ "$*" = '--print --no-session-persistence --model haiku --permission-mode default --effort high -p synthetic prompt' ] || exit 3
printf ' synthetic answer \n'
"#).await.unwrap();
            fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).await.unwrap();
            let host = conformance_host("claude", root.path()).unwrap();
            let actual = run_single_query(
                "synthetic prompt".into(),
                ClaudeSingleQueryOptions {
                    model: Some("haiku".into()),
                    cwd: Some(root.path().to_owned()),
                    thinking_mode: Some(ThinkingMode::High),
                    env_overrides: IndexMap::from([("GARCON_SYNTHETIC_QUERY".into(), "expected".into())]),
                    timeout_ms: Some(&json!(3_000)),
                    ..Default::default()
                },
                Rc::new({
                    let executable = executable.clone();
                    move || Ok(executable.clone().into_os_string())
                }),
                host.logger,
                Rc::new(ClaudeCliVersionProbe::default()),
            ).await.unwrap();
            let original = Command::new("bun")
                .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/oracles/single-query.ts"))
                .arg(executable)
                .arg(root.path())
                .output().await.unwrap();
            assert!(original.status.success(), "{}", String::from_utf8_lossy(&original.stderr));
            assert_eq!(actual.as_bytes(), original.stdout);
            assert_eq!(actual, " synthetic answer \n");
        }).await;
    }
}
