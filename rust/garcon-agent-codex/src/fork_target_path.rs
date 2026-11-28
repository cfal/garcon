use garcon_agents_common::forking::fork_jsonl::ForkJsonlTargetPathInput;
use garcon_base::errors::NamedError;
use garcon_interface::resources::ExecutorResult;
use garcon_js::{path::native as path, to_iso_string};

pub fn create_codex_fork_target_path(input: ForkJsonlTargetPathInput) -> ExecutorResult<String> {
    let timestamp = to_iso_string(input.created_at_ms).map_err(|_| NamedError {
        name: "TypeError".into(),
        message: "Codex fork creation time must be a valid date".into(),
        code: None,
    })?;
    let timestamp = timestamp[..19].replace(':', "-");
    Ok(path::join(&[
        &path::dirname(&input.source_path),
        &format!(
            "rollout-{timestamp}-{}.jsonl",
            input.target_agent_session_id
        ),
    ]))
}
