use std::collections::HashSet;

use garcon_contract::auth::is_auth_session_id;
use garcon_js::{is_safe_integer, json::as_number};
use serde::Serialize;
use serde_json::Value;

pub const AUTH_SESSION_LIMIT: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthBrowserSession {
    pub session_id: String,
    pub owner_key: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum InvalidSessionFile {
    #[error("Invalid auth session registry")]
    Registry,
    #[error("Invalid auth session")]
    Session,
}

pub fn parse_stored_sessions(value: &Value) -> Result<Vec<AuthBrowserSession>, InvalidSessionFile> {
    let record = value.as_object().ok_or(InvalidSessionFile::Registry)?;
    let sessions = record
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or(InvalidSessionFile::Registry)?;
    if record.get("version").and_then(as_number) != Some(1.0)
        || record
            .keys()
            .any(|key| !matches!(key.as_str(), "version" | "sessions"))
        || sessions.len() > AUTH_SESSION_LIMIT
    {
        return Err(InvalidSessionFile::Registry);
    }
    let mut ids = HashSet::with_capacity(sessions.len());
    sessions
        .iter()
        .map(|raw| {
            let record = raw.as_object().ok_or(InvalidSessionFile::Session)?;
            if record
                .keys()
                .any(|key| !matches!(key.as_str(), "sessionId" | "ownerKey" | "expiresAtMs"))
            {
                return Err(InvalidSessionFile::Session);
            }
            let session_id = record
                .get("sessionId")
                .filter(|value| is_auth_session_id(value))
                .and_then(Value::as_str)
                .ok_or(InvalidSessionFile::Session)?;
            let owner_key = record
                .get("ownerKey")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or(InvalidSessionFile::Session)?;
            let expires_at_ms = record
                .get("expiresAtMs")
                .and_then(as_number)
                .filter(|expires| is_safe_integer(*expires) && *expires > 0.0)
                .ok_or(InvalidSessionFile::Session)?;
            if !ids.insert(session_id) {
                return Err(InvalidSessionFile::Session);
            }
            Ok(AuthBrowserSession {
                session_id: session_id.into(),
                owner_key: owner_key.into(),
                expires_at_ms: expires_at_ms as u64,
            })
        })
        .collect()
}
