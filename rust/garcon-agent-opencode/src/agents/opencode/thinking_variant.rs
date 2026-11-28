//! Ports `server-agents/opencode/src/agents/opencode/thinking-variant.ts`.

use garcon_contract::chat_modes::ThinkingMode;
use serde_json::Value;

// OpenCode model variants carry provider-specific reasoning controls behind
// effort-like names; the server silently ignores names the model does not
// declare, so selection must be resolved against the declared set here.
// https://github.com/anomalyco/opencode/blob/18b4cb6819d7de0b37927fef60d03927e678c9dd/packages/opencode/src/session/llm/request.ts#L80-L91
const THINKING_MODE_ORDER: &[ThinkingMode] = &[
    ThinkingMode::Low,
    ThinkingMode::Medium,
    ThinkingMode::High,
    ThinkingMode::Xhigh,
    ThinkingMode::Max,
];

fn ladder_position(mode: &str) -> Option<usize> {
    THINKING_MODE_ORDER
        .iter()
        .position(|candidate| candidate.as_str() == mode)
}

// Reads the model's declared variant names, keeping only Garcon thinking
// vocabulary. Unrecognized keys (for example "thinking") stay invisible.
pub fn thinking_modes_from_variants(variants: &Value) -> Option<Vec<ThinkingMode>> {
    let variants = variants.as_object()?;
    let modes: Vec<&str> = variants
        .keys()
        .map(String::as_str)
        .filter(|key| *key == "none" || ladder_position(key).is_some())
        .collect();
    if modes.is_empty() {
        return None;
    }
    let mut recognized = Vec::with_capacity(modes.len());
    if modes.contains(&"none") {
        recognized.push(ThinkingMode::None);
    }
    recognized.extend(
        THINKING_MODE_ORDER
            .iter()
            .copied()
            .filter(|mode| modes.contains(&mode.as_str())),
    );
    Some(recognized)
}

/// The variant a turn submits for `thinking_mode`: the model's declared ladder
/// decides, and an unknown declared set passes the mode through.
pub fn resolve_open_code_thinking_variant(
    thinking_mode: Option<&str>,
    declared_modes: Option<&[String]>,
) -> Option<String> {
    let thinking_mode = thinking_mode.filter(|mode| !mode.is_empty())?;
    let declared = |mode: &str| {
        declared_modes.is_some_and(|modes| modes.iter().any(|declared| declared == mode))
    };
    if thinking_mode == "none" {
        // A literal none variant disables reasoning where the model offers it;
        // otherwise the provider default already applies without a variant.
        return declared("none").then(|| "none".to_owned());
    }
    if thinking_mode == "ultra" {
        // No OpenCode variant maps to ultra; the closest ceiling below it applies.
        return match declared_modes {
            Some(modes) => highest_declared_below("ultra", modes),
            None => Some("max".to_owned()),
        };
    }
    let Some(modes) = declared_modes else {
        return Some(thinking_mode.to_owned());
    };
    if declared(thinking_mode) {
        return Some(thinking_mode.to_owned());
    }
    // Requests above the model's declared ceiling step down to the highest
    // declared mode, mirroring the Codex max-to-xhigh downgrade contract.
    highest_declared_below(thinking_mode, modes)
}

fn highest_declared_below(ceiling: &str, declared_modes: &[String]) -> Option<String> {
    // A ceiling outside the ladder, such as a mode the ladder does not name, has no mode below it.
    let ceiling_index = if ceiling == "ultra" {
        THINKING_MODE_ORDER.len()
    } else {
        ladder_position(ceiling)?
    };
    THINKING_MODE_ORDER[..ceiling_index]
        .iter()
        .rev()
        .map(|mode| mode.as_str())
        .find(|candidate| declared_modes.iter().any(|declared| declared == candidate))
        .map(str::to_owned)
}
