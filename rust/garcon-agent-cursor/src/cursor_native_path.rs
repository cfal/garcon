//! Ports `agents/cursor/cursor-native-path.ts`.

use garcon_agents_common::chats::artificial_native_path::{
    create_artificial_native_path, get_artificial_agent_session_id,
};
use serde_json::Value;

pub const CURSOR_AGENT_ID: &str = "cursor";
pub const CURSOR_ACP_NATIVE_AGENT_ID: &str = "cursor-acp";
pub const CURSOR_STREAM_JSON_NATIVE_AGENT_ID: &str = "cursor-stream-json";
pub const CURSOR_NATIVE_AGENT_IDS: [&str; 3] = [
    CURSOR_ACP_NATIVE_AGENT_ID,
    CURSOR_STREAM_JSON_NATIVE_AGENT_ID,
    CURSOR_AGENT_ID,
];

pub fn create_cursor_acp_native_path(id: Option<&str>) -> Option<String> {
    create_artificial_native_path(Some(CURSOR_ACP_NATIVE_AGENT_ID), id)
}

pub fn get_cursor_acp_agent_session_id_from_native_path(native_path: &Value) -> Option<String> {
    get_artificial_agent_session_id(native_path, [CURSOR_ACP_NATIVE_AGENT_ID])
}

pub fn get_cursor_stream_json_agent_session_id_from_native_path(
    native_path: &Value,
) -> Option<String> {
    get_artificial_agent_session_id(native_path, [CURSOR_STREAM_JSON_NATIVE_AGENT_ID])
}

pub fn get_cursor_agent_session_id_from_native_path(native_path: &Value) -> Option<String> {
    get_artificial_agent_session_id(native_path, CURSOR_NATIVE_AGENT_IDS)
}
