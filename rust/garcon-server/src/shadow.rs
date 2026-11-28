//! Shadow comparison of native responses against the original.
//!
//! With `GARCON_RS_SHADOW_LOG` set, every request a native unit serves is also
//! sent to the original before the native response is returned, and the two
//! responses are compared on status, contract headers, and decoded body. Each
//! comparison appends one line to the log: `match` or `diverge` with the first
//! differing field and, for bodies, the byte offset where they first differ and
//! both lengths, so divergences that share a cause group together.
//!
//! Only natively served requests are shadowed; the units serve idempotent
//! reads, so sending them twice has no effect on the original.

use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::header::{CONTENT_ENCODING, HeaderMap};
use hyper::http::uri::Authority;
use hyper::{Method, Request, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

use crate::compression::{Encoding, NativeResponse, header};
use crate::line_log::LineLog;
use crate::proxy::{no_delay_connector, remove_hop_by_hop, target_uri};

/// Headers compared between the two responses, as sent. `Content-Length` is
/// also compared when the body is not compressed, since compressed lengths
/// depend on the encoder.
const COMPARED_HEADERS: [&str; 10] = [
    "accept-ranges",
    "cache-control",
    "content-disposition",
    "content-encoding",
    "content-range",
    "content-type",
    "etag",
    "last-modified",
    "location",
    "vary",
];

pub struct Shadow {
    client: Client<HttpConnector, Empty<Bytes>>,
    authority: Authority,
    log: LineLog,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Divergence {
    pub field: String,
    pub detail: String,
}

fn diverge(field: impl Into<String>, detail: String) -> Divergence {
    Divergence {
        field: field.into(),
        detail,
    }
}

fn decoded_body(side: &str, headers: &HeaderMap, body: &[u8]) -> Result<Vec<u8>, Divergence> {
    match header(headers, CONTENT_ENCODING).and_then(Encoding::from_token) {
        Some(encoding) => encoding.decode(body).map_err(|error| {
            diverge(
                "body",
                format!("{side} undecodable {encoding:?} body: {error}"),
            )
        }),
        None => Ok(body.to_vec()),
    }
}

fn first_divergence(
    method: &Method,
    native: &NativeResponse,
    original_status: u16,
    original_headers: &HeaderMap,
    original_body: &[u8],
) -> Result<(), Divergence> {
    if native.status.as_u16() != original_status {
        return Err(diverge(
            "status",
            format!(
                "native={} original={original_status}",
                native.status.as_u16()
            ),
        ));
    }
    let uncompressed = !native.headers.contains_key(CONTENT_ENCODING);
    let compared = COMPARED_HEADERS
        .into_iter()
        .chain(uncompressed.then_some("content-length"));
    for name in compared {
        let (left, right) = (
            header(&native.headers, name),
            header(original_headers, name),
        );
        if left != right {
            return Err(diverge(
                format!("header:{name}"),
                format!("native={left:?} original={right:?}"),
            ));
        }
    }
    if method == Method::HEAD {
        return Ok(());
    }
    let native_body = decoded_body("native", &native.headers, &native.body)?;
    let original_body = decoded_body("original", original_headers, original_body)?;
    if native_body == original_body {
        return Ok(());
    }
    let offset = native_body
        .iter()
        .zip(&original_body)
        .position(|(left, right)| left != right)
        .unwrap_or_else(|| native_body.len().min(original_body.len()));
    Err(diverge(
        "body",
        format!(
            "first-difference={offset} native-length={} original-length={}",
            native_body.len(),
            original_body.len()
        ),
    ))
}

/// Compares a native response, framed as it is sent, with the original's
/// answer to the same request.
pub fn compare(
    method: &Method,
    native: &NativeResponse,
    original_status: u16,
    original_headers: &HeaderMap,
    original_body: &[u8],
) -> Option<Divergence> {
    first_divergence(
        method,
        native,
        original_status,
        original_headers,
        original_body,
    )
    .err()
}

impl Shadow {
    pub fn open(path: &std::path::Path, authority: Authority) -> std::io::Result<Self> {
        Ok(Self {
            client: Client::builder(TokioExecutor::new()).build(no_delay_connector()),
            authority,
            log: LineLog::open(path)?,
        })
    }

    /// Sends the request to the original and records whether its answer
    /// matches the native response.
    pub async fn check(
        &self,
        method: &Method,
        uri: &Uri,
        headers: &HeaderMap,
        native: &NativeResponse,
    ) {
        let outcome = async {
            let target =
                target_uri(&self.authority, uri).ok_or("unparseable target".to_string())?;
            let mut request = Request::new(Empty::new());
            *request.method_mut() = method.clone();
            *request.uri_mut() = target;
            *request.headers_mut() = headers.clone();
            remove_hop_by_hop(request.headers_mut());
            let response = self
                .client
                .request(request)
                .await
                .map_err(|error| error.to_string())?;
            let (parts, body) = response.into_parts();
            let body = body
                .collect()
                .await
                .map_err(|error| error.to_string())?
                .to_bytes();
            Ok::<_, String>(compare(
                method,
                native,
                parts.status.as_u16(),
                &parts.headers,
                &body,
            ))
        }
        .await;
        let path = uri.path();
        self.log.record(&match outcome {
            Ok(None) => format!("match\t{method}\t{path}"),
            Ok(Some(divergence)) => format!(
                "diverge\t{method}\t{path}\t{}\t{}",
                divergence.field, divergence.detail
            ),
            Err(error) => format!("error\t{method}\t{path}\t{error}"),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::StatusCode;
    use hyper::header::{CONTENT_LENGTH, CONTENT_TYPE, HeaderValue};
    use std::io::Write;

    fn native(body: &'static [u8], encoding: Option<&'static str>) -> NativeResponse {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        if let Some(encoding) = encoding {
            headers.insert(CONTENT_ENCODING, HeaderValue::from_static(encoding));
        }
        NativeResponse {
            status: StatusCode::OK,
            headers,
            body: Bytes::from_static(body),
        }
        .framed()
    }

    fn original_headers(length: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static(length));
        headers
    }

    #[test]
    fn matches_identical_responses() {
        assert_eq!(
            compare(
                &Method::GET,
                &native(b"hello", None),
                200,
                &original_headers("5"),
                b"hello"
            ),
            None
        );
    }

    #[test]
    fn fingerprints_body_differences_by_offset_and_length() {
        let divergence = compare(
            &Method::GET,
            &native(b"hello", None),
            200,
            &original_headers("6"),
            b"help!!",
        )
        .unwrap();
        assert_eq!(divergence.field, "header:content-length");
        let divergence = compare(
            &Method::GET,
            &native(b"hello", None),
            200,
            &original_headers("5"),
            b"help!",
        )
        .unwrap();
        assert_eq!(divergence.field, "body");
        assert_eq!(
            divergence.detail,
            "first-difference=3 native-length=5 original-length=5"
        );
    }

    #[test]
    fn compares_decoded_bodies_across_encoders() {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        encoder.write_all(b"same content").unwrap();
        let compressed: &'static [u8] = Box::leak(encoder.finish().unwrap().into_boxed_slice());
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        headers.insert(CONTENT_ENCODING, HeaderValue::from_static("zstd"));
        let zstd = ruzstd::encoding::compress_to_vec(
            &b"same content"[..],
            ruzstd::encoding::CompressionLevel::Fastest,
        );
        assert_eq!(
            compare(
                &Method::GET,
                &native(compressed, Some("gzip")),
                200,
                &headers,
                &zstd
            )
            .map(|d| d.field),
            Some("header:content-encoding".to_string())
        );
        let mut gzip_headers = headers.clone();
        gzip_headers.insert(CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        let mut other = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        other.write_all(b"same content").unwrap();
        assert_eq!(
            compare(
                &Method::GET,
                &native(compressed, Some("gzip")),
                200,
                &gzip_headers,
                &other.finish().unwrap()
            ),
            None
        );
    }

    #[test]
    fn compares_the_length_head_is_sent_with() {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/plain"));
        headers.insert(CONTENT_LENGTH, HeaderValue::from_static("5"));
        assert_eq!(
            compare(&Method::HEAD, &native(b"hello", None), 200, &headers, b""),
            None
        );
    }

    #[test]
    fn reports_status_before_anything_else() {
        let divergence = compare(
            &Method::GET,
            &native(b"x", None),
            404,
            &HeaderMap::new(),
            b"y",
        )
        .unwrap();
        assert_eq!(divergence.field, "status");
    }
}
