//! Ports `thinking-variant.test.js`.

use garcon_agent_opencode::agents::opencode::thinking_variant::{
    resolve_open_code_thinking_variant, thinking_modes_from_variants,
};
use garcon_contract::chat_modes::ThinkingMode::{High, Medium, None as NoThinking, Xhigh};
use serde_json::json;

fn declared(modes: &[&str]) -> Option<Vec<String>> {
    Some(modes.iter().map(|mode| (*mode).to_owned()).collect())
}

fn resolve(mode: Option<&str>, declared_modes: Option<Vec<String>>) -> Option<String> {
    resolve_open_code_thinking_variant(mode, declared_modes.as_deref())
}

#[test]
fn keeps_recognized_effort_names_in_ladder_order() {
    assert_eq!(
        thinking_modes_from_variants(
            &json!({"high": {}, "medium": {}, "thinking": {}, "xhigh": {}})
        ),
        Some(vec![Medium, High, Xhigh])
    );
}

#[test]
fn keeps_a_literal_none_variant_ahead_of_ladder_modes() {
    assert_eq!(
        thinking_modes_from_variants(&json!({"none": {}, "high": {}})),
        Some(vec![NoThinking, High])
    );
}

#[test]
fn returns_undefined_without_recognized_names() {
    assert_eq!(thinking_modes_from_variants(&json!({"thinking": {}})), None);
    assert_eq!(thinking_modes_from_variants(&json!("nope")), None);
}

#[test]
fn omits_a_variant_for_the_default_none_mode_unless_the_model_declares_none() {
    assert_eq!(
        resolve(Some("none"), declared(&["none", "high"])),
        Some("none".to_owned())
    );
    assert_eq!(resolve(Some("none"), declared(&["low", "high"])), None);
    assert_eq!(resolve(Some("none"), None), None);
    assert_eq!(resolve(None, declared(&["high"])), None);
}

#[test]
fn passes_an_exact_declared_mode_through() {
    assert_eq!(
        resolve(Some("high"), declared(&["low", "high"])),
        Some("high".to_owned())
    );
}

#[test]
fn passes_the_mode_through_when_the_declared_set_is_unknown() {
    assert_eq!(resolve(Some("xhigh"), None), Some("xhigh".to_owned()));
}

#[test]
fn steps_a_request_above_the_declared_ceiling_down_to_the_highest_declared_mode() {
    assert_eq!(
        resolve(Some("max"), declared(&["low", "medium", "high"])),
        Some("high".to_owned())
    );
    assert_eq!(
        resolve(Some("xhigh"), declared(&["low", "medium"])),
        Some("medium".to_owned())
    );
    assert_eq!(
        resolve(Some("ultra"), declared(&["low", "high", "max"])),
        Some("max".to_owned())
    );
    assert_eq!(resolve(Some("ultra"), None), Some("max".to_owned()));
}

#[test]
fn omits_a_variant_when_the_model_declares_no_ladder_modes() {
    assert_eq!(resolve(Some("high"), declared(&["none"])), None);
}
