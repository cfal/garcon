//! Ports `server-agents/pi/src/agents/pi/pi-cli.ts`.

use std::process::Stdio;

use garcon_agents_common::shared::{
    single_query_control::{SingleQueryControlOptions, with_single_query_control},
    single_query_input::capture_single_query_input_failure,
};
use garcon_contract::chat_modes::{
    DEFAULT_THINKING_MODE, PermissionMode, ThinkingMode, normalize_thinking_mode,
};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::{trim, utf16};
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::config::PiConfig;
use crate::pi_process_lifecycle::exit_code;
use crate::pi_rpc_protocol::PiThinkingLevel;

pub const PI_READ_ONLY_TOOLS: [&str; 4] = ["read", "grep", "find", "ls"];

pub const PI_PLAN_PREFIX: &str = concat!(
    "You are operating in Garcon plan mode.\n",
    "Do not modify files, run mutating commands, or carry out implementation.\n",
    "Analyze the task, inspect the codebase, and respond with a concrete implementation plan only.",
);

const PI_NESTED_SESSION_ENV: [&str; 5] = [
    "PI_CODING_AGENT",
    "PI_PROVIDER",
    "PI_MODEL",
    "PI_REASONING_LEVEL",
    "PI_CODING_AGENT_SESSION_DIR",
];

pub fn map_thinking_mode(mode: Option<ThinkingMode>) -> Option<PiThinkingLevel> {
    Some(match mode? {
        ThinkingMode::None => PiThinkingLevel::Off,
        ThinkingMode::Low => PiThinkingLevel::Low,
        ThinkingMode::Medium => PiThinkingLevel::Medium,
        ThinkingMode::High => PiThinkingLevel::High,
        // Keeps Garcon's xhigh ceiling even when the resolved model supports max.
        ThinkingMode::Xhigh | ThinkingMode::Max | ThinkingMode::Ultra => PiThinkingLevel::Xhigh,
    })
}

#[derive(Debug, thiserror::Error)]
#[error("Pi requires an explicit model selection.")]
pub struct MissingPiModel;

pub fn require_explicit_pi_model(model: &Value) -> Result<&str, MissingPiModel> {
    let model = trim(model.as_str().unwrap_or_default());
    if model.is_empty() || model == "default" {
        return Err(MissingPiModel);
    }
    Ok(model)
}

pub fn build_pi_prompt(command: &str, permission_mode: PermissionMode, has_images: bool) -> String {
    let command = trim(command);
    let prompt = if command.is_empty() && has_images {
        "Please inspect the attached image."
    } else {
        command
    };
    if permission_mode == PermissionMode::Plan {
        return format!("{PI_PLAN_PREFIX}\n\n{prompt}");
    }
    prompt.to_owned()
}

pub fn build_pi_cli_env(overrides: Option<&IndexMap<String, String>>) -> IndexMap<String, String> {
    let mut env: IndexMap<_, _> = std::env::vars_os()
        .map(|(key, value)| {
            (
                key.to_string_lossy().into_owned(),
                value.to_string_lossy().into_owned(),
            )
        })
        .collect();
    if let Some(overrides) = overrides {
        env.extend(overrides.clone());
    }
    // Nested session metadata can redirect the child to the outer session's files.
    env.retain(|key, _| {
        !PI_NESTED_SESSION_ENV.contains(&key.as_str()) && !key.starts_with("PI_SESSION_")
    });
    env.insert("PI_OFFLINE".to_owned(), "1".to_owned());
    env.insert("PI_SKIP_VERSION_CHECK".to_owned(), "1".to_owned());
    env.insert("PI_TELEMETRY".to_owned(), "0".to_owned());
    env
}

pub fn build_pi_rpc_spawn_command(
    config: &PiConfig,
    model: &str,
    thinking: Option<PiThinkingLevel>,
    permission_mode: PermissionMode,
    resume_path: Option<&str>,
) -> ExecutorResult<Vec<String>> {
    let mut args = ["--mode", "rpc", "--model", model]
        .map(str::to_owned)
        .to_vec();
    if let Some(thinking) = thinking {
        args.extend(["--thinking".to_owned(), thinking.as_str().to_owned()]);
    }
    if permission_mode == PermissionMode::Plan {
        args.extend(["--tools".to_owned(), PI_READ_ONLY_TOOLS.join(",")]);
    }
    if let Some(dir) = config.session_directory_override()? {
        args.extend(["--session-dir".to_owned(), dir]);
    }
    if let Some(path) = resume_path.filter(|path| !path.is_empty()) {
        args.extend(["--session".to_owned(), path.to_owned()]);
    }
    args.insert(0, config.binary()?);
    Ok(args)
}

pub async fn pipe_pi_stderr(
    logger: &dyn AgentLogger,
    session_id: &str,
    stderr: impl AsyncRead + Unpin,
) {
    let mut lines = BufReader::new(stderr);
    let mut bytes = Vec::new();
    let mut first = true;
    loop {
        bytes.clear();
        match lines.read_until(b'\n', &mut bytes).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&bytes);
        let line = if std::mem::take(&mut first) {
            line.strip_prefix('\u{feff}').unwrap_or(&line)
        } else {
            &line
        };
        let line = line.strip_suffix('\n').unwrap_or(line);
        if !trim(line).is_empty() {
            logger.info(
                "Pi stderr output",
                Some(&IndexMap::from_iter([
                    ("sessionId".to_owned(), json!(session_id).into()),
                    ("lineLength".to_owned(), json!(utf16::len(line)).into()),
                ])),
            );
        }
    }
}

async fn run_pi_command(
    args: &[&str],
    config: &PiConfig,
    cwd: Option<&str>,
    input: Option<&str>,
) -> ExecutorResult<String> {
    let mut command = Command::new(config.binary()?);
    command
        .args(args)
        .env_clear()
        .envs(build_pi_cli_env(None))
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) {
        command.current_dir(cwd);
    }
    let mut process = command.spawn()?;
    let mut stdin = process.stdin.take();
    let write =
        async move { capture_single_query_input_failure(stdin.as_mut(), input, "Pi").await };
    let (output, input_failure) = tokio::join!(process.wait_with_output(), write);
    let output = output?;
    let code = exit_code(output.status);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stdout = stdout.strip_prefix('\u{feff}').unwrap_or(&stdout);
    if code != 0 {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.strip_prefix('\u{feff}').unwrap_or(&stderr);
        let details = trim(if stderr.is_empty() { stdout } else { stderr });
        return Err(if details.is_empty() {
            format!("Pi command failed with code {code}")
        } else {
            format!("Pi command failed with code {code}: {details}")
        }
        .into());
    }
    if let Some(error) = input_failure {
        return Err(error);
    }
    Ok(stdout.to_owned())
}

pub async fn run_single_query(
    prompt: &str,
    options: &Value,
    signal: Option<CancellationToken>,
    config: &PiConfig,
) -> ExecutorResult<String> {
    let model = require_explicit_pi_model(&options["model"])?;
    let cwd = options["cwd"]
        .as_str()
        .or_else(|| options["projectPath"].as_str());
    let mut args = vec![
        "--mode",
        "text",
        "--no-session",
        "--no-tools",
        "--model",
        model,
    ];
    if let Some(thinking) = map_thinking_mode(Some(normalize_thinking_mode(
        &options["thinkingMode"],
        DEFAULT_THINKING_MODE,
    ))) {
        args.extend(["--thinking", thinking.as_str()]);
    }
    with_single_query_control(
        SingleQueryControlOptions {
            signal,
            timeout_ms: options.get("timeoutMs"),
        },
        |_| async { Ok(trim(&run_pi_command(&args, config, cwd, Some(prompt)).await?).to_owned()) },
    )
    .await
}
