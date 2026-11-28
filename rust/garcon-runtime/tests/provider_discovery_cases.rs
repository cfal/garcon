use std::{io, time::Duration};

use garcon_base::errors::NamedError;
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::api_providers::{ApiProtocol, ModelDiscoveryKind};
use garcon_interface::{
    execution_runtime::ApiProviderDiscoveryRequest,
    resources::{ExecutorCallOptions, ExecutorResult},
};
use garcon_runtime::providers::discovery::discover_api_provider_models;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Selection {
    protocol: ApiProtocol,
    path: String,
    api_key: Option<String>,
    model_discovery: ModelDiscoveryKind,
}

#[derive(Deserialize)]
struct Reply {
    status: Option<u16>,
    body: Option<Value>,
    raw: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Call {
    path: String,
    authorization: Option<String>,
    api_key: Option<String>,
    anthropic_version: Option<String>,
}

async fn read_call(socket: &mut TcpStream) -> io::Result<Call> {
    let mut lines = BufReader::new(socket).lines();
    let first = lines.next_line().await?.unwrap_or_default();
    let mut parts = first.split_whitespace();
    assert_eq!(parts.next(), Some("GET"));
    let mut call = Call {
        path: parts.next().unwrap().into(),
        authorization: None,
        api_key: None,
        anthropic_version: None,
    };
    while let Some(line) = lines.next_line().await? {
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').unwrap();
        let destination = match name.to_ascii_lowercase().as_str() {
            "authorization" => &mut call.authorization,
            "x-api-key" => &mut call.api_key,
            "anthropic-version" => &mut call.anthropic_version,
            _ => continue,
        };
        *destination = Some(value.trim().into());
    }
    Ok(call)
}

async fn serve_case(selection: Selection, replies: Vec<Reply>) -> ExecutorResult<Value> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let request = ApiProviderDiscoveryRequest {
        protocol: selection.protocol,
        base_url: format!("http://{}{}", listener.local_addr()?, selection.path),
        api_key: selection.api_key,
        model_discovery: selection.model_discovery,
    };
    let stop = CancellationToken::new();
    let server = tokio::spawn({
        let stop = stop.clone();
        async move {
            let mut calls = Vec::new();
            let mut replies = replies.into_iter();
            loop {
                let (mut socket, _) = tokio::select! {
                    biased;
                    () = stop.cancelled() => break,
                    accepted = listener.accept() => accepted?,
                };
                calls.push(read_call(&mut socket).await?);
                let (status, body) = replies.next().map_or((500, String::new()), |reply| {
                    (
                        reply.status.unwrap_or(200),
                        reply.raw.unwrap_or_else(|| {
                            garcon_js::json::stringify(&reply.body.unwrap_or(Value::Null))
                        }),
                    )
                });
                socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await?;
            }
            Ok::<_, io::Error>(calls)
        }
    });
    let result = discover_api_provider_models(request, None).await;
    stop.cancel();
    let calls = server.await??;
    Ok(json!({"result":result?,"calls":calls}))
}

async fn discover_at_zero_timeout(model_discovery: ModelDiscoveryKind) -> ExecutorResult<Value> {
    // A listener that does not respond makes the deadline independent of HTTP latency.
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let result = discover_api_provider_models(
        ApiProviderDiscoveryRequest {
            protocol: ApiProtocol::OpenAiCompatible,
            base_url: format!("http://{}", listener.local_addr()?),
            api_key: None,
            model_discovery,
        },
        Some(ExecutorCallOptions {
            timeout_ms: Some(0.0),
            ..Default::default()
        }),
    )
    .await?;
    Ok(serde_json::to_value(result)?)
}

#[test]
fn replays_discovery_against_the_original_http_probes() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/provider-discovery"
        ),
        |function, args| {
            let input = |index| unknown(function, args.get(index));
            fn decode<T: DeserializeOwned>(value: &Value) -> Result<T, CaseError> {
                garcon_js::json::from_str(&garcon_js::json::stringify(value))
                    .map_err(|error| CaseError::undeliverable(error.to_string()))
            }
            runtime
                .block_on(async {
                    timeout(Duration::from_secs(12), async {
                        let result = match function {
                            "discoverModels" => {
                                serve_case(decode(input(0)?.as_ref())?, decode(input(1)?.as_ref())?)
                                    .await
                            }
                            "discoverAtZeroTimeout" => {
                                discover_at_zero_timeout(decode(input(0)?.as_ref())?).await
                            }
                            "discoverApiProviderModels" => {
                                discover_api_provider_models(decode(input(0)?.as_ref())?, None)
                                    .await
                                    .and_then(|result| Ok(serde_json::to_value(result)?))
                            }
                            _ => return Err(CaseError::unhandled(function)),
                        };
                        result.map_err(|error| CaseError::undeliverable(error.to_string()))
                    })
                    .await
                })
                .map_err(|error| CaseError::undeliverable(error.to_string()))?
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}

#[tokio::test]
async fn deadline_and_cancellation_interrupt_an_outstanding_response_body() {
    for (expired, expected) in [
        (true, "The operation timed out."),
        (false, "The operation was aborted."),
    ] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let signal = CancellationToken::new();
        let serve = async {
            let (mut socket, _) = listener.accept().await.unwrap();
            assert_eq!(read_call(&mut socket).await.unwrap().path, "/v1/models");
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{\"data\": [")
                .await
                .unwrap();
            if expired {
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(5)).await;
                tokio::time::resume();
            } else {
                signal.cancel();
            }
            socket
        };
        let discover = discover_api_provider_models(
            ApiProviderDiscoveryRequest {
                protocol: ApiProtocol::OpenAiCompatible,
                base_url: format!("http://{address}"),
                api_key: None,
                model_discovery: ModelDiscoveryKind::OpenAiModels,
            },
            Some(ExecutorCallOptions {
                timeout_ms: Some(5_000.0),
                signal: Some(signal.clone()),
                ..Default::default()
            }),
        );
        let (result, _socket) = timeout(Duration::from_secs(6), async {
            tokio::join!(discover, serve)
        })
        .await
        .unwrap();
        let result = result.unwrap();
        assert!(!result.success);
        assert_eq!(result.error.as_deref(), Some(expected));
    }
}

#[tokio::test]
async fn validates_the_timeout_before_starting_any_discovery() {
    let no_discovery = || ApiProviderDiscoveryRequest {
        protocol: ApiProtocol::OpenAiCompatible,
        base_url: String::new(),
        api_key: None,
        model_discovery: ModelDiscoveryKind::None,
    };
    let options = |delay| {
        Some(ExecutorCallOptions {
            timeout_ms: Some(delay),
            ..Default::default()
        })
    };
    for (delay, text) in [
        (-1.0, "-1"),
        (f64::NAN, "NaN"),
        (f64::INFINITY, "Infinity"),
        (9_007_199_254_740_992.0, "9007199254740992"),
    ] {
        let error = discover_api_provider_models(no_discovery(), options(delay))
            .await
            .unwrap_err();
        let error = error.downcast_ref::<NamedError>().unwrap();
        assert_eq!(error.name, "TypeError");
        assert_eq!(
            error.message,
            format!("Value {text} is outside the range [0, 9007199254740991]")
        );
    }
    let result = discover_api_provider_models(no_discovery(), options(-0.5))
        .await
        .unwrap();
    assert!(result.success);

    let signal = CancellationToken::new();
    signal.cancel();
    let cancelled = discover_api_provider_models(
        no_discovery(),
        Some(ExecutorCallOptions {
            timeout_ms: Some(0.0),
            signal: Some(signal),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        cancelled.error.as_deref(),
        Some("The operation was aborted.")
    );
}
