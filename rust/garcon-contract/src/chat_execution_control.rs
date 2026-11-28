//! Ports common/chat-execution-control.ts.

use garcon_js::{trim, utf16};
use serde::Serialize;
use serde_json::Value;

use crate::queue_state::{
    ChatQueueState, canonical_iso_timestamp, empty_chat_queue_state, parse_chat_queue_state,
};
use crate::ws_value_parsing::non_negative_int;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatExecutionControlState {
    pub server_instance_id: String,
    pub queue: ChatQueueState,
    pub version: u64,
    pub updated_at: Option<String>,
}

pub const MAX_CHAT_EXECUTION_CONTROL_SERVER_INSTANCE_ID_LENGTH: usize = 128;

pub fn parse_execution_control_server_instance_id(value: &Value) -> Option<&str> {
    let value = value.as_str()?;
    if value.is_empty() || utf16::len(value) > MAX_CHAT_EXECUTION_CONTROL_SERVER_INSTANCE_ID_LENGTH
    {
        return None;
    }
    (trim(value) == value).then_some(value)
}

pub fn empty_chat_execution_control_state(server_instance_id: &str) -> ChatExecutionControlState {
    ChatExecutionControlState {
        server_instance_id: server_instance_id.to_owned(),
        queue: empty_chat_queue_state(),
        version: 0,
        updated_at: None,
    }
}

pub fn parse_chat_execution_control_state(value: &Value) -> Option<ChatExecutionControlState> {
    let raw = value.as_object()?;
    let server_instance_id =
        parse_execution_control_server_instance_id(raw.get("serverInstanceId")?)?;
    let queue = parse_chat_queue_state(raw.get("queue")?)?;
    let version = non_negative_int(raw.get("version")?)?;
    let updated_at = match raw.get("updatedAt")? {
        Value::Null => None,
        timestamp => Some(canonical_iso_timestamp(timestamp)?.to_owned()),
    };
    Some(ChatExecutionControlState {
        server_instance_id: server_instance_id.to_owned(),
        queue,
        version,
        updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requires_an_explicit_server_instance_for_empty_controls() {
        let control = empty_chat_execution_control_state("server-instance-test");
        assert_eq!(control.server_instance_id, "server-instance-test");
        assert_eq!(control.version, 0);
        assert_eq!(control.updated_at, None);
    }

    #[test]
    fn parses_bounded_opaque_server_instance_ids_without_normalizing_them() {
        assert_eq!(
            parse_execution_control_server_instance_id(&json!("server-a")),
            Some("server-a")
        );
        let bounded = "\u{1f600}".repeat(64);
        assert_eq!(
            parse_execution_control_server_instance_id(&json!(bounded)),
            Some(bounded.as_str())
        );
        for invalid in [
            Value::Null,
            json!(""),
            json!(" server-a"),
            json!("server-a "),
            json!("\u{1f600}".repeat(65)),
        ] {
            assert_eq!(parse_execution_control_server_instance_id(&invalid), None);
        }
    }

    #[test]
    fn rejects_controls_without_a_valid_server_instance_id() {
        let expected = empty_chat_execution_control_state("server-a");
        let mut object = json!(expected);
        assert_eq!(parse_chat_execution_control_state(&object), Some(expected));
        for invalid in [
            Value::Null,
            json!(""),
            json!(" server-a"),
            json!("server-a "),
        ] {
            object["serverInstanceId"] = invalid;
            assert_eq!(parse_chat_execution_control_state(&object), None);
        }
        object.as_object_mut().unwrap().remove("serverInstanceId");
        assert_eq!(parse_chat_execution_control_state(&object), None);
    }
}
