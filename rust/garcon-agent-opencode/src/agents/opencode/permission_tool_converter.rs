//! Ports `server-agents/opencode/src/agents/opencode/permission-tool-converter.ts`.

use garcon_contract::chat_message_coercion::as_record;
use garcon_contract::chat_types::ToolUseChatMessage;
use garcon_js::json::Opaque;
use serde_json::{Map, Value};

use crate::js::{own, prop, strip_name_separators, truthy};

// Converts OpenCode permission.asked event payloads into canonical
// ToolUseMessage subclasses. Unlike tool-use events, permission events
// carry minimal structured input, so generic permission requests preserve
// the provider permission context instead of pretending a concrete tool ran.

fn canonical_name_for_permission(raw_name: &str) -> String {
    match strip_name_separators(raw_name).as_str() {
        "bash" | "shellcommand" | "execcommand" => "Bash".to_owned(),
        "read" => "Read".to_owned(),
        "edit" => "Edit".to_owned(),
        "write" => "Write".to_owned(),
        "applypatch" => "ApplyPatch".to_owned(),
        "grep" => "Grep".to_owned(),
        "glob" => "Glob".to_owned(),
        "websearch" => "WebSearch".to_owned(),
        "webfetch" => "WebFetch".to_owned(),
        "todowrite" => "TodoWrite".to_owned(),
        "todoread" => "TodoRead".to_owned(),
        "task" => "Task".to_owned(),
        "updateplan" => "UpdatePlan".to_owned(),
        "writestdin" => "WriteStdin".to_owned(),
        "enterplanmode" | "planenter" => "EnterPlanMode".to_owned(),
        "exitplanmode" | "exitplan" | "planexit" => "ExitPlanMode".to_owned(),
        "list" => "List".to_owned(),
        "skill" => "Skill".to_owned(),
        "lsp" => "Lsp".to_owned(),
        "codesearch" => "CodeSearch".to_owned(),
        "externaldirectory" => "ExternalDirectory".to_owned(),
        "doomloop" => "DoomLoop".to_owned(),
        "question" => "Question".to_owned(),
        _ => {
            let trimmed = garcon_js::trim(raw_name);
            if trimmed.is_empty() {
                "Unknown".to_owned()
            } else {
                raw_name.to_owned()
            }
        }
    }
}

// OpenCode permission events carry a permission key and metadata rather than
// full tool input, so ambient approvals map to RequestPermissionsToolUseMessage.
pub fn convert_opencode_permission_tool(
    ts: &str,
    tool_id: &str,
    permission: &Value,
) -> ToolUseChatMessage {
    let provider_permission = as_record(permission);
    let tool = prop(provider_permission, "tool");
    // An array is an object to `typeof`, and `asObject` then gives an empty one.
    let provider_tool = (tool.is_object() || tool.is_array()).then(|| as_record(tool));
    let raw_name = match prop(provider_permission, "permission").as_str() {
        Some(permission) => permission,
        None => provider_tool
            .and_then(|tool| prop(tool, "name").as_str())
            .unwrap_or("Unknown"),
    };
    let canonical_name = canonical_name_for_permission(raw_name);
    let array_or_empty = |key: &str| {
        prop(provider_permission, key)
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let or_null = |key: &str| match own(provider_permission, key) {
        Some(value) if !value.is_null() => value.clone(),
        _ => Value::Null,
    };
    let permission_context = Map::from_iter([
        ("permission".to_owned(), or_null("permission")),
        (
            "patterns".to_owned(),
            Value::Array(array_or_empty("patterns")),
        ),
        (
            "metadata".to_owned(),
            match or_null("metadata") {
                Value::Null => Value::Object(Map::new()),
                metadata => metadata,
            },
        ),
        ("always".to_owned(), Value::Array(array_or_empty("always"))),
        ("tool".to_owned(), or_null("tool")),
    ]);

    match canonical_name.as_str() {
        "TodoRead" => ToolUseChatMessage::TodoRead {
            timestamp: ts.to_owned(),
            tool_id: tool_id.to_owned(),
        },
        "EnterPlanMode" => ToolUseChatMessage::EnterPlanMode {
            timestamp: ts.to_owned(),
            tool_id: tool_id.to_owned(),
        },
        _ => {
            if canonical_name == "Unknown"
                && !truthy(prop(provider_permission, "permission"))
                && provider_tool.is_none_or(|tool| !truthy(prop(tool, "name")))
            {
                return ToolUseChatMessage::Unknown {
                    timestamp: ts.to_owned(),
                    tool_id: tool_id.to_owned(),
                    raw_name: canonical_name,
                    input: Opaque::from_value(Value::Object(permission_context)),
                };
            }
            ToolUseChatMessage::RequestPermissions {
                timestamp: ts.to_owned(),
                tool_id: tool_id.to_owned(),
                permissions: Opaque::from_value(Value::Object(permission_context)),
                reason: Some(canonical_name),
            }
        }
    }
}
