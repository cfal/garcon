//! Session requests from the controller's primary browser WebSocket.

use std::path::PathBuf;
use std::rc::Rc;

use bytes::Bytes;
use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_contract::ws_events::{
    ChatProcessingSnapshotResult, ClientRequestErrorCode, ClientRequestErrorMessage,
    ReconnectStateMessage, SessionWsMessage, WsFaultMessage, WsPongMessage,
};
use garcon_contract::ws_protocol::is_terminal_stream_client_message_type;
use garcon_contract::ws_requests::{
    ChatReloadCancelRequest, ChatReloadRequest, ChatSubscribeRequest, ClientWsMessage,
    ReconnectStateQueryRequest, parse_client_ws_message,
};
use garcon_js::{Clock, json, to_iso_string};
use serde::Serialize;
use serde_json::Value;

use crate::http_route::log_unported;

use super::server_sockets::PrimaryRequests;
use super::{chat_subscribe::ChatSubscriptions, primary_delivery::PrimaryPeer};

pub(super) struct PrimaryHandler {
    instance_id: String,
    clock: Rc<dyn Clock>,
    unported_log: Option<PathBuf>,
    chat_subscriptions: Option<Rc<dyn ChatSubscriptions>>,
    logger: ScopedLogger,
}

impl PrimaryHandler {
    pub(super) fn new(
        instance_id: String,
        clock: Rc<dyn Clock>,
        unported_log: Option<PathBuf>,
    ) -> Self {
        Self {
            instance_id,
            clock,
            unported_log,
            chat_subscriptions: None,
            logger: create_logger("ws:primary"),
        }
    }

    pub(super) fn with_chat_subscriptions(
        mut self,
        subscriptions: Rc<dyn ChatSubscriptions>,
    ) -> Self {
        self.chat_subscriptions = Some(subscriptions);
        self
    }

    async fn reply(&self, input: &[u8]) -> Option<Reply> {
        let Ok(raw) = json::parse(&String::from_utf8_lossy(input)) else {
            return Some(Reply::fault("Malformed JSON"));
        };
        if is_terminal_stream_client_message_type(&raw["type"])
            && let Some(request_type) = raw["type"].as_str()
        {
            return Some(Reply::unported(request_type, None, None));
        }
        let request = match parse_client_ws_message(&raw) {
            Ok(Some(request)) => request,
            Ok(None) => return malformed_request(&raw),
            Err(error) => return Some(Reply::fault(error.to_string())),
        };
        match request {
            ClientWsMessage::WsPing(request) => {
                let id = nonempty(request.client_request_id)?;
                let server_time = match to_iso_string(self.clock.now_ms()) {
                    Ok(time) => time,
                    Err(error) => return Some(Reply::fault(error.to_string())),
                };
                Some(Reply::new(SessionWsMessage::WsPong(WsPongMessage::new(
                    id,
                    request.sent_at,
                    server_time,
                    empty_processing(),
                    self.instance_id.clone(),
                ))))
            }
            ClientWsMessage::ReconnectStateQuery(request) => {
                if !request.control_chat_ids.is_empty() {
                    return Some(Reply::unported(
                        ReconnectStateQueryRequest::TYPE,
                        request.client_request_id,
                        None,
                    ));
                }
                Some(Reply::new(SessionWsMessage::ReconnectState(
                    ReconnectStateMessage::new(
                        empty_processing(),
                        Vec::new(),
                        self.instance_id.clone(),
                        request.client_request_id,
                    ),
                )))
            }
            ClientWsMessage::ChatSubscribe(request) => {
                let ty = ChatSubscribeRequest::TYPE;
                let id = nonempty(request.client_request_id.clone());
                let Some(chat_id) = nonempty(request.chat_id.clone()) else {
                    return Some(missing_chat(ty, id));
                };
                let Some(id) = id else {
                    return Some(Reply::fault("chat-subscribe requires a clientRequestId"));
                };
                if let Some(subscriptions) = &self.chat_subscriptions {
                    return Some(
                        match subscriptions.subscribe(&request, &id, &chat_id).await {
                            Ok(payload) => Reply {
                                message: ReplyMessage::Encoded(payload),
                                unported: None,
                            },
                            Err(error) => Reply::new(SessionWsMessage::ClientRequestError(error)),
                        },
                    );
                }
                Some(Reply::unported(ty, Some(id), Some(chat_id)))
            }
            ClientWsMessage::ChatReload(request) => {
                let ty = ChatReloadRequest::TYPE;
                let id = nonempty(request.client_request_id);
                let Some(chat_id) = nonempty(request.chat_id) else {
                    return Some(missing_chat(ty, id));
                };
                Some(Reply::unported(ty, Some(id?), Some(chat_id)))
            }
            ClientWsMessage::ChatReloadCancel(request) => {
                // This slice cannot start a reload, so only request validation runs.
                nonempty(request.chat_id)
                    .is_none()
                    .then(|| missing_chat(ChatReloadCancelRequest::TYPE, None))
            }
        }
    }
}

#[async_trait::async_trait(?Send)]
impl PrimaryRequests for PrimaryHandler {
    async fn message(&self, peer: &PrimaryPeer, bytes: Bytes) {
        let Some(reply) = self.reply(&bytes).await else {
            return;
        };
        match reply.encode() {
            Ok(bytes) => {
                peer.send(bytes);
            }
            Err(error) => self.logger.error(&format!(
                "Could not encode browser WebSocket reply: {error}"
            )),
        }
        if let (Some(path), Some(request_type)) = (&self.unported_log, reply.unported.as_deref())
            && let Err(error) = log_unported(path, "WS", request_type).await
        {
            self.logger
                .error(&format!("Could not write the unported route log: {error}"));
        }
    }
}

fn empty_processing() -> ChatProcessingSnapshotResult {
    ChatProcessingSnapshotResult::Snapshot { chats: Vec::new() }
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

fn missing_chat(request_type: &str, id: Option<String>) -> Reply {
    let message = format!("Missing chatId for \"{request_type}\"");
    match id {
        Some(id) => Reply::request_error(
            id,
            request_type,
            ClientRequestErrorCode::MissingChatId,
            message,
            None,
        ),
        None => Reply::fault(message),
    }
}

fn malformed_request(raw: &Value) -> Option<Reply> {
    let ty = ChatSubscribeRequest::TYPE;
    if raw.get("type").and_then(Value::as_str) != Some(ty) {
        return None;
    }
    let field = |name| {
        raw.get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let Some(id) = field("clientRequestId") else {
        return Some(Reply::fault("chat-subscribe requires a clientRequestId"));
    };
    let Some(chat_id) = field("chatId") else {
        return Some(missing_chat(ty, Some(id)));
    };
    Some(Reply::request_error(
        id,
        ty,
        ClientRequestErrorCode::RequestValidationFailed,
        "Invalid chat-subscribe request",
        Some(chat_id),
    ))
}

struct Reply {
    message: ReplyMessage,
    unported: Option<String>,
}

enum ReplyMessage {
    Session(SessionWsMessage),
    Encoded(Bytes),
}

impl Reply {
    fn new(message: SessionWsMessage) -> Self {
        Self {
            message: ReplyMessage::Session(message),
            unported: None,
        }
    }

    fn fault(message: impl Into<String>) -> Self {
        Self::new(SessionWsMessage::WsFault(WsFaultMessage::new(
            message.into(),
        )))
    }

    fn request_error(
        id: String,
        request_type: &str,
        code: ClientRequestErrorCode,
        message: impl Into<String>,
        chat_id: Option<String>,
    ) -> Self {
        Self::new(SessionWsMessage::ClientRequestError(
            ClientRequestErrorMessage::new(
                id,
                request_type.into(),
                code,
                message.into(),
                false,
                chat_id,
            ),
        ))
    }

    fn unported(request_type: &str, id: Option<String>, chat_id: Option<String>) -> Self {
        let mut reply = if let Some(id) = id {
            Self::request_error(
                id,
                request_type,
                ClientRequestErrorCode::InternalError,
                "not ported",
                chat_id,
            )
        } else {
            Self::fault("not ported")
        };
        reply.unported = Some(request_type.into());
        reply
    }

    fn encode(&self) -> serde_json::Result<Bytes> {
        #[derive(Serialize)]
        struct Marked<'a> {
            #[serde(flatten)]
            message: &'a SessionWsMessage,
            #[serde(rename = "garconRsUnported")]
            unported: bool,
        }
        let message = match &self.message {
            ReplyMessage::Session(message) => message,
            ReplyMessage::Encoded(payload) => return Ok(payload.clone()),
        };
        let bytes = if self.unported.is_some() {
            serde_json::to_vec(&Marked {
                message,
                unported: true,
            })
        } else {
            serde_json::to_vec(message)
        }?;
        Ok(Bytes::from(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_js::ManualClock;
    use serde_json::json;

    async fn reply(request: &str) -> Option<Value> {
        let handler = PrimaryHandler::new(
            "controller-instance".into(),
            Rc::new(ManualClock::new(1000)),
            None,
        );
        let bytes = handler.reply(request.as_bytes()).await?.encode().unwrap();
        Some(json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn answers_heartbeat_and_returns_an_authoritative_empty_reconnect_snapshot() {
        let processing = json!({"outcome":"snapshot","chats":[]});
        assert_eq!(
            reply(r#"{"type":"ws-ping","clientRequestId":"ping","sentAt":1.5}"#).await,
            Some(json!({
                "type":"ws-pong","clientRequestId":"ping","sentAt":1.5,
                "serverTime":"1970-01-01T00:00:01.000Z","processing":processing,
                "serverInstanceId":"controller-instance",
            })),
        );
        assert_eq!(
            reply(
                r#"{"type":"reconnect-state-query","clientRequestId":"sync","controlChatIds":[" " , 5]}"#
            ).await,
            Some(json!({
                "type":"reconnect-state","clientRequestId":"sync","processing":processing,
                "controlResults":[],"serverInstanceId":"controller-instance",
            })),
        );
        let uncorrelated = reply(r#"{"type":"reconnect-state-query"}"#).await.unwrap();
        assert!(uncorrelated.get("clientRequestId").is_none());
    }

    #[tokio::test]
    async fn separates_validation_errors_from_unsupported_chat_requests() {
        for (request, expected) in [
            (
                r#"{"type":"chat-subscribe","clientRequestId":"req","chatId":"chat","afterOrdinal":-1}"#,
                json!({
                    "type":"client-request-error","clientRequestId":"req","requestType":"chat-subscribe",
                    "code":"REQUEST_VALIDATION_FAILED","message":"Invalid chat-subscribe request",
                    "retryable":false,"chatId":"chat",
                }),
            ),
            (
                r#"{"type":"chat-subscribe","clientRequestId":"req","chatId":5}"#,
                json!({
                    "type":"client-request-error","clientRequestId":"req","requestType":"chat-subscribe",
                    "code":"MISSING_CHAT_ID","message":"Missing chatId for \"chat-subscribe\"","retryable":false,
                }),
            ),
            (
                r#"{"type":"chat-subscribe","chatId":"chat","afterOrdinal":0,"transcriptViewId":"view"}"#,
                json!({
                    "type":"ws-fault","error":"chat-subscribe requires a clientRequestId",
                }),
            ),
            (
                r#"{"type":"chat-reload-cancel","clientRequestId":"ignored","reloadRequestId":"target"}"#,
                json!({
                    "type":"ws-fault","error":"Missing chatId for \"chat-reload-cancel\"",
                }),
            ),
            (
                r#"{"type":"chat-reload","clientRequestId":"req","chatId":"chat"}"#,
                json!({
                    "type":"client-request-error","clientRequestId":"req","requestType":"chat-reload",
                    "code":"INTERNAL_ERROR","message":"not ported","retryable":false,"chatId":"chat",
                    "garconRsUnported":true,
                }),
            ),
            (
                r#"{"type":"reconnect-state-query","controlChatIds":["chat"]}"#,
                json!({
                    "type":"ws-fault","error":"not ported","garconRsUnported":true,
                }),
            ),
        ] {
            assert_eq!(reply(request).await, Some(expected), "{request}");
        }
    }

    #[tokio::test]
    async fn correctly_correlates_chat_subscriptions_and_keeps_the_marker_without_composition() {
        struct Subscriptions;

        #[async_trait::async_trait(?Send)]
        impl ChatSubscriptions for Subscriptions {
            async fn subscribe(
                &self,
                request: &ChatSubscribeRequest,
                id: &str,
                chat_id: &str,
            ) -> Result<Bytes, ClientRequestErrorMessage> {
                assert_eq!(request.transcript_view_id, "view");
                assert_eq!(request.after_ordinal, 11);
                assert_eq!(request.through_ordinal, Some(20));
                Err(ClientRequestErrorMessage::new(
                    id.into(),
                    ChatSubscribeRequest::TYPE.into(),
                    ClientRequestErrorCode::StaleTranscriptView,
                    "stale view".into(),
                    false,
                    Some(chat_id.into()),
                ))
            }
        }

        let request = br#"{"type":"chat-subscribe","clientRequestId":"request",
            "chatId":"chat","transcriptViewId":"view","afterOrdinal":11,"throughOrdinal":20}"#;
        let handler = PrimaryHandler::new(
            "controller-instance".into(),
            Rc::new(ManualClock::new(1000)),
            None,
        );
        let reply = handler.reply(request).await.unwrap();
        assert_eq!(reply.unported.as_deref(), Some("chat-subscribe"));
        let handler = handler.with_chat_subscriptions(Rc::new(Subscriptions));
        let reply = handler.reply(request).await.unwrap();
        assert_eq!(reply.unported, None);
        let value: Value = json::from_slice(&reply.encode().unwrap()).unwrap();
        assert_eq!(
            value,
            json!({
                "type": "client-request-error", "requestType": "chat-subscribe",
                "clientRequestId": "request", "chatId": "chat",
                "code": "STALE_TRANSCRIPT_VIEW", "message": "stale view", "retryable": false,
            })
        );
    }

    #[tokio::test]
    async fn faults_for_malformed_json_and_does_not_reply_to_ignored_requests() {
        assert_eq!(
            reply("{").await,
            Some(json!({"type":"ws-fault","error":"Malformed JSON"}))
        );
        assert_eq!(
            reply("null").await,
            Some(
                json!({"type":"ws-fault","error":"null is not an object (evaluating 'data.type')"})
            )
        );
        for request in [
            "\"\"",
            r#"{"type":"unknown","clientRequestId":"ignored"}"#,
            r#"{"type":"ws-ping","clientRequestId":""}"#,
            r#"{"type":"ws-ping","clientRequestId":42}"#,
            r#"{"type":"chat-reload","chatId":"chat"}"#,
            r#"{"type":"chat-reload-cancel","chatId":"chat","reloadRequestId":"inactive"}"#,
        ] {
            assert_eq!(reply(request).await, None, "{request}");
        }
    }
}
