use garcon_contract::chat_types::{
    CodexSubagentAction, CodexSubagentDetails, CodexSubagentInputItem, ToolUseChatMessage,
};
use garcon_js::{Number, json::as_number, trim};
use serde_json::{Value, json};

const MULTI_AGENT_V1_PREFIX: &str = "multi_agent_v1.";

pub fn convert_codex_subagent_tool_use(
    timestamp: &str,
    tool_id: &str,
    tool_name: &str,
    input: &Value,
) -> Option<ToolUseChatMessage> {
    let action = tool_name
        .strip_prefix(MULTI_AGENT_V1_PREFIX)
        .unwrap_or(tool_name);
    let action: CodexSubagentAction = serde_json::from_value(json!(action)).ok()?;
    Some(ToolUseChatMessage::CodexSubagent {
        timestamp: timestamp.into(),
        tool_id: tool_id.into(),
        action,
        details: Box::new(normalize_details(input)),
    })
}

fn normalize_details(input: &Value) -> CodexSubagentDetails {
    let get = |key: &str| &input[key];
    let alias = |first, second| {
        let first = get(first);
        if first.is_null() { get(second) } else { first }
    };
    let text = |value: &Value| value.as_str().map(str::to_owned);
    CodexSubagentDetails {
        target: text(alias("target", "id")),
        targets: get("targets").as_array().and_then(|items| {
            let items: Vec<_> = items
                .iter()
                .filter_map(Value::as_str)
                .filter(|text| !trim(text).is_empty())
                .map(str::to_owned)
                .collect();
            (!items.is_empty()).then_some(items)
        }),
        message: text(get("message")),
        task_name: text(alias("task_name", "taskName")),
        agent_type: text(alias("agent_type", "agentType")),
        model: text(get("model")),
        reasoning_effort: text(alias("reasoning_effort", "reasoningEffort")),
        service_tier: text(alias("service_tier", "serviceTier")),
        fork_context: alias("fork_context", "forkContext").as_bool(),
        fork_turns: text(alias("fork_turns", "forkTurns")),
        timeout_ms: finite_number(alias("timeout_ms", "timeoutMs")),
        path_prefix: text(alias("path_prefix", "pathPrefix")),
        interrupt: get("interrupt").as_bool(),
        items: normalize_input_items(get("items")),
        ..Default::default()
    }
}

fn normalize_input_items(value: &Value) -> Option<Vec<CodexSubagentInputItem>> {
    let source = value.as_array()?;
    let items: Vec<_> = source
        .iter()
        .filter_map(|value| {
            let field = |key: &str| value[key].as_str().map(str::to_owned);
            let item = CodexSubagentInputItem {
                input_type: field("type"),
                text: field("text"),
                image_url: field("imageUrl").or_else(|| field("image_url")),
                path: field("path"),
                name: field("name"),
            };
            (item != CodexSubagentInputItem::default()).then_some(item)
        })
        .collect();
    (source.is_empty() || !items.is_empty()).then_some(items)
}

fn finite_number(value: &Value) -> Option<Number> {
    let value = as_number(value).or_else(|| value.as_str().and_then(string_number))?;
    value.is_finite().then_some(Number(value))
}

fn string_number(text: &str) -> Option<f64> {
    let text = trim(text);
    if text.is_empty() {
        return Some(0.0);
    }
    let base = match text.as_bytes() {
        [b'0', b'x' | b'X', ..] => Some(16),
        [b'0', b'o' | b'O', ..] => Some(8),
        [b'0', b'b' | b'B', ..] => Some(2),
        _ => None,
    };
    if let Some(base) = base {
        return power_of_two_integer(&text[2..], base);
    }
    text.parse().ok()
}

fn power_of_two_integer(digits: &str, base: u32) -> Option<f64> {
    if digits.is_empty() {
        return None;
    }
    let mut significant = 0_u64;
    let mut bits = 0;
    let mut sticky = false;
    for digit in digits.chars() {
        let digit = digit.to_digit(base)?;
        for shift in (0..base.trailing_zeros()).rev() {
            let bit = u64::from((digit >> shift) & 1);
            if bits == 0 && bit == 0 {
                continue;
            }
            bits += 1;
            if bits <= 54 {
                significant = (significant << 1) | bit;
            } else {
                sticky |= bit != 0;
            }
        }
    }
    if bits <= 53 {
        return Some(significant as f64);
    }
    if bits > 1024 {
        return None;
    }
    // Rounds once to the nearest even IEEE 754 double.
    let rounded =
        (significant >> 1) + u64::from(significant & 1 == 1 && (sticky || significant & 2 == 2));
    Some(rounded as f64 * 2_f64.powi(bits - 53))
}
