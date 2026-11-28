//! Ports common/ws-requests.ts.

use std::collections::HashSet;

use garcon_js::{Number, trim};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::ws_value_parsing::non_negative_int;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandImage {
    pub data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

fn str_or_null(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

const MAX_RECONNECT_CONTROL_CHAT_IDS: usize = 256;

fn reconnect_control_chat_ids(value: Option<&Value>) -> Vec<String> {
    let Some(value) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    value
        .iter()
        .filter_map(Value::as_str)
        .map(trim)
        .filter(|id| !id.is_empty() && seen.insert(*id))
        .take(MAX_RECONNECT_CONTROL_CHAT_IDS)
        .map(str::to_owned)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectStateQueryRequest {
    pub client_request_id: Option<String>,
    pub control_chat_ids: Vec<String>,
    #[serde(rename = "type")]
    message_type: &'static str,
}

impl ReconnectStateQueryRequest {
    pub const TYPE: &'static str = "reconnect-state-query";

    pub fn new(client_request_id: Option<String>, control_chat_ids: Vec<String>) -> Self {
        Self {
            client_request_id,
            control_chat_ids,
            message_type: Self::TYPE,
        }
    }

    pub fn from_json(data: &Map<String, Value>) -> Self {
        Self::new(
            str_or_null(data.get("clientRequestId")),
            reconnect_control_chat_ids(data.get("controlChatIds")),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSubscribeRequest {
    pub client_request_id: Option<String>,
    pub chat_id: Option<String>,
    pub transcript_view_id: String,
    pub after_ordinal: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub through_ordinal: Option<u64>,
    #[serde(rename = "type")]
    message_type: &'static str,
}

impl ChatSubscribeRequest {
    pub const TYPE: &'static str = "chat-subscribe";

    pub fn new(
        client_request_id: Option<String>,
        chat_id: Option<String>,
        transcript_view_id: String,
        after_ordinal: u64,
        through_ordinal: Option<u64>,
    ) -> Self {
        Self {
            client_request_id,
            chat_id,
            transcript_view_id,
            after_ordinal,
            through_ordinal,
            message_type: Self::TYPE,
        }
    }

    pub fn from_json(data: &Map<String, Value>) -> Option<Self> {
        let after_ordinal = non_negative_int(data.get("afterOrdinal")?)?;
        let view = data
            .get("transcriptViewId")?
            .as_str()
            .filter(|view| !view.is_empty())?;
        let through_ordinal = match data.get("throughOrdinal") {
            Some(value) => {
                Some(non_negative_int(value).filter(|through| *through >= after_ordinal)?)
            }
            None => None,
        };
        Some(Self::new(
            str_or_null(data.get("clientRequestId")),
            str_or_null(data.get("chatId")),
            view.to_owned(),
            after_ordinal,
            through_ordinal,
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReloadRequest {
    pub client_request_id: Option<String>,
    pub chat_id: Option<String>,
    #[serde(rename = "type")]
    message_type: &'static str,
}

impl ChatReloadRequest {
    pub const TYPE: &'static str = "chat-reload";

    pub fn new(client_request_id: Option<String>, chat_id: Option<String>) -> Self {
        Self {
            client_request_id,
            chat_id,
            message_type: Self::TYPE,
        }
    }

    pub fn from_json(data: &Map<String, Value>) -> Self {
        Self::new(
            str_or_null(data.get("clientRequestId")),
            str_or_null(data.get("chatId")),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReloadCancelRequest {
    pub chat_id: Option<String>,
    pub reload_request_id: Option<String>,
    #[serde(rename = "type")]
    message_type: &'static str,
}

impl ChatReloadCancelRequest {
    pub const TYPE: &'static str = "chat-reload-cancel";

    pub fn new(chat_id: Option<String>, reload_request_id: Option<String>) -> Self {
        Self {
            chat_id,
            reload_request_id,
            message_type: Self::TYPE,
        }
    }

    pub fn from_json(data: &Map<String, Value>) -> Self {
        Self::new(
            str_or_null(data.get("chatId")),
            str_or_null(data.get("reloadRequestId")),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsPingRequest {
    pub client_request_id: Option<String>,
    pub sent_at: Number,
    #[serde(rename = "type")]
    message_type: &'static str,
}

impl WsPingRequest {
    pub const TYPE: &'static str = "ws-ping";

    pub fn new(client_request_id: Option<String>, sent_at: Number) -> Self {
        Self {
            client_request_id,
            sent_at,
            message_type: Self::TYPE,
        }
    }

    pub fn from_json(data: &Map<String, Value>) -> Self {
        let sent_at = data
            .get("sentAt")
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .unwrap_or(0.0);
        Self::new(str_or_null(data.get("clientRequestId")), Number(sent_at))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ClientWsMessage {
    ReconnectStateQuery(ReconnectStateQueryRequest),
    ChatSubscribe(ChatSubscribeRequest),
    ChatReload(ChatReloadRequest),
    ChatReloadCancel(ChatReloadCancelRequest),
    WsPing(WsPingRequest),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("null is not an object (evaluating 'data.type')")]
pub struct NullClientWsMessage;

pub fn parse_client_ws_message(
    data: &Value,
) -> Result<Option<ClientWsMessage>, NullClientWsMessage> {
    if data.is_null() {
        return Err(NullClientWsMessage);
    }
    let Some(data) = data.as_object() else {
        return Ok(None);
    };
    Ok(match data.get("type").and_then(Value::as_str) {
        Some(ReconnectStateQueryRequest::TYPE) => Some(ClientWsMessage::ReconnectStateQuery(
            ReconnectStateQueryRequest::from_json(data),
        )),
        Some(ChatSubscribeRequest::TYPE) => {
            ChatSubscribeRequest::from_json(data).map(ClientWsMessage::ChatSubscribe)
        }
        Some(ChatReloadRequest::TYPE) => Some(ClientWsMessage::ChatReload(
            ChatReloadRequest::from_json(data),
        )),
        Some(ChatReloadCancelRequest::TYPE) => Some(ClientWsMessage::ChatReloadCancel(
            ChatReloadCancelRequest::from_json(data),
        )),
        Some(WsPingRequest::TYPE) => Some(ClientWsMessage::WsPing(WsPingRequest::from_json(data))),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn subscribe() -> Value {
        json!({
            "type":"chat-subscribe","clientRequestId":"request-2","chatId":"chat-1",
            "transcriptViewId":"view-1","afterOrdinal":220,"throughOrdinal":500
        })
    }

    #[test]
    fn preserves_a_continuation_watermark_on_subscribe_requests() {
        let parsed = parse_client_ws_message(&subscribe()).unwrap().unwrap();
        let ClientWsMessage::ChatSubscribe(parsed) = parsed else {
            panic!("expected chat-subscribe");
        };
        assert_eq!(parsed.after_ordinal, 220);
        assert_eq!(parsed.through_ordinal, Some(500));
        assert_eq!(json!(parsed), subscribe());
    }

    #[test]
    fn rejects_a_continuation_watermark_behind_its_replay_cursor() {
        let mut value = subscribe();
        value["afterOrdinal"] = json!(501);
        assert_eq!(parse_client_ws_message(&value), Ok(None));
    }

    #[test]
    fn rejects_malformed_replay_cursors_instead_of_restarting_from_ordinal_zero() {
        let mut value = subscribe();
        for invalid in [
            Value::Null,
            json!("220"),
            json!(-1),
            json!(1.5),
            json!(9_007_199_254_740_992_u64),
        ] {
            value["afterOrdinal"] = invalid;
            assert_eq!(parse_client_ws_message(&value), Ok(None));
        }
        value.as_object_mut().unwrap().remove("afterOrdinal");
        assert_eq!(parse_client_ws_message(&value), Ok(None));
    }

    #[test]
    fn rejects_malformed_continuation_watermarks() {
        let mut value = subscribe();
        for invalid in [
            Value::Null,
            json!("500"),
            json!(-1),
            json!(1.5),
            json!(9_007_199_254_740_992_u64),
        ] {
            value["throughOrdinal"] = invalid;
            assert_eq!(parse_client_ws_message(&value), Ok(None));
        }
        value.as_object_mut().unwrap().remove("throughOrdinal");
        assert_eq!(json!(parse_client_ws_message(&value).unwrap()), value);
    }

    #[test]
    fn parses_a_reload_cancellation_without_coercing_ids() {
        let good = json!({"type":"chat-reload-cancel","chatId":"chat-1","reloadRequestId":"r-1"});
        assert_eq!(json!(parse_client_ws_message(&good).unwrap()), good);
        let malformed = json!({"type":"chat-reload-cancel","chatId":"chat-1","reloadRequestId":7});
        assert_eq!(
            json!(parse_client_ws_message(&malformed).unwrap()),
            json!({"type":"chat-reload-cancel","chatId":"chat-1","reloadRequestId":null})
        );
    }

    #[test]
    fn caps_reconnect_ids_after_trimming_and_deduplicating() {
        let mut ids = vec![
            Value::Null,
            json!("  test  "),
            json!("test"),
            json!("\u{feff}"),
        ];
        ids.extend((0..256).map(|n| json!(format!("id-{n}"))));
        let input = json!({"type":"reconnect-state-query","controlChatIds":ids});
        let parsed = parse_client_ws_message(&input).unwrap().unwrap();
        let ClientWsMessage::ReconnectStateQuery(parsed) = parsed else {
            panic!("expected reconnect-state-query");
        };
        assert_eq!(parsed.control_chat_ids.len(), 256);
        assert_eq!(parsed.control_chat_ids[0], "test");
        assert_eq!(parsed.control_chat_ids[255], "id-254");
    }

    #[test]
    fn keeps_fractional_ping_timestamps_and_defaults_non_numeric_values() {
        let value = json!({"type":"ws-ping","clientRequestId":"r-1","sentAt":1.5});
        assert_eq!(json!(parse_client_ws_message(&value).unwrap()), value);
        let bad = json!({"type":"ws-ping","clientRequestId":42,"sentAt":"1"});
        assert_eq!(
            json!(parse_client_ws_message(&bad).unwrap()),
            json!({"type":"ws-ping","clientRequestId":null,"sentAt":0})
        );
    }

    #[test]
    fn distinguishes_null_from_an_unrecognized_message() {
        assert_eq!(
            parse_client_ws_message(&Value::Null),
            Err(NullClientWsMessage)
        );
        assert_eq!(parse_client_ws_message(&json!(1)), Ok(None));
    }
}
