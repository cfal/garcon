//! Ports `server/remote/transport/connection-url.ts`.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use garcon_base::domain_error::DomainError;
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use serde_json::Value;
use url::{Url, form_urlencoded};

pub use garcon_contract::executors::is_executor_secret;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionUrl {
    pub socket_url: String,
    pub secret: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ExecutorSocketUrlOptions {
    pub no_tls: bool,
    pub allow_placeholder: bool,
}

pub fn create_executor_secret() -> String {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn parse_connection_url(value: &str) -> Result<ConnectionUrl, DomainError> {
    let invalid_url = || DomainError::new_validation("Invalid executor connection URL");
    let invalid_credential =
        || DomainError::new_validation("Invalid executor connection credential");
    let mut url = Url::parse(value).map_err(|_| invalid_url())?;
    if !matches!(url.scheme(), "ws" | "wss") || has_credentials(&url) {
        return Err(invalid_url());
    }
    let mut params = form_urlencoded::parse(url.fragment().unwrap_or_default().as_bytes());
    let (name, secret) = params.next().ok_or_else(invalid_credential)?;
    let secret = Value::String(secret.into_owned());
    if params.next().is_some() || name != "secret" || !is_executor_secret(&secret) {
        return Err(invalid_credential());
    }
    let Value::String(secret) = secret else {
        // INFALLIBLE: the credential was constructed as a string.
        unreachable!();
    };
    url.set_fragment(None);
    Ok(ConnectionUrl {
        socket_url: url.into(),
        secret,
    })
}

pub fn validate_executor_socket_url(
    value: &str,
    options: ExecutorSocketUrlOptions,
) -> Result<String, DomainError> {
    let url =
        Url::parse(value).map_err(|_| DomainError::new_validation("Invalid executor address"))?;
    if url.fragment().is_some_and(|value| !value.is_empty())
        || has_credentials(&url)
        || !(url.scheme() == "wss" || url.scheme() == "ws" && options.no_tls)
    {
        return Err(DomainError::new_validation(
            "Executor connections require TLS unless no-TLS mode is explicit",
        ));
    }
    if !options.allow_placeholder && matches!(url.host_str(), Some("0.0.0.0" | "[::]")) {
        return Err(DomainError::new_validation(
            "Replace the unspecified address with a reachable hostname or IP",
        ));
    }
    Ok(url.into())
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
#[error("Invalid URL")]
pub struct InvalidUrl {
    pub input: String,
}

pub fn executor_connection_url(socket_url: &str, secret: &str) -> Result<String, InvalidUrl> {
    let mut url = Url::parse(socket_url).map_err(|_| InvalidUrl {
        input: socket_url.to_owned(),
    })?;
    let hash = form_urlencoded::Serializer::new(String::new())
        .append_pair("secret", secret)
        .finish();
    url.set_fragment(Some(&hash));
    Ok(url.into())
}

fn has_credentials(url: &Url) -> bool {
    !url.username().is_empty() || url.password().is_some_and(|value| !value.is_empty())
}
