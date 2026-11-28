//! Ports `server/remote/transport/link-handshake.ts`.

use garcon_js::utf16;
use serde::Serialize;
use serde_json::Value;

use crate::rpc_lane::{RpcLane, is_session_id};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkRole {
    Controller,
    Worker,
}

impl LinkRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Controller => "controller",
            Self::Worker => "worker",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename = "hello", rename_all = "camelCase", tag = "type")]
pub struct LinkHello {
    pub version: String,
    pub role: LinkRole,
    pub executor_id: Option<String>,
    pub runtime_id: String,
    pub nonce: String,
    pub lane: RpcLane,
    pub session_id: Option<String>,
    pub primary_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkDialTarget {
    pub lane: RpcLane,
    pub session_id: Option<String>,
    pub primary_session_id: Option<String>,
}

pub fn is_link_hello(value: &Value) -> bool {
    parse_link_hello(value).is_some()
}

pub fn parse_link_hello(value: &Value) -> Option<LinkHello> {
    let fields = value.as_object()?;
    if fields.len() != 9 || fields.get("type")?.as_str()? != "hello" {
        return None;
    }
    let role = match fields.get("role")?.as_str()? {
        "controller" => LinkRole::Controller,
        "worker" => LinkRole::Worker,
        _ => return None,
    };
    let lane = match fields.get("lane")?.as_str()? {
        "primary" => RpcLane::Primary,
        "bulk" => RpcLane::Bulk,
        _ => return None,
    };
    let version = bounded_string(fields.get("version")?)?;
    let runtime_id = bounded_string(fields.get("runtimeId")?)?;
    let nonce = fields.get("nonce")?.as_str()?;
    if nonce.len() != 64
        || !nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let unbound_worker = role == LinkRole::Worker && lane == RpcLane::Primary;
    let executor = fields.get("executorId")?;
    let executor_id = match executor {
        Value::Null if unbound_worker => None,
        value => Some(bounded_string(value)?.to_owned()),
    };
    let session = fields.get("sessionId")?;
    let session_id = if is_session_id(session) {
        Some(session.as_str()?.to_owned())
    } else if unbound_worker && session.is_null() {
        None
    } else {
        return None;
    };
    let parent = fields.get("primarySessionId")?;
    let primary_session_id = match lane {
        RpcLane::Primary if parent.is_null() => None,
        RpcLane::Bulk if is_session_id(parent) => Some(parent.as_str()?.to_owned()),
        _ => return None,
    };
    Some(LinkHello {
        version: version.to_owned(),
        role,
        executor_id,
        runtime_id: runtime_id.to_owned(),
        nonce: nonce.to_owned(),
        lane,
        session_id,
        primary_session_id,
    })
}

fn bounded_string(value: &Value) -> Option<&str> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && utf16::len(s) <= 128)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn only_primary_workers_can_omit_the_executor_and_session_identity() {
        let mut frame = json!({
            "type": "hello",
            "version": "1",
            "role": "worker",
            "executorId": null,
            "runtimeId": "runtime",
            "nonce": "f".repeat(64),
            "lane": "primary",
            "sessionId": null,
            "primarySessionId": null,
        });
        let hello = parse_link_hello(&frame).unwrap();
        let encoded = serde_json::to_string(&hello).unwrap();
        assert_eq!(garcon_js::json::parse(&encoded).unwrap(), frame);
        frame["role"] = json!("controller");
        assert!(!is_link_hello(&frame));
        frame["executorId"] = json!("synthetic");
        frame["sessionId"] = json!("22222222-2222-4222-8222-222222222222");
        assert!(is_link_hello(&frame));
        frame["lane"] = json!("bulk");
        assert!(!is_link_hello(&frame));
        frame["primarySessionId"] = json!("11111111-1111-4111-8111-111111111111");
        assert!(is_link_hello(&frame));
        frame["version"] = json!("\u{1F600}".repeat(65));
        assert!(!is_link_hello(&frame));
    }
}
