//! JSON body and bearer token parsing shared by HTTP handlers.

use garcon_js::json;
use http::{HeaderMap, HeaderName, Request};
use http_body::Body;
use http_body_util::BodyExt;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Malformed JSON")]
pub struct MalformedJsonError;

#[derive(Debug, thiserror::Error)]
pub enum JsonBodyError<E> {
    #[error(transparent)]
    Malformed(#[from] MalformedJsonError),
    #[error(transparent)]
    Read(E),
}

fn is_json_content_type(content_type: &str) -> bool {
    content_type.to_lowercase().contains("application/json")
}

/// Fetch Headers.get trims each byte-string value and joins duplicate lines.
pub fn fetch_header_value(headers: &HeaderMap, name: &HeaderName) -> Option<String> {
    let all = headers.get_all(name);
    let mut values = all.iter();
    let first = values.next()?;
    let mut output: String = first
        .as_bytes()
        .trim_ascii()
        .iter()
        .copied()
        .map(char::from)
        .collect();
    for value in values {
        output.push_str(", ");
        output.extend(
            value
                .as_bytes()
                .trim_ascii()
                .iter()
                .copied()
                .map(char::from),
        );
    }
    Some(output)
}

fn parse_text(text: &str) -> Result<Value, MalformedJsonError> {
    if text.is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    json::parse(text).map_err(|_| MalformedJsonError)
}

/// Parses an already decoded string body. Bun's string-backed Request.text
/// preserves a leading BOM, while a network byte body strips it on decoding.
pub fn parse_json_text_body(
    content_type: Option<&str>,
    text: &str,
) -> Result<Value, MalformedJsonError> {
    if content_type.is_some_and(is_json_content_type) {
        parse_text(text)
    } else {
        Ok(Value::Object(Default::default()))
    }
}

pub async fn parse_json_body<B>(request: Request<B>) -> Result<Value, JsonBodyError<B::Error>>
where
    B: Body,
    B::Data: bytes::Buf,
{
    let content_type = fetch_header_value(request.headers(), &http::header::CONTENT_TYPE);
    if !content_type.as_deref().is_some_and(is_json_content_type) {
        return Ok(Value::Object(Default::default()));
    }
    let body = request
        .into_body()
        .collect()
        .await
        .map_err(JsonBodyError::Read)?
        .to_bytes();
    let body = body.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&body);
    Ok(parse_text(&String::from_utf8_lossy(body))?)
}

pub fn get_token_from_request<B>(request: &Request<B>) -> Option<String> {
    let header = fetch_header_value(request.headers(), &http::header::AUTHORIZATION)?;
    header.strip_prefix("Bearer ").map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use http_body_util::Full;
    use serde_json::json;

    #[tokio::test]
    async fn only_reads_json_media_and_distinguishes_empty_from_malformed() {
        for (media_type, body, expected) in [
            ("text/plain", "[not json", json!({})),
            ("application/problem+json", "[not json", json!({})),
            (
                "APPLICATION/JSON; charset=utf-8",
                "\u{feff}[1,null]",
                json!([1.0, null]),
            ),
            ("application/json", "", json!({})),
            ("application/json", "null", Value::Null),
            ("application/json", r#""\ud800""#, json!("\u{fffd}")),
        ] {
            let request = Request::builder()
                .header("content-type", media_type)
                .body(Full::new(Bytes::from_static(body.as_bytes())))
                .unwrap();
            assert_eq!(parse_json_body(request).await.unwrap(), expected);
        }
        let request = Request::builder()
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from_static(b" \r\n ")))
            .unwrap();
        assert!(matches!(
            parse_json_body(request).await,
            Err(JsonBodyError::Malformed(_))
        ));
    }

    #[test]
    fn recognizes_only_the_exact_bearer_prefix() {
        for (header, expected) in [
            ("Bearer fixture-token", Some("fixture-token")),
            ("Bearer ", None),
            ("Bearer  fixture-token", Some(" fixture-token")),
            ("bearer fixture-token", None),
        ] {
            let request = Request::builder()
                .header("authorization", header)
                .body(())
                .unwrap();
            assert_eq!(get_token_from_request(&request).as_deref(), expected);
        }
    }
}
