//! Public addresses used to advertise executor connections.

use garcon_base::domain_error::DomainError;
use garcon_js::trim;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use url::{Position, Url};

pub fn parse_public_url(value: &str) -> Result<Url, DomainError> {
    let mut url = Url::parse(value).map_err(|_| {
        DomainError::new_validation("Public URL must be an absolute HTTP(S) base URL")
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some_and(|v| !v.is_empty())
        || url.query().is_some_and(|v| !v.is_empty())
        || url.fragment().is_some_and(|v| !v.is_empty())
        || contains_whitespace_or(value, "\\")
        || !url.host_str().is_some_and(is_reachable_host)
    {
        return Err(DomainError::new_validation(
            "Public URL must have a reachable HTTP(S) host and no credentials, query, or fragment",
        ));
    }
    let path = format!("{}/", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

pub fn request_public_url(
    incoming: &Url,
    host: Option<&str>,
    configured: Option<&str>,
    base_path: &str,
) -> Result<Url, DomainError> {
    if let Some(configured) = configured {
        return parse_public_url(configured);
    }
    let host = host.unwrap_or(&incoming[Position::BeforeHost..Position::AfterPort]);
    if host.is_empty() || contains_whitespace_or(host, "\\/@?#") {
        return Err(DomainError::new_validation(
            "Invalid public Host; configure --public-url",
        ));
    }
    parse_public_url(&format!("{}://{host}{base_path}/", incoming.scheme()))
}

pub fn executor_public_url(base: &str, id: &str) -> Result<Url, DomainError> {
    const COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    let mut url = parse_public_url(base)?
        .join(&format!("executor/{}", utf8_percent_encode(id, COMPONENT)))
        .map_err(|_| DomainError::new_validation("Invalid executor address"))?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme)
        .map_err(|()| DomainError::new_validation("Invalid executor address"))?;
    Ok(url)
}

fn contains_whitespace_or(value: &str, forbidden: &str) -> bool {
    let mut bytes = [0; 4];
    value.chars().any(|character| {
        forbidden.contains(character) || trim(character.encode_utf8(&mut bytes)).is_empty()
    })
}

fn is_reachable_host(host: &str) -> bool {
    if matches!(host, "" | "0.0.0.0" | "[::]" | "example.com") {
        return false;
    }
    if let Some(ipv6) = host
        .strip_prefix('[')
        .and_then(|text| text.strip_suffix(']'))
    {
        return !ipv6.is_empty()
            && ipv6
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || b":.".contains(&byte));
    }
    host.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, text};
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn public_url_matches_the_recorded_original() {
        replay(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/cases/executor-public-url"
            ),
            |function, args| {
                let text_arg = |index| {
                    text(function, args.get(index))?.ok_or_else(|| CaseError::unhandled(function))
                };
                let result = match function {
                    "parsePublicUrl" => parse_public_url(text_arg(0)?),
                    "executorPublicUrl" => executor_public_url(text_arg(0)?, text_arg(1)?),
                    "requestPublicUrlFixture" => {
                        let incoming =
                            Url::parse(text_arg(0)?).map_err(|_| CaseError::unhandled(function))?;
                        request_public_url(
                            &incoming,
                            args.get(1).and_then(Value::as_str),
                            args.get(2).and_then(Value::as_str),
                            text_arg(3)?,
                        )
                    }
                    _ => return Err(CaseError::unhandled(function)),
                };
                Ok(match result {
                    Ok(url) => json!(url.as_str()),
                    Err(error) => {
                        json!({"$":"error","name":error.kind.name(),"message":error.message,
                    "properties":{"code":error.code.as_str(),"status":error.status,"retryable":error.retryable}})
                    }
                })
            },
        );
    }
}
