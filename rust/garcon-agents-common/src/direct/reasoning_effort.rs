//! Ports `server-agents/common/src/direct/reasoning-effort.ts`.

use garcon_contract::chat_modes::{ThinkingMode, normalize_thinking_mode};
use serde_json::Value;

pub fn resolve_direct_explicit_effort(value: &Value) -> Option<ThinkingMode> {
    let effort = normalize_thinking_mode(value, ThinkingMode::None);
    (effort != ThinkingMode::None).then_some(effort)
}
