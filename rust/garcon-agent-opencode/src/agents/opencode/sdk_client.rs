//! The used subset of `@opencode-ai/sdk/v2` (1.19.6). The shared HTTP client
//! refuses cross-origin redirects; the OpenCode server Garcon spawns does not
//! redirect these endpoints.

use std::error::Error;

use async_trait::async_trait;
use futures::stream::LocalBoxStream;
use garcon_agents_common::shared::provider_http::{self, Method, Response, StatusCode, header};
use garcon_base::errors::{ErrorInput, NamedError, error_message};
use garcon_interface::resources::ExecutorResult;
use serde_json::{Map, Value, json};

use super::sdk_result::OpenCodeSdkResult;
use super::sse_events::read_sdk_events;
use crate::js::{AbortSignal, error, error_of, string_of, truthy};

pub type OpenCodeEnvelopes = LocalBoxStream<'static, ExecutorResult<Value>>;

#[async_trait(?Send)]
pub trait OpenCodeClient {
    async fn request(
        &self,
        operation: OpenCodeRequest,
        parameters: Map<String, Value>,
        signal: &AbortSignal,
    ) -> ExecutorResult<OpenCodeSdkResult>;

    async fn global_events(&self, signal: &AbortSignal) -> ExecutorResult<OpenCodeEnvelopes>;

    fn supports_config_providers(&self) -> bool;
    fn supports_move_session(&self) -> bool;

    fn supports_permission_reply(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone)]
pub struct OpenCodeSdkClient {
    base_url: String,
}

impl OpenCodeSdkClient {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenCodeRequest {
    ConfigProviders,
    ProviderList,
    SessionCreate,
    SessionDelete,
    SessionGet,
    SessionUpdate,
    SessionMessages,
    SessionPrompt,
    SessionPromptAsync,
    SessionFork,
    SessionAbort,
    SessionSummarize,
    SessionRevert,
    MoveSession,
    PermissionReply,
    QuestionReply,
    QuestionReject,
    ShowToast,
}

struct RequestSpec {
    method: Method,
    path: &'static str,
    query: &'static [&'static str],
    body: &'static [&'static str],
}

const DIRECTORY_QUERY: &[&str] = &["directory", "workspace"];
const PROMPT_BODY: &[&str] = &[
    "messageID",
    "model",
    "agent",
    "noReply",
    "tools",
    "format",
    "system",
    "variant",
    "parts",
];

impl OpenCodeRequest {
    fn spec(self) -> RequestSpec {
        use OpenCodeRequest as Op;
        let (method, path, body) = match self {
            Op::ConfigProviders => (Method::GET, "/config/providers", &[][..]),
            Op::ProviderList => (Method::GET, "/provider", &[][..]),
            Op::SessionCreate => (
                Method::POST,
                "/session",
                &[
                    "parentID",
                    "title",
                    "agent",
                    "model",
                    "metadata",
                    "permission",
                    "workspaceID",
                ][..],
            ),
            Op::SessionDelete => (Method::DELETE, "/session/{sessionID}", &[][..]),
            Op::SessionGet => (Method::GET, "/session/{sessionID}", &[][..]),
            Op::SessionUpdate => (
                Method::PATCH,
                "/session/{sessionID}",
                &["title", "metadata", "permission", "time"][..],
            ),
            Op::SessionMessages => (Method::GET, "/session/{sessionID}/message", &[][..]),
            Op::SessionPrompt => (Method::POST, "/session/{sessionID}/message", PROMPT_BODY),
            Op::SessionPromptAsync => (
                Method::POST,
                "/session/{sessionID}/prompt_async",
                PROMPT_BODY,
            ),
            Op::SessionFork => (
                Method::POST,
                "/session/{sessionID}/fork",
                &["messageID"][..],
            ),
            Op::SessionAbort => (Method::POST, "/session/{sessionID}/abort", &[][..]),
            Op::SessionSummarize => (
                Method::POST,
                "/session/{sessionID}/summarize",
                &["providerID", "modelID", "auto"][..],
            ),
            Op::SessionRevert => (
                Method::POST,
                "/session/{sessionID}/revert",
                &["messageID", "partID"][..],
            ),
            Op::MoveSession => (
                Method::POST,
                "/experimental/control-plane/move-session",
                &["sessionID", "destination", "moveChanges"][..],
            ),
            Op::PermissionReply => (
                Method::POST,
                "/permission/{requestID}/reply",
                &["reply", "message"][..],
            ),
            Op::QuestionReply => (
                Method::POST,
                "/question/{requestID}/reply",
                &["answers"][..],
            ),
            Op::QuestionReject => (Method::POST, "/question/{requestID}/reject", &[][..]),
            Op::ShowToast => (
                Method::POST,
                "/tui/show-toast",
                &["title", "message", "variant", "duration"][..],
            ),
        };
        let query = match self {
            Op::MoveSession => &[][..],
            Op::SessionMessages => &["directory", "workspace", "limit", "before"][..],
            _ => DIRECTORY_QUERY,
        };
        RequestSpec {
            method,
            path,
            query,
            body,
        }
    }
}

struct BuiltRequest {
    method: Method,
    url: String,
    body: Option<Vec<u8>>,
}

impl OpenCodeSdkClient {
    fn build_request(
        &self,
        operation: OpenCodeRequest,
        parameters: Map<String, Value>,
    ) -> BuiltRequest {
        let spec = operation.spec();
        let mut path = spec.path.to_owned();
        for (name, placeholder) in [("sessionID", "{sessionID}"), ("requestID", "{requestID}")] {
            if path.contains(placeholder)
                && let Some(value) = parameters.get(name).filter(|value| !value.is_null())
            {
                path = path.replace(placeholder, &encode_uri_component(&string_of(Some(value))));
            }
        }
        let mut url = format!("{}{path}", self.base_url);
        let mut separator = '?';
        for (name, value) in &parameters {
            if spec.query.contains(&name.as_str()) && !value.is_null() {
                url.push(separator);
                url.push_str(name);
                url.push('=');
                url.push_str(&encode_uri_component(&string_of(Some(value))));
                separator = '&';
            }
        }
        let body = Map::from_iter(
            parameters
                .into_iter()
                .filter(|(name, _)| spec.body.contains(&name.as_str())),
        );
        BuiltRequest {
            method: spec.method,
            url,
            body: (!body.is_empty())
                .then(|| garcon_js::json::stringify(&Value::Object(body)).into_bytes()),
        }
    }
}

#[async_trait(?Send)]
impl OpenCodeClient for OpenCodeSdkClient {
    async fn request(
        &self,
        operation: OpenCodeRequest,
        parameters: Map<String, Value>,
        signal: &AbortSignal,
    ) -> ExecutorResult<OpenCodeSdkResult> {
        let BuiltRequest { method, url, body } = self.build_request(operation, parameters);
        let headers = if body.is_some() {
            provider_http::json_headers()
        } else {
            header::HeaderMap::new()
        };
        let response = tokio::select! {
            biased;
            () = signal.token().cancelled() => Err(signal.abort_reason().into()),
            response = provider_http::send(method, &url, headers, body) => response,
        };
        let response = match response {
            Ok(response) => response,
            Err(failure) => return Ok(OpenCodeSdkResult::thrown(sdk_error(failure.as_ref()))),
        };
        tokio::select! {
            biased;
            () = signal.token().cancelled() => Err(signal.abort_reason().into()),
            result = decode_response(response) => result,
        }
    }

    async fn global_events(&self, signal: &AbortSignal) -> ExecutorResult<OpenCodeEnvelopes> {
        let url = format!("{}/global/event", self.base_url);
        let response = tokio::select! {
            biased;
            () = signal.token().cancelled() => return Err(signal.abort_reason().into()),
            response = provider_http::send(Method::GET, &url, header::HeaderMap::new(), None) => response?,
        };
        let status = response.status();
        if !status.is_success() {
            return Err(error(
                "Error",
                format!(
                    "SSE failed: {} {}",
                    status.as_u16(),
                    status.canonical_reason().unwrap_or_default()
                ),
            ));
        }
        if matches!(status, StatusCode::NO_CONTENT | StatusCode::RESET_CONTENT) {
            return Err(error("Error", "No body in SSE response"));
        }
        Ok(read_sdk_events(response.bytes_stream(), signal.clone()))
    }

    fn supports_config_providers(&self) -> bool {
        true
    }

    fn supports_move_session(&self) -> bool {
        true
    }
}

fn sdk_error(failure: &(dyn Error + 'static)) -> Value {
    let name = error_of::<NamedError>(failure).map_or("Error", |error| error.name.as_str());
    json!({ "name": name, "message": error_message(ErrorInput::Error(failure), None) })
}

async fn decode_response(response: Response) -> ExecutorResult<OpenCodeSdkResult> {
    let status = response.status();
    let content_type = provider_http::content_type(&response);
    if content_type.as_deref() == Some("text/html") {
        return Err(error(
            "Error",
            "Request is not supported by this version of OpenCode Server (Server responded with text/html)",
        ));
    }
    let media = content_type
        .as_deref()
        .and_then(|text| text.split(';').next())
        .map(str::trim);
    if status.is_success() {
        let data = match media {
            None => {
                // The SDK returns the unread stream for a missing Content-Type.
                if status == StatusCode::NO_CONTENT {
                    Value::Null
                } else {
                    empty_object()
                }
            }
            Some(media) if media.starts_with("text/") => {
                Value::String(decode_text(&response.bytes().await?).into_owned())
            }
            Some(media)
                if (media.starts_with("application/json") || media.ends_with("+json"))
                    || !["application/", "audio/", "image/", "video/"]
                        .iter()
                        .any(|prefix| media.starts_with(prefix)) =>
            {
                let bytes = response.bytes().await?;
                let text = decode_text(&bytes);
                if text.is_empty() {
                    empty_object()
                } else {
                    garcon_js::json::parse(&text)?
                }
            }
            // Garcon does not inspect a Blob returned in place of a JSON payload.
            Some(_) => empty_object(),
        };
        return Ok(OpenCodeSdkResult::success(data, status.as_u16()));
    }
    let bytes = response.bytes().await?;
    let text = decode_text(&bytes);
    let body = match garcon_js::json::parse(&text) {
        Ok(body) if !body.is_null() => body,
        _ => Value::String(text.into_owned()),
    };
    let error = if truthy(&body) { body } else { empty_object() };
    Ok(OpenCodeSdkResult::failure(error, status.as_u16()))
}

fn decode_text(bytes: &[u8]) -> std::borrow::Cow<'_, str> {
    String::from_utf8_lossy(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes))
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

fn encode_uri_component(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0xf)]));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, rc::Rc};

    use futures::StreamExt;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        task::JoinHandle,
    };

    use super::*;
    use crate::agents::opencode::sse_events::stream_global_events;

    async fn serve_once(
        status: &str,
        content_type: Option<&str>,
        body: &str,
    ) -> (OpenCodeSdkClient, JoinHandle<String>) {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind fixture");
        let address = listener.local_addr().expect("fixture address");
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        if let Some(content_type) = content_type {
            response.push_str(&format!("Content-Type: {content_type}\r\n"));
        }
        response.push_str("\r\n");
        response.push_str(body);
        let received = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept SDK request");
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let size = socket.read(&mut buffer).await.expect("read request");
                assert_ne!(size, 0, "request closes before headers");
                request.extend_from_slice(&buffer[..size]);
                let Some(header_end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
                let body_len = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .map_or(0, |value| {
                        value
                            .trim()
                            .parse::<usize>()
                            .expect("request content length")
                    });
                if request.len() >= header_end + 4 + body_len {
                    break;
                }
            }
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write response");
            socket.shutdown().await.expect("finish response");
            String::from_utf8(request).expect("request UTF-8")
        });
        (
            OpenCodeSdkClient::new(&format!("http://{address}")),
            received,
        )
    }

    fn parameters(value: Value) -> Map<String, Value> {
        value.as_object().expect("object parameters").clone()
    }

    #[test]
    fn matches_the_original_sdk_request_bytes() {
        use OpenCodeRequest as Op;
        use garcon_cases::{CaseError, replay, round_tripped, text};

        const BASE_URL: &str = "http://127.0.0.1:9911";
        const OPERATIONS: &[OpenCodeRequest] = &[
            Op::ConfigProviders,
            Op::ProviderList,
            Op::SessionCreate,
            Op::SessionDelete,
            Op::SessionGet,
            Op::SessionUpdate,
            Op::SessionMessages,
            Op::SessionPrompt,
            Op::SessionPromptAsync,
            Op::SessionFork,
            Op::SessionAbort,
            Op::SessionSummarize,
            Op::SessionRevert,
            Op::MoveSession,
            Op::PermissionReply,
            Op::QuestionReply,
            Op::QuestionReject,
            Op::ShowToast,
        ];
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/sdk-wire"),
            |function, args| {
                if function != "sdkRequest" {
                    return Err(CaseError::unhandled(function));
                }
                let name =
                    text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
                let operation = OPERATIONS
                    .iter()
                    .find(|op| format!("{op:?}") == name)
                    .copied()
                    .ok_or_else(|| CaseError::unhandled(function))?;
                let parameters = round_tripped(function, args.get(1))?
                    .and_then(|value| value.as_object().cloned())
                    .ok_or_else(|| CaseError::unhandled(function))?;
                let req = OpenCodeSdkClient::new(BASE_URL).build_request(operation, parameters);
                Ok(json!({
                    "method": req.method.as_str(),
                    "target": req.url.strip_prefix(BASE_URL).expect("target under the fixture base"),
                    "contentType": req.body.as_ref().map(|_| "application/json"),
                    "body": req.body.map(|bytes| String::from_utf8(bytes).expect("JSON bytes")),
                }))
            },
        );
    }

    #[tokio::test]
    async fn transport_sends_scoped_prompt_with_encoded_path_and_ordered_body() {
        let (client, received) = serve_once(
            "200 OK",
            Some("application/json"),
            r#"{"info":{"id":"assistant"}}"#,
        )
        .await;
        let response = client
            .request(
                OpenCodeRequest::SessionPrompt,
                parameters(json!({
                    "sessionID": "session/a?#%",
                    "parts": [{"type":"text","text":"sample"}],
                    "ignored": "not a request field",
                    "variant": "high",
                    "directory": "/repo a",
                })),
                &AbortSignal::new(),
            )
            .await
            .expect("prompt response");
        let request = received.await.expect("observed request");
        let (headers, body) = request.split_once("\r\n\r\n").expect("request framing");
        assert_eq!(
            headers.lines().next(),
            Some("POST /session/session%2Fa%3F%23%25/message?directory=%2Frepo%20a HTTP/1.1")
        );
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("content-type: application/json")
        );
        assert_eq!(
            body,
            r#"{"parts":[{"type":"text","text":"sample"}],"variant":"high"}"#
        );
        assert_eq!(response["data"]["info"]["id"], "assistant");
        assert_eq!(response["response"]["status"], 200);
    }

    #[tokio::test]
    async fn transport_preserves_an_error_body_and_omits_body_and_content_type_for_fork_without_anchor()
     {
        let (client, received) = serve_once(
            "404 Not Found",
            Some("application/json"),
            r#"{"name":"NotFoundError","data":{"message":"session missing"}}"#,
        )
        .await;
        let response = client
            .request(
                OpenCodeRequest::SessionFork,
                parameters(json!({"sessionID": "source"})),
                &AbortSignal::new(),
            )
            .await
            .expect("SDK reports the refused response");
        let request = received.await.expect("observed request");
        assert!(request.starts_with("POST /session/source/fork HTTP/1.1\r\n"));
        assert!(!request.to_ascii_lowercase().contains("content-type:"));
        assert!(request.ends_with("\r\n\r\n"));
        assert_eq!(response["error"]["name"], "NotFoundError");
        assert_eq!(response["error"]["data"]["message"], "session missing");
        assert_eq!(response["response"]["status"], 404);
    }

    #[tokio::test]
    async fn transport_rejects_exact_html_content_type_before_decoding() {
        let (client, received) = serve_once("200 OK", Some("text/html"), "<html>").await;
        let failure = client
            .request(
                OpenCodeRequest::ConfigProviders,
                Map::new(),
                &AbortSignal::new(),
            )
            .await
            .expect_err("SDK rejects HTML");
        assert_eq!(
            failure.to_string(),
            "Request is not supported by this version of OpenCode Server (Server responded with text/html)"
        );
        assert!(
            received
                .await
                .expect("observed request")
                .starts_with("GET /config/providers HTTP/1.1\r\n")
        );
    }

    #[tokio::test]
    async fn global_stream_filters_sync_and_publishes_only_after_connected() {
        let body = concat!(
            ": comment\n\n",
            "data: {\"payload\":{\"type\":\"sync\"}}\n\n",
            "data: {\"payload\":{\"type\":\"server.connected\"}}\n\n",
            "id: wire-id\ndata: {\"payload\":\ndata: {\"type\":\"session.status\",\"id\":\"payload-id\"}}\n\n",
            "data: {\"payload\":{\"type\":\"incomplete\"}}",
        );
        let (client, received) = serve_once("200 OK", Some("text/event-stream"), body).await;
        let connected = Rc::new(Cell::new(0));
        let mut events = stream_global_events(&client, &AbortSignal::new(), {
            let connected = connected.clone();
            move || connected.set(connected.get() + 1)
        })
        .await
        .expect("open global stream");
        assert_eq!(connected.get(), 0);
        let event = events
            .next()
            .await
            .expect("routed event")
            .expect("session status");
        assert_eq!(connected.get(), 1);
        assert_eq!(event.kind, "session.status");
        assert_eq!(event.id.as_deref(), Some("payload-id"));
        assert_eq!(
            events
                .next()
                .await
                .expect("EOF error")
                .expect_err("EOF fails")
                .to_string(),
            "OpenCode event stream ended"
        );
        assert!(events.next().await.is_none());
        assert!(
            received
                .await
                .expect("observed request")
                .starts_with("GET /global/event HTTP/1.1\r\n")
        );
    }

    #[tokio::test]
    async fn valid_global_event_before_connected_fails_the_stream() {
        let (client, received) = serve_once(
            "200 OK",
            Some("text/event-stream"),
            "data: {\"payload\":{\"type\":\"session.status\"}}\n\n",
        )
        .await;
        let mut events = stream_global_events(&client, &AbortSignal::new(), || {
            panic!("unexpected connected callback")
        })
        .await
        .expect("open global stream");
        assert_eq!(
            events
                .next()
                .await
                .expect("event error")
                .expect_err("event before connected")
                .to_string(),
            "OpenCode event stream emitted session.status before server.connected"
        );
        received.await.expect("observed request");
    }

    #[tokio::test]
    async fn sdk_preserves_false_blank_line_at_a_crlf_chunk_boundary() {
        let before: &[u8] = b"data: {\"payload\":\r";
        let after: &[u8] = b"\ndata: {\"type\":\"server.connected\"}}\r\n\r\n";
        let chunks = futures::stream::iter([Ok::<_, std::io::Error>(before), Ok(after)]);
        let mut events = read_sdk_events(chunks, AbortSignal::new());
        assert_eq!(
            events
                .next()
                .await
                .expect("false frame")
                .expect("raw invalid JSON"),
            r#"{"payload":"#
        );
        assert_eq!(
            events
                .next()
                .await
                .expect("second frame")
                .expect("raw invalid JSON"),
            r#"{"type":"server.connected"}}"#
        );
        assert!(events.next().await.is_none());
    }
}
