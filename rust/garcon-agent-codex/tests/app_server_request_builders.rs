use garcon_agent_codex::app_server::request_builders::{
    build_codex_env, build_thread_fork_params, build_thread_resume_params,
    build_thread_settings_update_params, build_thread_start_params, build_turn_start_params,
    build_user_input, codex_sandbox_settings, codex_source_runtime_identity,
    codex_thread_settings_target, map_thinking_mode_to_codex_effort, parse_leading_slash_command,
    thread_settings_match, thread_settings_target_from_snapshot,
};
use garcon_cases::{CaseError, replay, round_tripped, text, unknown};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

fn from_arg<T: DeserializeOwned>(
    function: &str,
    args: &[Value],
    index: usize,
) -> Result<T, CaseError> {
    Ok(serde_json::from_value(unknown(function, args.get(index))?.into_owned()).unwrap())
}

fn optional_arg<T: DeserializeOwned>(
    function: &str,
    args: &[Value],
    index: usize,
) -> Result<Option<T>, CaseError> {
    Ok(round_tripped(function, args.get(index))?
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value(value.into_owned()).unwrap()))
}

#[test]
fn codex_app_server_request_builders_match_recorded_cases() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/app-server-request-builders"
        ),
        |function, args| {
            let text_at = |index| text(function, args.get(index));
            Ok(match function {
                "parseLeadingSlashCommand" => {
                    json!(parse_leading_slash_command(text_at(0)?.unwrap()))
                }
                "buildUserInput" => {
                    let command = text_at(0)?.unwrap();
                    let image_paths: Option<Vec<String>> = optional_arg(function, args, 1)?;
                    let skills: Option<Vec<_>> = optional_arg(function, args, 2)?;
                    json!(build_user_input(
                        command,
                        image_paths.as_deref().unwrap_or_default(),
                        skills.as_deref().unwrap_or_default(),
                    ))
                }
                "codexSandboxSettings" => {
                    json!(codex_sandbox_settings(from_arg(function, args, 0)?))
                }
                "mapThinkingModeToCodexEffort" => {
                    match map_thinking_mode_to_codex_effort(
                        optional_arg(function, args, 0)?,
                        text_at(1)?,
                    ) {
                        Some(effort) => json!(effort),
                        None => json!({"$":"undefined"}),
                    }
                }
                "buildCodexEnv" => {
                    match build_codex_env(
                        optional_arg(function, args, 0)?.as_ref(),
                        optional_arg(function, args, 1)?.as_ref(),
                    ) {
                        Some(env) => json!(env),
                        None => json!({"$":"undefined"}),
                    }
                }
                "codexSourceRuntimeIdentity" => {
                    let request = unknown(function, args.first())?;
                    let env = serde_json::from_value(request["envOverrides"].clone()).unwrap();
                    let config = serde_json::from_value(request["codexConfig"].clone()).unwrap();
                    json!(codex_source_runtime_identity(
                        Option::as_ref(&env),
                        Option::as_ref(&config)
                    ))
                }
                "codexThreadSettingsTarget" => {
                    json!(codex_thread_settings_target(&from_arg(function, args, 0)?))
                }
                "buildThreadSettingsUpdateParams" => {
                    json!(build_thread_settings_update_params(
                        text_at(0)?.unwrap(),
                        &from_arg(function, args, 1)?,
                    ))
                }
                "threadSettingsTargetFromSnapshot" => {
                    json!(thread_settings_target_from_snapshot(
                        &from_arg(function, args, 0)?,
                        from_arg(function, args, 1)?,
                    ))
                }
                "threadSettingsMatch" => {
                    json!(thread_settings_match(
                        &from_arg(function, args, 0)?,
                        &from_arg(function, args, 1)?,
                    ))
                }
                "buildThreadStartParams" => {
                    json!(build_thread_start_params(&from_arg(function, args, 0)?))
                }
                "buildThreadResumeParams" => {
                    let request = unknown(function, args.first())?;
                    json!(build_thread_resume_params(
                        &from_arg(function, args, 0)?,
                        request["agentSessionId"].as_str().unwrap(),
                        request["nativePath"].as_str(),
                    ))
                }
                "buildThreadForkParams" => {
                    json!(build_thread_fork_params(&from_arg(function, args, 0)?))
                }
                "buildTurnStartParams" => {
                    json!(build_turn_start_params(&from_arg(function, args, 0)?))
                }
                _ => return Err(CaseError::unhandled(function)),
            })
        },
    );
}
