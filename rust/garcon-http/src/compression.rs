//! Response compression for natively served routes. Ports the compression
//! half of `server/controller/lib/http-compression.ts`; rules and their order
//! match the original so recorded headers replay exactly. The front door
//! proxies requests with a `Range` header (see ADR-005).

use std::io::{Read, Write};

use bytes::Bytes;
use garcon_base::http_body::fetch_header_value;
use garcon_js::js::{trim, trim_end, trim_start};
use http::header::{
    ACCEPT_ENCODING, ACCEPT_RANGES, AsHeaderName, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_TYPE, ETAG, HeaderMap, HeaderValue, IF_RANGE, RANGE, TRANSFER_ENCODING,
    VARY,
};
use http::{Method, Response, StatusCode};

const MIN_COMPRESSED_BYTES: usize = 1024;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

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
    pub fn token(self) -> &'static str {
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
    let rest = trim_start(param.strip_prefix(['q', 'Q'])?);
    let value = trim_start(rest.strip_prefix('=')?);
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
    for part in header.split(',').map(trim).filter(|part| !part.is_empty()) {
        let mut pieces = part.split(';').map(trim);
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
    let mime = trim(content_type.split(';').next().unwrap_or_default());
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
        let mut parts = value.split(',').enumerate().peekable();
        while let Some((index, part)) = parts.next() {
            let part = if index == 0 { part } else { trim_start(part) };
            let part = if parts.peek().is_none() {
                part
            } else {
                trim_end(part)
            };
            if part.eq_ignore_ascii_case("no-transform") {
                return true;
            }
        }
        false
    })
}

/// A single field for the front door's shadow diagnostic, not a Fetch header read.
pub fn header<K: AsHeaderName>(headers: &HeaderMap, name: K) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn declared_length(headers: &HeaderMap) -> Option<f64> {
    let value = fetch_header_value(headers, &CONTENT_LENGTH)?;
    let value = trim(&value);
    if value.is_empty() {
        return Some(0.0);
    }
    // Number() also recognizes unsigned hexadecimal, octal, and binary.
    if let Some((radix, digits)) =
        [("0x", 16), ("0o", 8), ("0b", 2)]
            .into_iter()
            .find_map(|(prefix, radix)| {
                let start = value.get(..2)?;
                start
                    .eq_ignore_ascii_case(prefix)
                    .then_some((radix, &value[2..]))
            })
    {
        if digits.is_empty() {
            return None;
        }
        return digits.chars().try_fold(0.0, |acc, digit| {
            Some(acc * f64::from(radix) + f64::from(digit.to_digit(radix)?))
        });
    }
    value.parse::<f64>().ok()
}

fn should_skip(method: &Method, response: &NativeResponse, enabled: bool) -> bool {
    !enabled
        || method == Method::HEAD
        || matches!(response.status.as_u16(), 101 | 204 | 304)
        || response.headers.contains_key(CONTENT_ENCODING)
        || has_no_transform(fetch_header_value(&response.headers, &CACHE_CONTROL).as_deref())
        || !is_compressible(fetch_header_value(&response.headers, &CONTENT_TYPE).as_deref())
        || declared_length(&response.headers)
            .is_some_and(|length| length.is_finite() && length < MIN_COMPRESSED_BYTES as f64)
}

fn header_value(text: String) -> HeaderValue {
    let bytes: Vec<_> = text.chars().map(|byte| byte as u8).collect();
    // INFALLIBLE: generated ASCII and validated Fetch ByteStrings are valid wire values.
    HeaderValue::from_bytes(&bytes).expect("generated HTTP header value")
}

fn append_vary_accept_encoding(headers: &mut HeaderMap) {
    let Some(existing) = fetch_header_value(headers, &VARY).filter(|value| !value.is_empty())
    else {
        headers.insert(VARY, HeaderValue::from_static("Accept-Encoding"));
        return;
    };
    if trim(&existing) == "*"
        || existing
            .split(',')
            .any(|part| trim(part).eq_ignore_ascii_case("accept-encoding"))
    {
        return;
    }
    headers.insert(VARY, header_value(format!("{existing}, Accept-Encoding")));
}

fn weaken_strong_etag(headers: &mut HeaderMap) {
    if let Some(etag) = fetch_header_value(headers, &ETAG)
        .filter(|etag| !etag.is_empty() && !etag.starts_with("W/"))
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
    let Some(encoding) =
        negotiate_encoding(fetch_header_value(request, &ACCEPT_ENCODING).as_deref())
    else {
        append_vary_accept_encoding(&mut response.headers);
        return response;
    };
    let compressed = match encode(encoding, &response.body) {
        Ok(compressed) => compressed,
        Err(_) => return response,
    };
    apply_encoding(&mut response, encoding, compressed);
    response
}

fn apply_encoding(response: &mut NativeResponse, encoding: Encoding, body: Bytes) {
    response
        .headers
        .insert(CONTENT_ENCODING, HeaderValue::from_static(encoding.token()));
    response.headers.remove(CONTENT_LENGTH);
    append_vary_accept_encoding(&mut response.headers);
    weaken_strong_etag(&mut response.headers);
    response.body = body;
}

enum ByteRange {
    Satisfiable { start: u64, end: u64 },
    Unsatisfiable,
}

fn safe_unsigned(digits: &str) -> Option<u64> {
    if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
}

fn parse_single_range(value: &str, total: u64) -> Option<ByteRange> {
    let value = trim(value);
    if !value.get(..6)?.eq_ignore_ascii_case("bytes=") {
        return None;
    }
    let (start, end) = value[6..].split_once('-')?;
    if start.is_empty() {
        let suffix = safe_unsigned(end)?;
        return Some(if suffix == 0 || total == 0 {
            ByteRange::Unsatisfiable
        } else {
            ByteRange::Satisfiable {
                start: total.saturating_sub(suffix),
                end: total - 1,
            }
        });
    }
    let start = safe_unsigned(start)?;
    let end = if end.is_empty() {
        total.saturating_sub(1)
    } else {
        let end = safe_unsigned(end)?;
        if end < start {
            return None;
        }
        end
    };
    Some(if start >= total {
        ByteRange::Unsatisfiable
    } else {
        ByteRange::Satisfiable {
            start,
            end: end.min(total - 1),
        }
    })
}

fn select_range(
    method: &Method,
    request: &HeaderMap,
    response: &mut NativeResponse,
) -> Option<bool> {
    if method != Method::GET
        || response.status != StatusCode::OK
        || response.headers.contains_key(CONTENT_ENCODING)
        || response.headers.contains_key(CONTENT_RANGE)
    {
        return None;
    }
    let total = safe_unsigned(&fetch_header_value(&response.headers, &CONTENT_LENGTH)?)?;
    if request.contains_key(IF_RANGE) {
        let validator = fetch_header_value(request, &IF_RANGE)?;
        let inner = validator.strip_prefix('"')?.strip_suffix('"')?;
        if inner.contains('"')
            || fetch_header_value(&response.headers, &ETAG).as_ref() != Some(&validator)
        {
            return None;
        }
    }
    let range = parse_single_range(&fetch_header_value(request, &RANGE)?, total)?;
    response
        .headers
        .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    match range {
        ByteRange::Unsatisfiable => {
            response.status = StatusCode::RANGE_NOT_SATISFIABLE;
            response
                .headers
                .insert(CONTENT_RANGE, header_value(format!("bytes */{total}")));
            response.headers.remove(CONTENT_LENGTH);
            Some(false)
        }
        ByteRange::Satisfiable { start, end } => {
            let from = usize::try_from(start).ok()?.min(response.body.len());
            let to = usize::try_from(end + 1).ok()?.min(response.body.len());
            response.status = StatusCode::PARTIAL_CONTENT;
            response.headers.insert(
                CONTENT_RANGE,
                header_value(format!("bytes {start}-{end}/{total}")),
            );
            response
                .headers
                .insert(CONTENT_LENGTH, HeaderValue::from(end - start + 1));
            response.body = response.body.slice(from..to);
            Some(true)
        }
    }
}

/// Applies range selection and compression on the controller's local runtime.
/// A null body is distinct from a present body of zero bytes.
pub async fn finish_native(
    method: &Method,
    request: &HeaderMap,
    response: Response<Option<Bytes>>,
    enabled: bool,
) -> std::io::Result<Response<Option<Bytes>>> {
    let (mut parts, body) = response.into_parts();
    let Some(body) = body else {
        return Ok(Response::from_parts(parts, None));
    };
    let mut response = NativeResponse {
        status: parts.status,
        headers: parts.headers,
        body,
    };
    let mut has_body = true;
    if request.contains_key(RANGE) {
        match select_range(method, request, &mut response) {
            Some(false) => has_body = false,
            Some(true) if response.body.len() >= 256 => stream_framing(&mut response.headers),
            // Bun's pass-through stream prevents its file response writer
            // from applying a second, different range parser.
            None if response.status == StatusCode::OK => {
                stream_framing(&mut response.headers);
                // An exact-size body would make Hyper announce that size for HEAD.
                has_body = method != Method::HEAD;
            }
            _ => {}
        }
    } else if !should_skip(method, &response, enabled) {
        if let Some(encoding) =
            negotiate_encoding(fetch_header_value(request, &ACCEPT_ENCODING).as_deref())
        {
            let input = response.body.clone();
            let compressed =
                tokio::task::spawn_blocking(move || encoding.compress(&input)).await??;
            apply_encoding(&mut response, encoding, compressed);
            stream_framing(&mut response.headers);
        } else {
            append_vary_accept_encoding(&mut response.headers);
        }
    }
    parts.status = response.status;
    parts.headers = response.headers;
    Ok(Response::from_parts(
        parts,
        has_body.then_some(response.body),
    ))
}

// Bun 1.4.3 coalesces selected ranges smaller than 256 bytes; larger slices
// and the pass-through stream omit Content-Length on the wire.
fn stream_framing(headers: &mut HeaderMap) {
    headers.remove(CONTENT_LENGTH);
    headers.insert(TRANSFER_ENCODING, HeaderValue::from_static("chunked"));
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

    fn asset() -> NativeResponse {
        NativeResponse {
            status: StatusCode::OK,
            headers: HeaderMap::new(),
            body: Bytes::from(vec![b'a'; 4096]),
        }
    }

    #[test]
    fn finish_negotiates_all_accept_encoding_fields_in_order() {
        for (first, second, expected) in [("br", "gzip", Some("gzip")), ("gzip", "gzip;q=0", None)]
        {
            let mut request = HeaderMap::new();
            request.append(ACCEPT_ENCODING, HeaderValue::from_static(first));
            request.append(ACCEPT_ENCODING, HeaderValue::from_static(second));
            let response = finish(&Method::GET, &request, asset(), true, |encoding, body| {
                encoding.compress(body)
            });
            assert_eq!(
                response
                    .headers
                    .get(CONTENT_ENCODING)
                    .and_then(|value| value.to_str().ok()),
                expected
            );
            assert_eq!(response.headers[VARY], "Accept-Encoding");
        }
    }

    #[test]
    fn finish_joins_response_fields_before_skipping_and_transforming() {
        let mut request = HeaderMap::new();
        request.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip"));
        let mut untouched = asset();
        untouched
            .headers
            .append(CACHE_CONTROL, HeaderValue::from_static("public"));
        untouched
            .headers
            .append(CACHE_CONTROL, HeaderValue::from_static("no-transform"));
        let untouched = finish(&Method::GET, &request, untouched, true, |_, _| {
            panic!("no-transform prevents compression")
        });
        assert!(!untouched.headers.contains_key(VARY));

        let mut response = asset();
        for (name, values) in [
            (VARY, ["Origin", "Cookie"]),
            (ETAG, ["\"one\"", "\"two\""]),
            (CONTENT_LENGTH, ["2", "2"]),
            (CONTENT_TYPE, ["application/zip", "text/plain"]),
        ] {
            for value in values {
                response
                    .headers
                    .append(&name, HeaderValue::from_static(value));
            }
        }
        let response = finish(&Method::GET, &request, response, true, |encoding, body| {
            encoding.compress(body)
        });
        assert_eq!(response.headers[CONTENT_ENCODING], "gzip");
        assert_eq!(response.headers[VARY], "Origin, Cookie, Accept-Encoding");
        assert_eq!(response.headers[ETAG], "W/\"one\", \"two\"");
        assert!(!response.headers.contains_key(CONTENT_LENGTH));
    }

    #[test]
    fn range_selection_rejects_joined_length_and_if_range_validator_mismatches() {
        let mut request = HeaderMap::new();
        request.insert(RANGE, HeaderValue::from_static("bytes=0-1"));
        request.insert(IF_RANGE, HeaderValue::from_static("\"tag\""));
        for duplicate in [CONTENT_LENGTH, ETAG] {
            let mut response = asset();
            response
                .headers
                .insert(CONTENT_LENGTH, HeaderValue::from_static("4096"));
            response
                .headers
                .insert(ETAG, HeaderValue::from_static("\"tag\""));
            response
                .headers
                .append(duplicate, HeaderValue::from_static("4096"));
            assert_eq!(select_range(&Method::GET, &request, &mut response), None);
            assert_eq!(response.status, StatusCode::OK);
        }
    }
}
