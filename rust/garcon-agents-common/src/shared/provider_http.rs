//! The fetch adapter for direct provider requests.

use std::env;
use std::error::Error;
use std::future::Future;
use std::io;
use std::time::Duration;

use garcon_base::errors::NamedError;
use garcon_base::tls_roots::verified_client_config;
use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::resources::ExecutorResult;
use reqwest::{
    Client, Response, StatusCode,
    header::{
        ACCEPT, ACCEPT_ENCODING, CONNECTION, CONTENT_TYPE, HeaderMap, HeaderValue, USER_AGENT,
    },
};
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;
use tokio_util::sync::CancellationToken;

use super::provider_proxy::ProviderProxy;

static CLIENT: OnceCell<Client> = OnceCell::const_new();

#[derive(Clone)]
pub struct ProviderHttpEndpoint {
    pub runtime_label: String,
    pub default_model: String,
    pub base_url: String,
    pub credential: Option<String>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
struct ProviderHttpError {
    message: &'static str,
    #[source]
    cause: reqwest::Error,
}

fn client_error(error: reqwest::Error) -> Box<dyn Error> {
    if let Some(blocked) = std::iter::successors(error.source(), |&cause| cause.source())
        .find_map(|cause| cause.downcast_ref::<AgentIntegrationError>())
    {
        return Box::new(blocked.clone());
    }
    let socket_error = std::iter::successors(error.source(), |&cause| cause.source())
        .find_map(|cause| cause.downcast_ref::<io::Error>());
    let message = if socket_error
        .is_some_and(|cause| cause.kind() == io::ErrorKind::ConnectionRefused)
    {
        "ECONNREFUSED: Unable to connect. Is the computer able to access the url?"
    } else if error.is_body()
        || socket_error.is_some_and(|cause| cause.kind() == io::ErrorKind::ConnectionReset)
    {
        "ECONNRESET: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"
    } else if error.is_connect() {
        "Unable to connect. Is the computer able to access the url?"
    } else if error.is_timeout() {
        "The operation timed out."
    } else {
        "The network connection was lost."
    };
    ProviderHttpError {
        message,
        cause: error.without_url(),
    }
    .into()
}

fn redirect_policy() -> reqwest::redirect::Policy {
    let original_limit = reqwest::redirect::Policy::limited(20);
    reqwest::redirect::Policy::custom(move |attempt| {
        if let Some(original) = attempt.previous().first() {
            let from = original.origin();
            let to = attempt.url().origin();
            if from != to {
                return attempt.error(AgentIntegrationError::new(
                    AgentIntegrationErrorCode::PROVIDER_FAILURE,
                    format!(
                        "Provider endpoint redirected to another origin: {} to {}.",
                        from.ascii_serialization(),
                        to.ascii_serialization(),
                    ),
                    false,
                    None,
                ));
            }
        }
        original_limit.redirect(attempt)
    })
}

fn create_client() -> Result<Client, Box<dyn Error + Send + Sync>> {
    #[derive(Deserialize)]
    struct Release {
        version: String,
    }
    let release: Release = garcon_js::json::from_str(include_str!("../../../../package.json"))?;
    let mut tls = verified_client_config()?;
    tls.alpn_protocols = vec![b"http/1.1".to_vec()];
    let proxy = ProviderProxy::from_lookup(|key| env::var(key).ok());
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_str(&format!("Garcon/{}", release.version))?,
    );
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    headers.insert(
        ACCEPT_ENCODING,
        HeaderValue::from_static("gzip, deflate, br, zstd"),
    );
    headers.insert(CONNECTION, HeaderValue::from_static("keep-alive"));
    Ok(Client::builder()
        .use_preconfigured_tls(tls)
        .http1_only()
        .no_proxy()
        .proxy(reqwest::Proxy::custom(move |url| proxy.for_url(url)))
        .default_headers(headers)
        .referer(false)
        .retry(reqwest::retry::never())
        .redirect(redirect_policy())
        .build()?)
}

pub async fn post_json(
    url: &str,
    headers: HeaderMap,
    request: &impl Serialize,
) -> ExecutorResult<Response> {
    let client = CLIENT
        .get_or_try_init(|| async {
            tokio::task::spawn_blocking(create_client)
                .await?
                .map_err(|error| -> Box<dyn Error> { error })
        })
        .await?;
    let body = serde_json::to_vec(request)?;
    client
        .post(url)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(client_error)
}

pub fn json_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers
}

pub fn sensitive_header(text: &str) -> ExecutorResult<HeaderValue> {
    let mut value = HeaderValue::from_str(text)?;
    value.set_sensitive(true);
    Ok(value)
}

pub fn content_type(response: &Response) -> Option<String> {
    let values = response.headers().get_all(CONTENT_TYPE);
    let mut entries = values
        .iter()
        .map(|value| String::from_utf8_lossy(value.as_bytes()));
    let mut result = entries.next()?.trim().to_owned();
    for entry in entries {
        result.push_str(", ");
        result.push_str(entry.trim());
    }
    Some(result)
}

pub fn response_has_body(status: StatusCode) -> bool {
    !matches!(status.as_u16(), 101 | 204 | 205 | 304)
}

pub async fn text_body(response: Response) -> ExecutorResult<String> {
    let bytes = response.bytes().await.map_err(client_error)?;
    Ok(String::from_utf8_lossy(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes)).into_owned())
}

pub async fn read_sse(
    response: Response,
    on_data: impl FnMut(&str) -> ExecutorResult<()>,
) -> ExecutorResult<()> {
    use futures::TryStreamExt;
    let stream = response.bytes_stream().map_err(client_error);
    super::sse::read_sse_data_events(Box::pin(stream), on_data).await
}

pub async fn until_done<T>(
    signal: &CancellationToken,
    timeout: Duration,
    work: impl Future<Output = ExecutorResult<T>>,
) -> ExecutorResult<T> {
    let aborted = || {
        NamedError {
            name: "AbortError".into(),
            message: "The operation was aborted.".into(),
            code: None,
        }
        .into()
    };
    tokio::select! {
        biased;
        () = signal.cancelled() => Err(aborted()),
        () = tokio::time::sleep(timeout) => Err(aborted()),
        result = work => result,
    }
}

#[cfg(test)]
mod tests;
