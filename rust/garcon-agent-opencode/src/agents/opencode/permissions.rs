//! Ports `server-agents/opencode/src/agents/opencode/permissions.ts`.

use serde_json::{Map, Value};

use super::sse_events::SseEvent;
use crate::js::{own, prop, string_of, truthy};

// Source of OpenCode permission keys:
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/web/src/content/docs/permissions.mdx
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/opencode/src/agent/agent.ts
pub const OPENCODE_PERMISSION_KEYS: &[&str] = &[
    "read",
    "edit",
    "glob",
    "grep",
    "list",
    "bash",
    "task",
    "skill",
    "lsp",
    "todoread",
    "todowrite",
    "webfetch",
    "websearch",
    "codesearch",
    "external_directory",
    "doom_loop",
    "question",
    "plan_enter",
    "plan_exit",
];

const OPENCODE_NATIVE_PLAN_PERMISSIONS: &[&str] = &["plan_enter", "plan_exit"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRule {
    pub permission: &'static str,
    pub pattern: &'static str,
    pub action: &'static str,
}

// Native plan transitions create unmarked synthetic continuations that cannot be safely
// affiliated with an operation, so bypass mode keeps them unavailable. The original reads
// its mode table with the caller's key, so a key such as "constructor" finds an inherited
// member and yields no rules; here every other mode takes the path of the default.
pub fn map_permission_mode(mode: &str) -> Vec<PermissionRule> {
    let rule = |permission: &'static str, action: &'static str| PermissionRule {
        permission,
        pattern: "*",
        action,
    };
    match mode {
        "acceptEdits" => vec![
            rule("edit", "allow"),
            rule("bash", "ask"),
            rule("webfetch", "allow"),
        ],
        "bypassPermissions" => OPENCODE_PERMISSION_KEYS
            .iter()
            .map(|permission| {
                rule(
                    permission,
                    if OPENCODE_NATIVE_PLAN_PERMISSIONS.contains(permission) {
                        "deny"
                    } else {
                        "allow"
                    },
                )
            })
            .collect(),
        _ => vec![
            rule("edit", "ask"),
            rule("bash", "ask"),
            rule("webfetch", "ask"),
        ],
    }
}

/// `allow ? (alwaysAllow ? "always" : "once") : "reject"` over the two flags
/// as the original reads them, by truthiness.
pub fn map_permission_decision(decision: Option<&Value>) -> &'static str {
    let allow = decision.is_some_and(|decision| truthy(prop(decision, "allow")));
    let always_allow = decision.is_some_and(|decision| truthy(prop(decision, "alwaysAllow")));
    match (allow, always_allow) {
        (true, true) => "always",
        (true, false) => "once",
        (false, _) => "reject",
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OpenCodePermissionRequest {
    pub request_id: String,
    pub tool_input: Map<String, Value>,
}

pub fn extract_permission_request(event: &SseEvent) -> Option<OpenCodePermissionRequest> {
    if event.kind != "permission.asked" {
        return None;
    }
    let props = &event.properties;
    let request_id = [prop(props, "requestID"), prop(props, "id")]
        .into_iter()
        .find(|value| truthy(value))?;
    let or_value = |key: &str| own(props, key).filter(|value| truthy(value)).cloned();
    let or_null = |key: &str| or_value(key).unwrap_or(Value::Null);
    let or_empty_object = |key: &str| or_value(key).unwrap_or_else(|| Value::Object(Map::new()));
    let array_or_empty = |key: &str| prop(props, key).as_array().cloned().unwrap_or_default();
    Some(OpenCodePermissionRequest {
        request_id: string_of(Some(request_id)).into_owned(),
        tool_input: Map::from_iter([
            ("permission".to_owned(), or_null("permission")),
            (
                "patterns".to_owned(),
                Value::Array(array_or_empty("patterns")),
            ),
            ("metadata".to_owned(), or_empty_object("metadata")),
            ("always".to_owned(), Value::Array(array_or_empty("always"))),
            ("tool".to_owned(), or_null("tool")),
        ]),
    })
}
