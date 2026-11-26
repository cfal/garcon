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

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;

use bytes::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::header::{CONTENT_ENCODING, CONTENT_LENGTH, HeaderMap};
use hyper::{Method, Request, Uri};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

use crate::compression::NativeResponse;

/// Headers compared between the two responses. `Content-Length` is compared
/// separately, and only for bodies that are not compressed.
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

const FORWARDED_HEADERS_TO_DROP: [&str; 3] = ["connection", "keep-alive", "upgrade"];

pub struct Shadow {
    client: Client<HttpConnector, Empty<Bytes>>,
    origin: String,
    log: Mutex<File>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Divergence {
    pub field: String,
    pub detail: String,
}

fn decode(body: &[u8], encoding: Option<&str>) -> Result<Vec<u8>, String> {
    let mut decoded = Vec::new();
    let result = match encoding {
        Some("gzip") => flate2::read::GzDecoder::new(body).read_to_end(&mut decoded),
        Some("deflate") => flate2::read::ZlibDecoder::new(body).read_to_end(&mut decoded),
        Some("zstd") => {
            let mut source = body;
            ruzstd::decoding::StreamingDecoder::new(&mut source)
                .map_err(|error| std::io::Error::other(error.to_string()))
                .and_then(|mut decoder| decoder.read_to_end(&mut decoded))
        }
        _ => return Ok(body.to_vec()),
    };
    result
        .map(|_| decoded)
        .map_err(|error| format!("undecodable {encoding:?} body: {error}"))
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// Compares a native response with the original's answer to the same request.
pub fn compare(
    method: &Method,
    native: &NativeResponse,
    original_status: u16,
    original_headers: &HeaderMap,
    original_body: &[u8],
) -> Option<Divergence> {
    if native.status.as_u16() != original_status {
        return Some(Divergence {
            field: "status".to_string(),
            detail: format!(
                "native={} original={original_status}",
                native.status.as_u16()
            ),
        });
    }
    for name in COMPARED_HEADERS {
        let (left, right) = (
            header_text(&native.headers, name),
            header_text(original_headers, name),
        );
        if left != right {
            return Some(Divergence {
                field: format!("header:{name}"),
                detail: format!("native={left:?} original={right:?}"),
            });
        }
    }
    if !native.headers.contains_key(CONTENT_ENCODING) {
        let (left, right) = (
            header_text(&native.headers, CONTENT_LENGTH.as_str()),
            header_text(original_headers, CONTENT_LENGTH.as_str()),
        );
        // Without the header, a native response is sent with its body length:
        // hyper frames GET bodies by length and `into_response` sets it for HEAD.
        let left = left
            .map(str::to_string)
            .or_else(|| Some(native.body.len().to_string()));
        if left.as_deref() != right {
            return Some(Divergence {
                field: "header:content-length".to_string(),
                detail: format!("native={left:?} original={right:?}"),
            });
        }
    }
    if method == Method::HEAD {
        return None;
    }
    let native_body = match decode(
        &native.body,
        header_text(&native.headers, "content-encoding"),
    ) {
        Ok(body) => body,
        Err(error) => {
            return Some(Divergence {
                field: "body".to_string(),
                detail: format!("native {error}"),
            });
        }
    };
    let original_body = match decode(
        original_body,
        header_text(original_headers, "content-encoding"),
    ) {
        Ok(body) => body,
        Err(error) => {
            return Some(Divergence {
                field: "body".to_string(),
                detail: format!("original {error}"),
            });
        }
    };
    if native_body == original_body {
        return None;
    }
    let offset = native_body
        .iter()
        .zip(&original_body)
        .position(|(left, right)| left != right)
        .unwrap_or_else(|| native_body.len().min(original_body.len()));
    Some(Divergence {
        field: "body".to_string(),
        detail: format!(
            "first-difference={offset} native-length={} original-length={}",
            native_body.len(),
            original_body.len()
        ),
    })
}

impl Shadow {
    pub fn open(path: &Path, origin: String) -> std::io::Result<Self> {
        Ok(Self {
            client: Client::builder(TokioExecutor::new()).build(crate::proxy::no_delay_connector()),
            origin,
            log: Mutex::new(OpenOptions::new().create(true).append(true).open(path)?),
        })
    }

    fn record(&self, line: &str) {
        let mut log = self.log.lock().expect("shadow log lock");
        let _ = writeln!(log, "{line}");
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
        let target = format!(
            "{}{}",
            self.origin,
            uri.path_and_query()
                .map(|value| value.as_str())
                .unwrap_or("/")
        );
        let mut request = Request::new(Empty::new());
        *request.method_mut() = method.clone();
        *request.uri_mut() = match target.parse() {
            Ok(uri) => uri,
            Err(_) => {
                return self.record(&format!(
                    "error\t{method}\t{}\tunparseable target",
                    uri.path()
                ));
            }
        };
        *request.headers_mut() = headers.clone();
        for name in FORWARDED_HEADERS_TO_DROP {
            request.headers_mut().remove(name);
        }
        let outcome = match self.client.request(request).await {
            Ok(response) => {
                let (parts, body) = response.into_parts();
                match body.collect().await {
                    Ok(collected) => compare(
                        method,
                        native,
                        parts.status.as_u16(),
                        &parts.headers,
                        &collected.to_bytes(),
                    ),
                    Err(error) => {
                        return self.record(&format!("error\t{method}\t{}\t{error}", uri.path()));
                    }
                }
            }
            Err(error) => return self.record(&format!("error\t{method}\t{}\t{error}", uri.path())),
        };
        match outcome {
            None => self.record(&format!("match\t{method}\t{}", uri.path())),
            Some(divergence) => self.record(&format!(
                "diverge\t{method}\t{}\t{}\t{}",
                uri.path(),
                divergence.field,
                divergence.detail
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::StatusCode;
    use hyper::header::{CONTENT_TYPE, HeaderValue};

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
