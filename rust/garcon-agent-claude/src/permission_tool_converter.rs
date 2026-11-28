use garcon_interface::producer::AgentRequestedPermission;
use serde_json::{Map, Value};

use crate::tool_use_converter::convert_claude_tool_use;

pub fn convert_claude_permission_request(
    timestamp: &str,
    permission_occurrence_id: &str,
    request: &Value,
) -> AgentRequestedPermission {
    let reason = request["decision_reason"]
        .as_str()
        .map(garcon_js::trim)
        .filter(|reason| !reason.is_empty())
        .map(str::to_owned);
    let mut tool = Map::new();
    tool.insert(
        "id".into(),
        request
            .get("tool_use_id")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String(permission_occurrence_id.to_owned())),
    );
    tool.insert(
        "name".into(),
        Value::String(
            request["tool_name"]
                .as_str()
                .filter(|name| !name.is_empty())
                .unwrap_or("Unknown")
                .to_owned(),
        ),
    );
    if let Some(input) = request.get("input") {
        tool.insert("input".into(), input.clone());
    }
    AgentRequestedPermission::Requested {
        permission_occurrence_id: permission_occurrence_id.to_owned(),
        requested_tool: Box::new(convert_claude_tool_use(timestamp, &Value::Object(tool))),
        options: Vec::new(),
        reason,
    }
}
