//! Response compression for natively served routes. Ports the compression
//! half of `server/controller/lib/http-compression.ts`; rules and their order
//! match the original so recorded headers replay exactly. Requests with a
//! `Range` header are never served natively (see ADR-005), so the original's
//! byte-range handling has no counterpart here.

use std::io::{Read, Write};

use bytes::Bytes;
use hyper::header::{
    ACCEPT_ENCODING, AsHeaderName, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_TYPE,
    ETAG, HeaderMap, HeaderValue, VARY,
};
use hyper::{Method, StatusCode};

const MIN_COMPRESSED_BYTES: usize = 1024;

/// Preference order for equal-quality encodings; Brotli is intentionally
/// unsupported, as in the original.
const ENCODING_PREFERENCE: [Encoding; 3] = [Encoding::Gzip, Encoding::Zstd, Encoding::Deflate];

const SKIP_MIME_TYPES: [&str; 10] = [
    "application/gzip",
    "application/octet-stream",
    "application/pdf",
    "application/wasm",
    "application/x-7z-compressed",
    "application/x-bzip2",
    "application/x-gzip",
    "application/x-rar-compressed",
    "application/zip",
    "text/event-stream",
];
const SKIP_MIME_PREFIXES: [&str; 4] = ["audio/", "font/", "image/", "video/"];
const COMPRESSIBLE_MIME_EXCEPTIONS: [&str; 1] = ["image/svg+xml"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Gzip,
    Zstd,
    Deflate,
}

impl Encoding {
    fn token(self) -> &'static str {
        match self {
            Encoding::Gzip => "gzip",
            Encoding::Zstd => "zstd",
            Encoding::Deflate => "deflate",
        }
    }

    /// The encoding a `Content-Encoding` value names, if it is one of ours.
    pub fn from_token(token: &str) -> Option<Self> {
        ENCODING_PREFERENCE
            .into_iter()
            .find(|encoding| token.eq_ignore_ascii_case(encoding.token()))
    }

    pub fn compress(self, input: &[u8]) -> std::io::Result<Bytes> {
        let compressed = match self {
            Encoding::Gzip => {
                let mut encoder =
                    flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(input)?;
                encoder.finish()
            }
            // HTTP `deflate` is the zlib format, as Web CompressionStream emits.
            Encoding::Deflate => {
                let mut encoder =
                    flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
                encoder.write_all(input)?;
                encoder.finish()
            }
            Encoding::Zstd => Ok(ruzstd::encoding::compress_to_vec(
                input,
                ruzstd::encoding::CompressionLevel::Fastest,
            )),
        };
        compressed.map(Bytes::from)
    }

    pub fn decode(self, input: &[u8]) -> std::io::Result<Vec<u8>> {
        let mut decoded = Vec::new();
        match self {
            Encoding::Gzip => flate2::read::GzDecoder::new(input).read_to_end(&mut decoded)?,
            Encoding::Deflate => flate2::read::ZlibDecoder::new(input).read_to_end(&mut decoded)?,
            Encoding::Zstd => {
                let mut source = input;
                ruzstd::decoding::StreamingDecoder::new(&mut source)
                    .map_err(|error| std::io::Error::other(error.to_string()))?
                    .read_to_end(&mut decoded)?
            }
        };
        Ok(decoded)
    }
}

/// A complete native response before compression.
pub struct NativeResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl NativeResponse {
    /// Sets the headers the response is sent with: an uncompressed body
    /// declares its length for every method, so HEAD carries the length of
    /// the GET representation, as Bun sends it.
    pub fn framed(mut self) -> Self {
        if !self.headers.contains_key(CONTENT_ENCODING)
            && !self.headers.contains_key(CONTENT_LENGTH)
        {
            self.headers.insert(CONTENT_LENGTH, self.body.len().into());
        }
        self
    }
}

/// JavaScript `Number()` over the characters the original's regex admits,
/// clamped the same way: unparseable qualities count as 1.
fn parse_quality(text: &str) -> f64 {
    match text.parse::<f64>() {
        Ok(value) if value.is_finite() => value.clamp(0.0, 1.0),
        _ => 1.0,
    }
}

fn quality_param(param: &str) -> Option<&str> {
    let rest = param.strip_prefix(['q', 'Q'])?.trim_start();
    let value = rest.strip_prefix('=')?.trim_start();
    (!value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.'))
    .then_some(value)
}

pub fn negotiate_encoding(accept_encoding: Option<&str>) -> Option<Encoding> {
    let header = accept_encoding.filter(|value| !value.is_empty())?;
    // Qualities by preference index; a later mention of a token replaces an
    // earlier one, as the original's map does.
    let mut explicit: [Option<f64>; ENCODING_PREFERENCE.len()] = [None; ENCODING_PREFERENCE.len()];
    let mut wildcard: Option<f64> = None;
    for part in header
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
    {
        let mut pieces = part.split(';').map(str::trim);
        let token = pieces.next().unwrap_or_default();
        let quality = pieces
            .filter_map(quality_param)
            .next_back()
            .map_or(1.0, parse_quality);
        if token == "*" {
            wildcard = Some(quality);
        } else if let Some(index) = ENCODING_PREFERENCE
            .iter()
            .position(|encoding| token.eq_ignore_ascii_case(encoding.token()))
        {
            explicit[index] = Some(quality);
        }
    }
    // The highest quality wins; ties keep the earlier preference.
    let mut best: Option<(Encoding, f64)> = None;
    for (index, encoding) in ENCODING_PREFERENCE.into_iter().enumerate() {
        let Some(quality) = explicit[index]
            .or(wildcard)
            .filter(|quality| *quality > 0.0)
        else {
            continue;
        };
        if best.is_none_or(|(_, best_quality)| quality > best_quality) {
            best = Some((encoding, quality));
        }
    }
    best.map(|(encoding, _)| encoding)
}

fn is_compressible(content_type: Option<&str>) -> bool {
    let Some(content_type) = content_type else {
        return true;
    };
    let mime = content_type.split(';').next().unwrap_or_default().trim();
    let is = |candidate: &str| mime.eq_ignore_ascii_case(candidate);
    if mime.is_empty() || COMPRESSIBLE_MIME_EXCEPTIONS.into_iter().any(is) {
        return true;
    }
    !SKIP_MIME_TYPES.into_iter().any(is)
        && !SKIP_MIME_PREFIXES.into_iter().any(|prefix| {
            mime.get(..prefix.len())
                .is_some_and(|start| start.eq_ignore_ascii_case(prefix))
        })
}

fn has_no_transform(cache_control: Option<&str>) -> bool {
    cache_control.is_some_and(|value| {
        value
            .split(',')
            .any(|directive| directive.trim().eq_ignore_ascii_case("no-transform"))
    })
}

/// A header value as text, or `None` when absent or not visible ASCII.
pub fn header<K: AsHeaderName>(headers: &HeaderMap, name: K) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn declared_length(headers: &HeaderMap) -> Option<usize> {
    header(headers, CONTENT_LENGTH).and_then(|value| value.parse().ok())
}

fn should_skip(method: &Method, response: &NativeResponse, enabled: bool) -> bool {
    !enabled
        || method == Method::HEAD
        || matches!(response.status.as_u16(), 101 | 204 | 304)
        || response.headers.contains_key(CONTENT_ENCODING)
        || has_no_transform(header(&response.headers, CACHE_CONTROL))
        || !is_compressible(header(&response.headers, CONTENT_TYPE))
        || declared_length(&response.headers).is_some_and(|length| length < MIN_COMPRESSED_BYTES)
}

fn header_value(text: String) -> HeaderValue {
    HeaderValue::from_str(&text).expect("generated header values are visible ASCII")
}

fn append_vary_accept_encoding(headers: &mut HeaderMap) {
    let Some(existing) = header(headers, VARY).map(str::to_string) else {
        headers.insert(VARY, HeaderValue::from_static("Accept-Encoding"));
        return;
    };
    if existing.trim() == "*"
        || existing
            .split(',')
            .any(|part| part.trim().eq_ignore_ascii_case("accept-encoding"))
    {
        return;
    }
    headers.insert(VARY, header_value(format!("{existing}, Accept-Encoding")));
}

fn weaken_strong_etag(headers: &mut HeaderMap) {
    if let Some(etag) = header(headers, ETAG)
        .filter(|etag| !etag.starts_with("W/"))
        .map(str::to_string)
    {
        headers.insert(ETAG, header_value(format!("W/{etag}")));
    }
}

/// Applies the original's compression rules to a native response.
/// `encode` produces the compressed body; callers with stable content pass
/// a cache (see `asset_cache.rs`), others `Encoding::compress`.
pub fn finish(
    method: &Method,
    request: &HeaderMap,
    response: NativeResponse,
    enabled: bool,
    encode: impl FnOnce(Encoding, &Bytes) -> std::io::Result<Bytes>,
) -> NativeResponse {
    if should_skip(method, &response, enabled) {
        return response;
    }
    let mut response = response;
    let Some(encoding) = negotiate_encoding(header(request, ACCEPT_ENCODING)) else {
        append_vary_accept_encoding(&mut response.headers);
        return response;
    };
    let compressed = match encode(encoding, &response.body) {
        Ok(compressed) => compressed,
        Err(_) => return response,
    };
    response
        .headers
        .insert(CONTENT_ENCODING, HeaderValue::from_static(encoding.token()));
    response.headers.remove(CONTENT_LENGTH);
    append_vary_accept_encoding(&mut response.headers);
    weaken_strong_etag(&mut response.headers);
    response.body = compressed;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiates_like_the_original() {
        assert_eq!(negotiate_encoding(Some("gzip, zstd")), Some(Encoding::Gzip));
        assert_eq!(
            negotiate_encoding(Some("gzip;q=0.2, zstd;q=0.9")),
            Some(Encoding::Zstd)
        );
        assert_eq!(
            negotiate_encoding(Some("gzip;q=0, *")),
            Some(Encoding::Zstd)
        );
        assert_eq!(negotiate_encoding(Some("GZIP")), Some(Encoding::Gzip));
        assert_eq!(negotiate_encoding(Some("br")), None);
        assert_eq!(
            negotiate_encoding(Some("gzip;q=1.2.3")),
            Some(Encoding::Gzip)
        );
        assert_eq!(negotiate_encoding(Some("")), None);
        assert_eq!(negotiate_encoding(None), None);
    }

    #[test]
    fn skips_small_declared_bodies_but_not_undeclared_ones() {
        let request = {
            let mut headers = HeaderMap::new();
            headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip"));
            headers
        };
        let small = |declare: bool| {
            let mut headers = HeaderMap::new();
            headers.insert(
                CONTENT_TYPE,
                HeaderValue::from_static("application/json;charset=utf-8"),
            );
            if declare {
                headers.insert(CONTENT_LENGTH, HeaderValue::from_static("2"));
            }
            NativeResponse {
                status: StatusCode::OK,
                headers,
                body: Bytes::from_static(b"{}"),
            }
        };
        let compress = |encoding: Encoding, body: &Bytes| encoding.compress(body);
        let declared = finish(&Method::GET, &request, small(true), true, compress);
        assert!(!declared.headers.contains_key(CONTENT_ENCODING));
        assert!(!declared.headers.contains_key(VARY));
        let undeclared = finish(&Method::GET, &request, small(false), true, compress);
        assert_eq!(undeclared.headers.get(CONTENT_ENCODING).unwrap(), "gzip");
        assert_eq!(undeclared.headers.get(VARY).unwrap(), "Accept-Encoding");
    }
}
