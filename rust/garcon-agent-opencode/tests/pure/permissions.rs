//! Ports the pure describes of `permissions.test.js`: the decision, the
//! request, the tool, and the mode mapping.

use crate::support::event;
use garcon_agent_opencode::agents::opencode::permission_tool_converter::convert_opencode_permission_tool;
use garcon_agent_opencode::agents::opencode::permissions::{
    OPENCODE_PERMISSION_KEYS, PermissionRule, extract_permission_request, map_permission_decision,
    map_permission_mode,
};
use garcon_contract::chat_types::ToolUseChatMessage;
use serde_json::json;

fn rule(permission: &'static str, action: &'static str) -> PermissionRule {
    PermissionRule {
        permission,
        pattern: "*",
        action,
    }
}

fn ask_rules() -> Vec<PermissionRule> {
    vec![
        rule("edit", "ask"),
        rule("bash", "ask"),
        rule("webfetch", "ask"),
    ]
}

#[test]
fn returns_once_for_allow_true_always_allow_false() {
    assert_eq!(
        map_permission_decision(Some(&json!({ "allow": true, "alwaysAllow": false }))),
        "once"
    );
}

#[test]
fn returns_always_for_allow_true_always_allow_true() {
    assert_eq!(
        map_permission_decision(Some(&json!({ "allow": true, "alwaysAllow": true }))),
        "always"
    );
}

#[test]
fn returns_reject_for_allow_false_always_allow_false() {
    assert_eq!(
        map_permission_decision(Some(&json!({ "allow": false, "alwaysAllow": false }))),
        "reject"
    );
}

#[test]
fn returns_reject_for_allow_false_always_allow_true() {
    assert_eq!(
        map_permission_decision(Some(&json!({ "allow": false, "alwaysAllow": true }))),
        "reject"
    );
}

#[test]
fn returns_reject_for_null_decision() {
    assert_eq!(
        map_permission_decision(Some(&serde_json::Value::Null)),
        "reject"
    );
}

#[test]
fn returns_reject_for_undefined_decision() {
    assert_eq!(map_permission_decision(None), "reject");
}

#[test]
fn coerces_truthy_allow_to_once() {
    assert_eq!(
        map_permission_decision(Some(&json!({ "allow": 1, "alwaysAllow": 0 }))),
        "once"
    );
}

#[test]
fn extracts_v2_permission_asked_event() {
    let request = extract_permission_request(&event(&json!({
        "type": "permission.asked",
        "properties": {
            "requestID": "req-abc",
            "permission": "bash",
            "patterns": ["*.sh"],
            "metadata": { "desc": "run shell" },
            "always": ["/bin/bash"],
            "tool": { "name": "bash" },
            "sessionID": "sess-1",
        },
    })))
    .expect("a permission request");

    assert_eq!(request.request_id, "req-abc");
    assert_eq!(
        serde_json::Value::Object(request.tool_input),
        json!({
            "permission": "bash",
            "patterns": ["*.sh"],
            "metadata": { "desc": "run shell" },
            "always": ["/bin/bash"],
            "tool": { "name": "bash" },
        })
    );
}

#[test]
fn falls_back_to_id_when_request_id_is_missing() {
    let request = extract_permission_request(&event(&json!({
        "type": "permission.asked",
        "properties": { "id": "fallback-id", "permission": "edit" },
    })))
    .expect("a permission request");

    assert_eq!(request.request_id, "fallback-id");
}

#[test]
fn returns_null_for_missing_request_id_and_id() {
    let request = extract_permission_request(&event(&json!({
        "type": "permission.asked",
        "properties": { "permission": "edit" },
    })));
    assert!(request.is_none());
}

#[test]
fn returns_null_for_non_permission_asked_event_type() {
    let request = extract_permission_request(&event(&json!({
        "type": "permission.updated",
        "properties": { "requestID": "req-1" },
    })));
    assert!(request.is_none());
}

#[test]
fn returns_null_for_session_created_event() {
    let request = extract_permission_request(&event(&json!({
        "type": "session.created",
        "properties": { "info": { "id": "sess-1" } },
    })));
    assert!(request.is_none());
}

#[test]
fn defaults_arrays_and_objects_when_absent() {
    let request = extract_permission_request(&event(&json!({
        "type": "permission.asked",
        "properties": { "requestID": "req-2" },
    })))
    .expect("a permission request");

    assert_eq!(request.request_id, "req-2");
    assert_eq!(
        serde_json::Value::Object(request.tool_input),
        json!({
            "permission": null,
            "patterns": [],
            "metadata": {},
            "always": [],
            "tool": null,
        })
    );
}

#[test]
fn coerces_non_array_patterns_to_empty_array() {
    let request = extract_permission_request(&event(&json!({
        "type": "permission.asked",
        "properties": { "requestID": "req-3", "patterns": "not-an-array" },
    })))
    .expect("a permission request");

    assert_eq!(request.tool_input["patterns"], json!([]));
}

#[test]
fn maps_ambient_permission_names_to_request_permissions_tool_use() {
    let message = convert_opencode_permission_tool(
        "2026-01-01T00:00:00.000Z",
        "perm-1",
        &json!({
            "permission": "bash",
            "patterns": ["*.sh"],
            "metadata": { "desc": "run shell" },
            "always": ["/bin/bash"],
            "tool": { "name": "bash" },
        }),
    );

    let ToolUseChatMessage::RequestPermissions {
        permissions,
        reason,
        ..
    } = &message
    else {
        panic!(
            "expected a request-permissions tool use, got {}",
            message.message_type()
        );
    };
    assert_eq!(reason.as_deref(), Some("Bash"));
    assert_eq!(permissions["patterns"], json!(["*.sh"]));
    assert_eq!(permissions["tool"], json!({ "name": "bash" }));
}

#[test]
fn maps_plan_enter_to_enter_plan_mode() {
    let message = convert_opencode_permission_tool(
        "2026-01-01T00:00:00.000Z",
        "perm-2",
        &json!({ "permission": "plan_enter" }),
    );

    assert!(matches!(message, ToolUseChatMessage::EnterPlanMode { .. }));
}

#[test]
fn uses_unknown_tool_use_message_only_when_permission_identity_is_missing() {
    let message =
        convert_opencode_permission_tool("2026-01-01T00:00:00.000Z", "perm-3", &json!({}));

    let ToolUseChatMessage::Unknown { raw_name, .. } = &message else {
        panic!(
            "expected an unknown tool use, got {}",
            message.message_type()
        );
    };
    assert_eq!(raw_name, "Unknown");
}

#[test]
fn maps_bypass_permissions_across_all_opencode_permission_keys() {
    let rules = map_permission_mode("bypassPermissions");
    assert_eq!(rules.len(), OPENCODE_PERMISSION_KEYS.len());
    assert_eq!(
        rules,
        OPENCODE_PERMISSION_KEYS
            .iter()
            .map(|permission| rule(
                permission,
                if matches!(*permission, "plan_enter" | "plan_exit") {
                    "deny"
                } else {
                    "allow"
                }
            ))
            .collect::<Vec<_>>()
    );
}

#[test]
fn includes_external_directory_in_bypass_permissions() {
    assert!(
        map_permission_mode("bypassPermissions").contains(&rule("external_directory", "allow"))
    );
}

#[test]
fn denies_native_plan_transitions_in_bypass_permissions() {
    let rules = map_permission_mode("bypassPermissions");
    assert!(rules.contains(&rule("plan_enter", "deny")));
    assert!(rules.contains(&rule("plan_exit", "deny")));
}

#[test]
fn emits_ask_rules_for_default_mode() {
    assert_eq!(map_permission_mode("default"), ask_rules());
}

#[test]
fn emits_default_ask_rules_for_manual_bypass_mode() {
    assert_eq!(
        map_permission_mode("manualBypass"),
        map_permission_mode("default")
    );
}

#[test]
fn falls_back_to_default_mode_for_unknown_mode() {
    assert_eq!(
        map_permission_mode("unknown-mode"),
        map_permission_mode("default")
    );
}
