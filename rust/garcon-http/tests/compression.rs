use bytes::Bytes;
use garcon_cases::{CaseError, replay, text};
use garcon_http::compression::{Encoding, finish_native, negotiate_encoding};
use http::header::{
    ACCEPT_ENCODING, ACCEPT_RANGES, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_LENGTH, CONTENT_RANGE,
    CONTENT_TYPE, ETAG, IF_RANGE, RANGE, VARY,
};
use http::{HeaderMap, HeaderValue, Method, Response, StatusCode};
use serde_json::json;

#[test]
fn negotiates_as_recorded_by_the_original() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/http-compression"),
        |function, args| match function {
            "negotiateContentEncoding" => Ok(json!(
                negotiate_encoding(text(function, args.first())?).map(Encoding::token)
            )),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}

fn text_response(body: Bytes) -> Response<Option<Bytes>> {
    Response::builder()
        .header(CONTENT_TYPE, "text/plain")
        .header(CONTENT_LENGTH, body.len())
        .body(Some(body))
        .unwrap()
}

#[tokio::test]
async fn native_compression_reads_every_field_of_a_request_header() {
    let mut request = HeaderMap::new();
    request.append(ACCEPT_ENCODING, HeaderValue::from_static("gzip;q=.2"));
    request.append(ACCEPT_ENCODING, HeaderValue::from_static("zstd;q=.9"));
    let body = Bytes::from(vec![b'a'; 2048]);
    let response = finish_native(&Method::GET, &request, text_response(body.clone()), true)
        .await
        .unwrap();
    assert_eq!(response.headers()[CONTENT_ENCODING], "zstd");

    request.append(RANGE, HeaderValue::from_static("bytes=0-9"));
    request.append(RANGE, HeaderValue::from_static("bytes=99-100"));
    let response = finish_native(&Method::GET, &request, text_response(body.clone()), true)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(CONTENT_ENCODING));
    assert!(!response.headers().contains_key(CONTENT_RANGE));
    assert_eq!(response.into_body(), Some(body));
}

#[tokio::test]
async fn compresses_each_encoding_and_keeps_the_original_representation_metadata() {
    let body = Bytes::from("garcon ".repeat(1000));
    for encoding in [Encoding::Gzip, Encoding::Zstd, Encoding::Deflate] {
        let mut request = HeaderMap::new();
        request.insert(ACCEPT_ENCODING, HeaderValue::from_static(encoding.token()));
        for (etag, vary, expected_etag, expected_vary) in [
            ("\"tag\"", "Origin", "W/\"tag\"", "Origin, Accept-Encoding"),
            ("W/\"tag\"", "*", "W/\"tag\"", "*"),
        ] {
            let mut response = text_response(body.clone());
            response
                .headers_mut()
                .insert(ETAG, HeaderValue::from_static(etag));
            response
                .headers_mut()
                .insert(VARY, HeaderValue::from_static(vary));
            let response = finish_native(&Method::GET, &request, response, true)
                .await
                .unwrap();
            assert_eq!(response.headers()[CONTENT_ENCODING], encoding.token());
            assert!(!response.headers().contains_key(CONTENT_LENGTH));
            assert_eq!(response.headers()[ETAG], expected_etag);
            assert_eq!(response.headers()[VARY], expected_vary);
            assert_eq!(
                &encoding.decode(&response.into_body().unwrap()).unwrap(),
                body.as_ref()
            );
        }
    }
}

#[tokio::test]
async fn only_eligible_responses_vary_on_accept_encoding() {
    let mut request = HeaderMap::new();
    request.insert(ACCEPT_ENCODING, HeaderValue::from_static("br"));
    let text = Bytes::from(vec![b'A'; 1024]);
    let exclusions = [
        (CONTENT_LENGTH, "0x80"),
        (CONTENT_TYPE, "text/event-stream"),
        (CONTENT_TYPE, "image/png"),
        (CACHE_CONTROL, "private, NO-TRANSFORM , max-age=10"),
        (CONTENT_ENCODING, "identity"),
    ];
    for (key, value) in exclusions {
        let mut response = text_response(text.clone());
        response
            .headers_mut()
            .insert(key, HeaderValue::from_static(value));
        let response = finish_native(&Method::GET, &request, response, true)
            .await
            .unwrap();
        assert!(!response.headers().contains_key(VARY), "{value}");
        assert_eq!(response.into_body(), Some(text.clone()));
    }
    for (method, body, enabled) in [
        (Method::HEAD, Some(text.clone()), true),
        (Method::GET, Some(text.clone()), false),
        (Method::GET, None, true),
    ] {
        let response = finish_native(&method, &request, Response::new(body.clone()), enabled)
            .await
            .unwrap();
        assert!(!response.headers().contains_key(VARY));
        assert_eq!(response.into_body(), body);
    }
    let mut svg = text_response(text.clone());
    svg.headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("image/svg+xml"));
    svg.headers_mut()
        .insert(VARY, HeaderValue::from_static("Origin, accept-encoding"));
    let response = finish_native(&Method::GET, &request, svg, true)
        .await
        .unwrap();
    assert_eq!(response.headers()[VARY], "Origin, accept-encoding");
    assert!(!response.headers().contains_key(CONTENT_ENCODING));
    assert_eq!(response.into_body(), Some(text));
}

#[tokio::test]
async fn selects_a_single_byte_range_before_compression() {
    for (range, expected, content_range) in [
        ("bytes=5-9", "56789", "bytes 5-9/10"),
        ("BYTES=5-", "56789", "bytes 5-9/10"),
        ("bytes=-3", "789", "bytes 7-9/10"),
        ("bytes=-20", "0123456789", "bytes 0-9/10"),
        ("bytes=7-99", "789", "bytes 7-9/10"),
    ] {
        let mut request = HeaderMap::new();
        request.insert(RANGE, HeaderValue::from_static(range));
        request.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip"));
        let original = text_response(Bytes::from_static(b"0123456789"));
        let response = finish_native(&Method::GET, &request, original, false)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range}");
        assert_eq!(response.headers()[ACCEPT_RANGES], "bytes");
        assert_eq!(response.headers()[CONTENT_RANGE], content_range);
        assert_eq!(
            response.headers()[CONTENT_LENGTH],
            expected.len().to_string()
        );
        assert!(!response.headers().contains_key(CONTENT_ENCODING));
        assert_eq!(
            response.into_body(),
            Some(Bytes::from_static(expected.as_bytes()))
        );
    }
    for range in ["bytes=10-", "bytes=-0"] {
        let mut request = HeaderMap::new();
        request.insert(RANGE, HeaderValue::from_static(range));
        let original = text_response(Bytes::from_static(b"0123456789"));
        let response = finish_native(&Method::GET, &request, original, true)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes */10");
        assert!(!response.headers().contains_key(CONTENT_LENGTH));
        assert!(response.into_body().is_none());
    }
}

#[tokio::test]
async fn ignores_unverifiable_or_unsupported_ranges_without_compressing() {
    for (range, validator, partial) in [
        ("bytes=5-", Some("\"tag\""), true),
        ("bytes=5-", Some("W/\"tag\""), false),
        ("bytes=5-", Some("\"different\""), false),
        ("bytes=5-", Some("Fri, 02 Oct 2026 00:00:00 GMT"), false),
        ("bytes=0-1,3-4", None, false),
        ("bytes=0-9007199254740992", None, false),
        ("bytes=1e0-2", None, false),
        ("bytes=5-2", None, false),
        ("bytes=-", None, false),
    ] {
        let mut request = HeaderMap::new();
        request.insert(RANGE, HeaderValue::from_static(range));
        request.insert(ACCEPT_ENCODING, HeaderValue::from_static("gzip"));
        if let Some(validator) = validator {
            request.insert(IF_RANGE, HeaderValue::from_static(validator));
        }
        let original = Bytes::from_static(b"0123456789");
        let mut response = text_response(original.clone());
        response
            .headers_mut()
            .insert(ETAG, HeaderValue::from_static("\"tag\""));
        let response = finish_native(&Method::GET, &request, response, true)
            .await
            .unwrap();
        assert!(!response.headers().contains_key(VARY));
        assert!(!response.headers().contains_key(CONTENT_ENCODING));
        assert_eq!(response.headers().contains_key(CONTENT_RANGE), partial);
        assert_eq!(
            response.into_body(),
            Some(if partial {
                original.slice(5..)
            } else {
                original
            })
        );
    }
}
