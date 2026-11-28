use std::path::{Path, PathBuf};
use std::process::Stdio;

use garcon_contract::chat_modes::ThinkingMode;
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, ChildStdout, Command};

use crate::direct::anthropic_compatible_chat_runtime::{
    AnthropicCompatibleChatProtocol, run_anthropic_compatible_single_query,
};
use crate::direct::direct_chat_runtime_base::{DirectChatProtocol, DirectStreamSession};
use crate::direct::openai_compatible_chat_runtime::{
    OpenAiCompatibleChatProtocol, run_open_ai_compatible_single_query,
};
use crate::direct::openai_compatible_responses_runtime::{
    OpenAiCompatibleResponsesProtocol, run_open_ai_responses_single_query,
};
use crate::direct::session_store::DirectResponsesCheckpointV1;
use crate::direct::single_query_options::DirectSingleQueryOptions;

use super::*;

const MODE: &str = "GARCON_DIRECT_PROVIDER_PROBE_MODE";
const ENDPOINT: &str = "GARCON_DIRECT_PROVIDER_PROBE_ENDPOINT";
const REJECT: &str = "GARCON_DIRECT_PROVIDER_PROBE_REJECT";
const REDIRECT_TARGET: &str = "GARCON_DIRECT_PROVIDER_PROBE_REDIRECT_ORIGIN";
const PROXY_VARS: &[&str] = &[
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];
const TRUST_VARS: &[&str] = &[
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
];

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Capture {
    request_line: String,
    fields: Vec<(String, String)>,
    body: String,
}

impl Capture {
    fn field(&self, name: &str) -> Option<&str> {
        self.fields
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    fn without_user_agent_value(&self) -> Self {
        let mut capture = self.clone();
        capture
            .fields
            .iter_mut()
            .find(|(name, _)| name == "user-agent")
            .unwrap()
            .1
            .clear();
        capture
    }

    fn assert_matches_original(&self, original: &Self, context: &str) {
        let manifest: serde_json::Value =
            garcon_js::json::from_str(include_str!("../../../../../package.json")).unwrap();
        let expected_user_agent = format!("Garcon/{}", manifest["version"].as_str().unwrap());
        assert_eq!(original.field("user-agent"), Some("Bun/1.4.3"));
        assert_eq!(self.field("user-agent"), Some(expected_user_agent.as_str()));
        assert_eq!(
            self.without_user_agent_value(),
            original.without_user_agent_value(),
            "{context}"
        );
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Started {
    base_url: String,
    answer: String,
    capture: Capture,
    target_origin: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Finished {
    capture_count: usize,
    same_origin_hops: usize,
}

struct Running {
    child: Child,
    stdout: Lines<BufReader<ChildStdout>>,
    first: Started,
}

async fn next<T: serde::de::DeserializeOwned>(stdout: &mut Lines<BufReader<ChildStdout>>) -> T {
    let line = tokio::time::timeout(Duration::from_secs(10), stdout.next_line())
        .await
        .unwrap()
        .unwrap()
        .expect("fake provider emitted wire evidence");
    garcon_js::json::from_str(&line).unwrap()
}

struct Certificates {
    key: PathBuf,
    cert: PathBuf,
    authority: PathBuf,
}

fn certificates(root: &Path) -> Certificates {
    let mut params = rcgen::CertificateParams::new(Vec::new()).unwrap();
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "Garcon provider fixture CA");
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign];
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let authority = params.self_signed(&ca_key).unwrap();
    let issuer = rcgen::Issuer::new(params, ca_key);
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["127.0.0.1".to_owned()])
        .unwrap()
        .signed_by(&key, &issuer)
        .unwrap();
    let files = Certificates {
        key: root.join("key.pem"),
        cert: root.join("cert.pem"),
        authority: root.join("ca.pem"),
    };
    std::fs::write(&files.key, key.serialize_pem()).unwrap();
    std::fs::write(&files.cert, cert.pem()).unwrap();
    std::fs::write(&files.authority, authority.pem()).unwrap();
    files
}

impl Running {
    async fn start(kind: &str, encoding: &str, root: &Path, tls: Option<&Certificates>) -> Self {
        let mut command = Command::new("bun");
        command
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/direct-provider-http.ts"
            ))
            .args([kind, encoding])
            .arg(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        for name in PROXY_VARS.iter().chain(TRUST_VARS) {
            command.env_remove(name);
        }
        if let Some(tls) = tls {
            command
                .args([&tls.cert, &tls.key])
                .env("NODE_EXTRA_CA_CERTS", &tls.authority);
        }
        let mut child = command.spawn().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        let first = next::<Started>(&mut stdout).await;
        assert_eq!(first.answer, "answer");
        Self {
            child,
            stdout,
            first,
        }
    }

    async fn shutdown(mut self) -> Finished {
        self.child.stdin.take();
        let finished = next(&mut self.stdout).await;
        let status = tokio::time::timeout(Duration::from_secs(5), self.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(status.success());
        finished
    }
}

async fn child_case(
    test: &str,
    provider: &Running,
    kind: &str,
    authority: Option<&Path>,
    reject: bool,
) {
    let mut command = child_command(test, kind, &provider.first.base_url);
    if let Some(authority) = authority {
        command.env("NODE_EXTRA_CA_CERTS", authority);
    }
    if reject {
        command.env(REJECT, "1");
    }
    run_child(command).await;
}

fn child_command(test: &str, mode: &str, endpoint: &str) -> Command {
    let mut command = Command::new(env::current_exe().unwrap());
    command
        .args(["--exact", test, "--test-threads=1", "--nocapture"])
        .env(MODE, mode)
        .env(ENDPOINT, endpoint)
        .kill_on_drop(true);
    for name in PROXY_VARS.iter().chain(TRUST_VARS) {
        command.env_remove(name);
    }
    command.env_remove(REJECT).env_remove(REDIRECT_TARGET);
    command
}

async fn run_child(mut command: Command) {
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
}

async fn maybe_run_child() -> bool {
    let Ok(kind) = env::var(MODE) else {
        return false;
    };
    let endpoint = env::var(ENDPOINT).unwrap();
    let result = query(&kind, endpoint.clone()).await;
    if let Ok(target) = env::var(REDIRECT_TARGET) {
        let error = result.unwrap_err();
        let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
        assert_eq!(error.code, AgentIntegrationErrorCode::PROVIDER_FAILURE);
        assert!(!error.retryable);
        let origin = endpoint.strip_suffix("/v1").unwrap();
        assert_eq!(
            error.message,
            format!("Provider endpoint redirected to another origin: {origin} to {target}.")
        );
        assert!(error.details.is_none());
    } else if env::var_os(REJECT).is_some() {
        let error = result.unwrap_err();
        assert!(error.is::<ProviderHttpError>(), "{error:?}");
    } else {
        assert_eq!(result.unwrap(), "answer");
    }
    true
}

async fn query(kind: &str, base_url: String) -> ExecutorResult<String> {
    let endpoint = ProviderHttpEndpoint {
        runtime_label: "Synthetic provider".into(),
        default_model: "fixture".into(),
        base_url,
        credential: Some("synthetic-token".into()),
    };
    let options = DirectSingleQueryOptions {
        model: String::new(),
        thinking_mode: ThinkingMode::Low,
        timeout_ms: Some(3000.0),
        signal: CancellationToken::new(),
    };
    let prompt = "hello".into();
    match kind {
        "chat" => {
            run_open_ai_compatible_single_query(
                &OpenAiCompatibleChatProtocol(endpoint),
                prompt,
                options,
            )
            .await
        }
        "responses" => {
            run_open_ai_responses_single_query(
                &OpenAiCompatibleResponsesProtocol {
                    endpoint,
                    endpoint_id: "fixture".into(),
                    endpoint_fingerprint: "a".repeat(64),
                },
                prompt,
                options,
            )
            .await
        }
        "messages" => {
            run_anthropic_compatible_single_query(
                &AnthropicCompatibleChatProtocol {
                    endpoint,
                    max_tokens: None,
                },
                prompt,
                options,
            )
            .await
        }
        _ => panic!("unknown synthetic provider"),
    }
}

#[tokio::test]
async fn matches_original_requests_and_all_compressed_sse_replies() {
    if maybe_run_child().await {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    for (mode, encoding) in [
        ("chat", "gzip"),
        ("chat", "deflate"),
        ("chat", "zstd"),
        ("responses", "identity"),
        ("messages", "br"),
    ] {
        let mut provider = Running::start(mode, encoding, root.path(), None).await;
        child_case("shared::provider_http::tests::matches_original_requests_and_all_compressed_sse_replies", &provider, mode, None, false).await;
        let actual = next::<Capture>(&mut provider.stdout).await;
        actual.assert_matches_original(&provider.first.capture, mode);
        assert_eq!(actual.field("accept"), Some("*/*"));
        assert_eq!(
            actual.field("accept-encoding"),
            Some("gzip, deflate, br, zstd")
        );
        assert_eq!(actual.field("connection"), Some("keep-alive"));
        provider.shutdown().await;
    }
}

#[tokio::test]
async fn verifies_private_ca_and_refuses_unknown_issuer() {
    if maybe_run_child().await {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let tls = certificates(root.path());
    let mut provider = Running::start("chat", "identity", root.path(), Some(&tls)).await;
    let test = "shared::provider_http::tests::verifies_private_ca_and_refuses_unknown_issuer";
    child_case(test, &provider, "chat", None, true).await;
    child_case(test, &provider, "chat", Some(&tls.authority), false).await;
    next::<Capture>(&mut provider.stdout)
        .await
        .assert_matches_original(&provider.first.capture, "private CA");
    provider.shutdown().await;
}

#[tokio::test]
async fn follows_same_origin_redirects_with_the_original_request() {
    if maybe_run_child().await {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    for (mode, kind, header, credential) in [
        (
            "same-chat",
            "chat",
            "authorization",
            "Bearer synthetic-token",
        ),
        ("same-messages", "messages", "x-api-key", "synthetic-token"),
    ] {
        let mut provider = Running::start(mode, "identity", root.path(), None).await;
        child_case(
            "shared::provider_http::tests::follows_same_origin_redirects_with_the_original_request",
            &provider,
            kind,
            None,
            false,
        )
        .await;
        let actual = next::<Capture>(&mut provider.stdout).await;
        actual.assert_matches_original(&provider.first.capture, mode);
        assert_eq!(actual.field(header), Some(credential));
        assert_eq!(
            provider.shutdown().await,
            Finished {
                capture_count: 2,
                same_origin_hops: 2
            }
        );
    }
}

#[tokio::test]
async fn refuses_cross_origin_redirects_before_sending_bearer_or_api_key_requests() {
    const TEST: &str = "shared::provider_http::tests::refuses_cross_origin_redirects_before_sending_bearer_or_api_key_requests";
    if maybe_run_child().await {
        return;
    }
    let root = tempfile::tempdir().unwrap();
    for (mode, kind, hops) in [
        ("cross-chat", "chat", 0),
        ("cross-messages", "messages", 0),
        ("chain-chat", "chat", 2),
    ] {
        let provider = Running::start(mode, "identity", root.path(), None).await;
        let mut command = child_command(TEST, kind, &provider.first.base_url);
        command.env(REDIRECT_TARGET, &provider.first.target_origin);
        run_child(command).await;
        assert_eq!(
            provider.shutdown().await,
            Finished {
                capture_count: 1,
                same_origin_hops: hops
            },
            "{mode}"
        );
    }
}

struct Request {
    line: String,
    headers: HeaderMap,
    body: Vec<u8>,
}

async fn take_request(socket: &mut TcpStream) -> Request {
    let mut reader = BufReader::new(socket);
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    let mut headers = HeaderMap::new();
    loop {
        let mut field = String::new();
        assert_ne!(reader.read_line(&mut field).await.unwrap(), 0);
        if field == "\r\n" {
            break;
        }
        let (name, value) = field.split_once(':').unwrap();
        headers.append(
            header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
            HeaderValue::from_str(value.trim()).unwrap(),
        );
    }
    let length = headers
        .get(header::CONTENT_LENGTH)
        .map_or(0, |value| value.to_str().unwrap().parse().unwrap());
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await.unwrap();
    Request {
        line: line.trim_end().into(),
        headers,
        body,
    }
}

const CHAT_OK: &str =
    "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\ndata: [DONE]\n\n";

async fn reply(socket: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(response.as_bytes()).await.unwrap();
    socket.shutdown().await.unwrap();
}

#[tokio::test]
async fn sends_bodyless_get_and_raw_bytes_with_the_shared_defaults() {
    const TEST: &str =
        "shared::provider_http::tests::sends_bodyless_get_and_raw_bytes_with_the_shared_defaults";
    if env::var_os(MODE).is_none() {
        run_child(child_command(TEST, "isolated", "")).await;
        return;
    }
    let manifest: serde_json::Value =
        garcon_js::json::from_str(include_str!("../../../../../package.json")).unwrap();
    let expected_user_agent = format!("Garcon/{}", manifest["version"].as_str().unwrap());
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let (observed, wait_for_event) = tokio::sync::oneshot::channel();
    let bytes = b"\0\xff\n";
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = take_request(&mut socket).await;
        assert_eq!(request.line, "GET /global/event HTTP/1.1");
        assert!(request.body.is_empty());
        assert_eq!(request.headers[USER_AGENT], expected_user_agent.as_str());
        assert_eq!(request.headers[ACCEPT], "text/event-stream");
        assert_eq!(request.headers[ACCEPT_ENCODING], "gzip, deflate, br, zstd");
        assert_eq!(request.headers[CONNECTION], "keep-alive");
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 16\r\nConnection: close\r\n\r\ndata: event\n\n").await.unwrap();
        wait_for_event.await.unwrap();
        socket.write_all(b":\n\n").await.unwrap();
        socket.shutdown().await.unwrap();

        let (mut socket, _) = listener.accept().await.unwrap();
        let request = take_request(&mut socket).await;
        assert_eq!(request.line, "PATCH /session HTTP/1.1");
        assert_eq!(request.body, bytes);
        assert_eq!(request.headers[CONTENT_TYPE], "application/octet-stream");
        reply(
            &mut socket,
            "202 Accepted",
            "application/json",
            r#"{"accepted":true}"#,
        )
        .await;
    });
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("text/event-stream"));
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static("not-the-release-agent"),
    );
    let response = send(
        Method::GET,
        &format!("{origin}/global/event"),
        headers,
        None,
    )
    .await
    .unwrap();
    let mut observed = Some(observed);
    read_sse(response, |data| {
        assert_eq!(data, "event");
        observed.take().unwrap().send(()).unwrap();
        Ok(())
    })
    .await
    .unwrap();

    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    let response = send(
        Method::PATCH,
        &format!("{origin}/session"),
        headers,
        Some(bytes.to_vec()),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap(),
        serde_json::json!({"accepted": true})
    );
    server.await.unwrap();
}

#[tokio::test]
async fn uses_absolute_http_targets_and_connect_for_https_and_honors_no_proxy() {
    const TEST: &str = "shared::provider_http::tests::uses_absolute_http_targets_and_connect_for_https_and_honors_no_proxy";
    if maybe_run_child().await {
        return;
    }
    let proxy = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut http, _) = proxy.accept().await.unwrap();
        let http_request = take_request(&mut http).await;
        reply(&mut http, "200 OK", "text/event-stream", CHAT_OK).await;
        let (mut https, _) = proxy.accept().await.unwrap();
        let https_request = take_request(&mut https).await;
        reply(&mut https, "502 Bad Gateway", "text/plain", "").await;
        (http_request.line, https_request.line)
    });
    let target = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let address = target.local_addr().unwrap();
    let http_url = format!("http://{address}/v1");
    let https_url = format!("https://{address}/v1");
    let mut http = child_command(TEST, "chat", &http_url);
    http.env("HTTP_PROXY", "http://127.0.0.1:0")
        .env("http_proxy", &proxy_url)
        .env("REQUEST_METHOD", "POST");
    run_child(http).await;
    let mut https = child_command(TEST, "chat", &https_url);
    https
        .env("https_proxy", "")
        .env("ALL_PROXY", &proxy_url)
        .env(REJECT, "1");
    run_child(https).await;
    let (http_line, https_line) = server.await.unwrap();
    assert_eq!(
        http_line,
        format!("POST {http_url}/chat/completions HTTP/1.1")
    );
    assert_eq!(https_line, format!("CONNECT {address} HTTP/1.1"));

    let direct = tokio::spawn(async move {
        let (mut socket, _) = target.accept().await.unwrap();
        let request = take_request(&mut socket).await;
        reply(&mut socket, "200 OK", "text/event-stream", CHAT_OK).await;
        request.line
    });
    let mut bypass = child_command(TEST, "chat", &http_url);
    bypass
        .env("ALL_PROXY", proxy_url)
        .env("NO_PROXY", address.to_string());
    run_child(bypass).await;
    assert_eq!(direct.await.unwrap(), "POST /v1/chat/completions HTTP/1.1");
}

#[tokio::test]
async fn cancels_or_times_out_after_receiving_sse_headers_and_data() {
    const TEST: &str =
        "shared::provider_http::tests::cancels_or_times_out_after_receiving_sse_headers_and_data";
    if env::var_os(MODE).is_none() {
        run_child(child_command(TEST, "isolated", "")).await;
        return;
    }
    for timeout in [false, true] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            take_request(&mut socket).await;
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 1000\r\n\r\ndata: partial\n\n").await.unwrap();
            assert_eq!(socket.read(&mut [0; 1]).await.unwrap(), 0);
        });
        let response = post_json(&url, json_headers(), &()).await.unwrap();
        let span = Duration::from_secs(5);
        let signal = CancellationToken::new();
        let (send, receive) = tokio::sync::oneshot::channel();
        let mut send = Some(send);
        let read = until_done(
            &signal,
            span,
            read_sse(response, |data| {
                assert_eq!(data, "partial");
                send.take().unwrap().send(()).unwrap();
                Ok(())
            }),
        );
        let trigger = async {
            receive.await.unwrap();
            if timeout {
                tokio::time::pause();
                tokio::time::advance(span).await;
                tokio::time::resume();
            } else {
                signal.cancel();
            }
        };
        let (result, ()) = tokio::join!(read, trigger);
        let error = result.unwrap_err();
        assert_eq!(
            error.downcast_ref::<NamedError>().unwrap().name,
            "AbortError"
        );
        assert_eq!(error.to_string(), "The operation was aborted.");
        server.await.unwrap();
    }
}

#[tokio::test]
async fn retries_an_unresolved_checkpoint_once_and_only_before_output() {
    use crate::direct::openai_compatible_responses_protocol::ResponsesRequestError;
    use serde_json::json;

    const TEST: &str = "shared::provider_http::tests::retries_an_unresolved_checkpoint_once_and_only_before_output";
    if env::var_os(MODE).is_none() {
        run_child(child_command(TEST, "isolated", "")).await;
        return;
    }
    const MISSING: (&str, &str, &str) = (
        "404 Not Found",
        "application/json",
        r#"{"error":{"code":"previous_response_not_found","message":"missing checkpoint"}}"#,
    );
    const PARTIAL: (&str, &str, &str) = (
        "200 OK",
        "text/event-stream",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\ndata: {\"type\":\"error\",\"error\":{\"code\":\"previous_response_not_found\",\"message\":\"lost after output\"}}\n\n",
    );
    const COMPLETED: (&str, &str, &str) = (
        "200 OK",
        "application/json",
        r#"{"status":"completed","id":"new-checkpoint","output_text":"complete"}"#,
    );

    for (replies, expected_error) in [
        (vec![MISSING, COMPLETED], None),
        (
            vec![MISSING, MISSING],
            Some((
                false,
                "Synthetic provider API error 404: missing checkpoint",
            )),
        ),
        (
            vec![PARTIAL],
            Some((true, "Synthetic provider stream error: lost after output")),
        ),
    ] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let protocol = OpenAiCompatibleResponsesProtocol {
            endpoint: ProviderHttpEndpoint {
                runtime_label: "Synthetic provider".into(),
                default_model: "fixture".into(),
                base_url: format!("http://{}/v1", listener.local_addr().unwrap()),
                credential: None,
            },
            endpoint_id: "fixture".into(),
            endpoint_fingerprint: "a".repeat(64),
        };
        let server = tokio::spawn(async move {
            let mut received = Vec::new();
            for (status, media_type, body) in replies {
                let (mut socket, _) = listener.accept().await.unwrap();
                let request = take_request(&mut socket).await;
                assert_eq!(request.line, "POST /v1/responses HTTP/1.1");
                received
                    .push(garcon_js::json::from_slice::<serde_json::Value>(&request.body).unwrap());
                reply(&mut socket, status, media_type, body).await;
            }
            received
        });
        let session = DirectStreamSession {
            model: "fixture".into(),
            thinking_mode: ThinkingMode::None,
            messages: [
                protocol.build_user_message("first", &[]),
                protocol.build_assistant_message("first answer"),
                protocol.build_user_message("second", &[]),
            ]
            .into(),
            previous_checkpoint: Some(DirectResponsesCheckpointV1 {
                response_id: "old-checkpoint".into(),
                endpoint_id: protocol.endpoint_id.clone(),
                endpoint_fingerprint: protocol.endpoint_fingerprint.clone(),
                model: "fixture".into(),
            }),
            signal: CancellationToken::new(),
        };
        let result = protocol.stream_session(session).await;
        if let Some((accepted, message)) = expected_error {
            let error = result.err().expect("checkpoint request failed");
            assert_eq!(error.to_string(), message);
            assert_eq!(
                error
                    .downcast_ref::<ResponsesRequestError>()
                    .unwrap()
                    .output_accepted,
                accepted
            );
        } else {
            let result = result.unwrap();
            assert_eq!(result.content, "complete");
            assert_eq!(result.checkpoint.unwrap().response_id, "new-checkpoint");
        }
        let received = server.await.unwrap();
        assert_eq!(
            received[0],
            json!({
                "model": "fixture", "input": [{"role": "user", "content": "second"}],
                "previous_response_id": "old-checkpoint", "stream": true, "store": true,
            })
        );
        if let Some(retry) = received.get(1) {
            assert_eq!(
                retry,
                &json!({
                    "model": "fixture", "input": [{"role": "user", "content": "first"},
                        {"role": "assistant", "content": "first answer"}, {"role": "user", "content": "second"}],
                    "previous_response_id": null, "stream": true, "store": true,
                })
            );
        }
    }
}

#[tokio::test]
async fn accepts_buffered_responses_and_redacts_invalid_json_but_not_provider_errors() {
    const TEST: &str = "shared::provider_http::tests::accepts_buffered_responses_and_redacts_invalid_json_but_not_provider_errors";
    if env::var_os(MODE).is_none() {
        run_child(child_command(TEST, "isolated", "")).await;
        return;
    }
    for (kind, json, partial, missing, stream_error) in [
        (
            "chat",
            r#"{"choices":[{"message":{"content":[{"text":"<think>not visible</think>"},{"text":"answer"}]}}]}"#,
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n",
            "stream ended before [DONE]",
            "data: {\"error\":{\"message\":\"provider failed\"}}\n\n",
        ),
        (
            "responses",
            r#"{"output":[{"content":[{"type":"output_text","text":"answer"}]}]}"#,
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
            "stream ended before response.completed.",
            "data: {\"type\":\"error\",\"error\":{\"message\":\"provider failed\"}}\n\n",
        ),
        (
            "messages",
            r#"{"content":[{"type":"thinking","thinking":"not visible"},{"type":"text","text":"answer"}]}"#,
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n",
            "stream ended before message_stop.",
            "data: {\"type\":\"error\",\"error\":{\"message\":\"provider failed\"}}\n\n",
        ),
    ] {
        let error_reply = format!("{partial}{stream_error}");
        for (media_type, payload, expected) in [
            ("application/json", json, Ok("answer".to_owned())),
            (
                "application/json",
                "invalid response with synthetic secret",
                Err("Synthetic provider response is not valid JSON.".to_owned()),
            ),
            (
                "text/event-stream",
                partial,
                Err(format!("Synthetic provider {missing}")),
            ),
            (
                "text/event-stream",
                error_reply.as_str(),
                Err("Synthetic provider stream error: provider failed".to_owned()),
            ),
        ] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let url = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = async {
                let (mut socket, _) = listener.accept().await.unwrap();
                take_request(&mut socket).await;
                reply(&mut socket, "200 OK", media_type, payload).await;
            };
            let (result, ()) = tokio::join!(query(kind, url), server);
            assert_eq!(
                result.map_err(|error| error.to_string()),
                expected,
                "{kind}"
            );
        }
    }
}
