use garcon_contract::chat_modes::{ClaudeThinkingMode, PermissionMode, ThinkingMode};
use indexmap::IndexMap;

#[derive(Clone)]
pub struct ClaudeSessionOptions {
    pub agent_session_id: String,
    pub session_id: String,
    pub chat_id: String,
    pub project_path: String,
    pub model: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub claude_thinking_mode: Option<ClaudeThinkingMode>,
    pub env_overrides: Option<IndexMap<String, String>>,
}

pub fn merge_claude_session_options(
    current: &ClaudeSessionOptions,
    mut next: ClaudeSessionOptions,
) -> ClaudeSessionOptions {
    next.claude_thinking_mode = next.claude_thinking_mode.or(current.claude_thinking_mode);
    if next.env_overrides.is_none() {
        next.env_overrides.clone_from(&current.env_overrides);
    }
    next
}

pub fn normalize_claude_thinking_mode_for_state(
    claude_thinking_mode: Option<ClaudeThinkingMode>,
) -> ClaudeThinkingMode {
    claude_thinking_mode.unwrap_or(ClaudeThinkingMode::Auto)
}
