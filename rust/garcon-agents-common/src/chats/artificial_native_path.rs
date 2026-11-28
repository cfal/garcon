//! Ports `server-agents/common/src/chats/artificial-native-path.ts`.

use serde::Serialize;
use serde_json::Value;

pub const ARTIFICIAL_NATIVE_PATH_PREFIX: &str = "!";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtificialNativePathParts {
    pub agent_id: String,
    pub agent_session_id: String,
}

pub fn create_artificial_native_path(
    agent_id: Option<&str>,
    agent_session_id: Option<&str>,
) -> Option<String> {
    let agent_id = agent_id.filter(|agent_id| !agent_id.is_empty())?;
    let agent_session_id = agent_session_id.filter(|id| !id.is_empty())?;
    Some(format!(
        "{ARTIFICIAL_NATIVE_PATH_PREFIX}{agent_id}:{agent_session_id}"
    ))
}

pub fn is_artificial_native_path(native_path: &Value) -> bool {
    native_path
        .as_str()
        .is_some_and(|path| path.starts_with(ARTIFICIAL_NATIVE_PATH_PREFIX))
}

pub fn parse_artificial_native_path(native_path: &Value) -> Option<ArtificialNativePathParts> {
    let body = native_path
        .as_str()?
        .strip_prefix(ARTIFICIAL_NATIVE_PATH_PREFIX)?;
    let (agent_id, agent_session_id) = body.split_once(':')?;
    if agent_id.is_empty() || agent_session_id.is_empty() {
        return None;
    }

    Some(ArtificialNativePathParts {
        agent_id: agent_id.to_owned(),
        agent_session_id: agent_session_id.to_owned(),
    })
}

pub fn get_artificial_agent_session_id<'a>(
    native_path: &Value,
    agent_ids: impl IntoIterator<Item = &'a str>,
) -> Option<String> {
    let parsed = parse_artificial_native_path(native_path)?;
    agent_ids
        .into_iter()
        .any(|agent_id| agent_id == parsed.agent_id)
        .then_some(parsed.agent_session_id)
}
