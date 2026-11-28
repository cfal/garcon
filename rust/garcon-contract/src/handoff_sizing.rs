//! Ports common/handoff-sizing.ts.

use garcon_js::is_safe_integer;
use serde_json::Value;

pub type AgentSwitchContextWindowTokens = u32;

pub const AGENT_SWITCH_CONTEXT_WINDOW_TOKEN_CHOICES: [AgentSwitchContextWindowTokens; 3] =
    [200_000, 500_000, 1_000_000];
pub const DEFAULT_HANDOFF_CONTEXT_WINDOW_TOKENS: AgentSwitchContextWindowTokens = 500_000;
pub const HANDOFF_CONTEXT_WINDOW_MIN_TOKENS: u32 = 1_024;
pub const HANDOFF_CONTEXT_WINDOW_MAX_TOKENS: u32 = 10_000_000;
pub const SMALL_HISTORY_NO_COMPACTION_MAX_ESTIMATED_TOKENS: u32 = 100_000;

pub fn usable_handoff_token_budget(context_window_tokens: f64) -> f64 {
    (context_window_tokens * 3.0 / 4.0).floor()
}

pub fn parse_agent_switch_context_window_tokens(
    value: &Value,
) -> Option<AgentSwitchContextWindowTokens> {
    let number = value.as_f64()?;
    AGENT_SWITCH_CONTEXT_WINDOW_TOKEN_CHOICES
        .into_iter()
        .find(|&preset| f64::from(preset) == number)
}

pub fn is_handoff_context_window_tokens(value: &Value) -> bool {
    value.as_f64().is_some_and(|number| {
        is_safe_integer(number)
            && (f64::from(HANDOFF_CONTEXT_WINDOW_MIN_TOKENS)
                ..=f64::from(HANDOFF_CONTEXT_WINDOW_MAX_TOKENS))
                .contains(&number)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_only_the_three_agent_switch_presets() {
        for choice in AGENT_SWITCH_CONTEXT_WINDOW_TOKEN_CHOICES {
            assert_eq!(
                parse_agent_switch_context_window_tokens(&json!(choice)),
                Some(choice)
            );
        }
        for invalid in [
            json!("500000"),
            json!(500_000.5),
            json!(300_000),
            Value::Null,
        ] {
            assert_eq!(parse_agent_switch_context_window_tokens(&invalid), None);
        }
    }

    #[test]
    fn accepts_arbitrary_safe_context_windows_inside_the_public_bounds() {
        for tokens in [1_024, 131_072, 500_000, 10_000_000] {
            assert!(is_handoff_context_window_tokens(&json!(tokens)));
        }
        for invalid in [
            json!(1_023),
            json!(10_000_001),
            json!(500_000.5),
            json!(9_007_199_254_740_992_u64),
            json!("500000"),
            Value::Null,
        ] {
            assert!(!is_handoff_context_window_tokens(&invalid));
        }
    }

    #[test]
    fn reserves_exactly_one_quarter_of_each_preset() {
        assert_eq!(usable_handoff_token_budget(200_000.0), 150_000.0);
        assert_eq!(usable_handoff_token_budget(500_000.0), 375_000.0);
        assert_eq!(usable_handoff_token_budget(1_000_000.0), 750_000.0);
    }
}
