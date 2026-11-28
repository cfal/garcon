//! Ports `server/controller/auth/http.ts`.

use std::cell::Cell;
use std::error::Error;
use std::time::Duration;

use bytes::Bytes;
use garcon_base::domain_error::DomainError;
use garcon_base::http_body::fetch_header_value;
use garcon_contract::auth::AuthValidationError;
use garcon_contract::error_codes::ErrorCode;
use garcon_js::{json, trim};
use http::Request;
use http::header::{CONTENT_LENGTH, CONTENT_TYPE};
use http_body_util::BodyExt;
use hyper::body::Body;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

const MAX_BODY_BYTES: usize = 4096;
const DEADLINE: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(crate) struct AuthBodyReaders(Cell<usize>);

struct ReaderSlot<'a>(&'a Cell<usize>);

impl Drop for ReaderSlot<'_> {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}

fn too_large() -> DomainError {
    DomainError::new(
        ErrorCode::AUTH_REQUEST_TOO_LARGE,
        "Authentication request is too large.",
        413,
        false,
    )
}

fn invalid_body() -> AuthValidationError {
    AuthValidationError::new("A complete valid UTF-8 JSON body is required.")
}

impl AuthBodyReaders {
    pub(crate) async fn read<B>(
        &self,
        request: Request<B>,
        signal: &CancellationToken,
    ) -> Result<Value, Box<dyn Error>>
    where
        B: Body<Data = Bytes> + Unpin,
        B::Error: Into<Box<dyn Error + Send + Sync>>,
    {
        self.read_with(request, signal, json::parse).await
    }

    pub(crate) async fn read_username_write<B>(
        &self,
        request: Request<B>,
        signal: &CancellationToken,
    ) -> Result<Value, Box<dyn Error>>
    where
        B: Body<Data = Bytes> + Unpin,
        B::Error: Into<Box<dyn Error + Send + Sync>>,
    {
        self.read_with(request, signal, parse_username_write).await
    }

    async fn read_with<B>(
        &self,
        request: Request<B>,
        signal: &CancellationToken,
        parse: fn(&str) -> serde_json::Result<Value>,
    ) -> Result<Value, Box<dyn Error>>
    where
        B: Body<Data = Bytes> + Unpin,
        B::Error: Into<Box<dyn Error + Send + Sync>>,
    {
        if fetch_header_value(request.headers(), &CONTENT_LENGTH)
            .and_then(|length| trim(&length).parse::<f64>().ok())
            .is_some_and(|length| length > MAX_BODY_BYTES as f64)
        {
            return Err(too_large().into());
        }
        let json_media =
            fetch_header_value(request.headers(), &CONTENT_TYPE).is_some_and(|media| {
                media
                    .split(';')
                    .next()
                    .is_some_and(|part| trim(part).eq_ignore_ascii_case("application/json"))
            });
        if !json_media || request.body().is_end_stream() {
            return Err(AuthValidationError::new("A JSON body is required.").into());
        }
        let readers = self.0.get();
        if readers >= 2 {
            return Err(DomainError::new(
                ErrorCode::AUTH_BUSY,
                "Authentication is busy. Try again shortly.",
                429,
                false,
            )
            .into());
        }
        self.0.set(readers + 1);
        let _slot = ReaderSlot(&self.0);
        if signal.is_cancelled() {
            return Err(invalid_body().into());
        }
        tokio::select! {
            biased;
            _ = signal.cancelled() => Err(invalid_body().into()),
            result = tokio::time::timeout(DEADLINE, read_json(request.into_body(), parse)) => {
                result.unwrap_or_else(|_| Err(invalid_body().into()))
            }
        }
    }
}

async fn read_json<B>(
    mut body: B,
    parse: fn(&str) -> serde_json::Result<Value>,
) -> Result<Value, Box<dyn Error>>
where
    B: Body<Data = Bytes> + Unpin,
    B::Error: Into<Box<dyn Error + Send + Sync>>,
{
    let mut bytes = Vec::new();
    let mut valid_utf8 = 0;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|error| -> Box<dyn Error> {
            let error: Box<dyn Error + Send + Sync> = error.into();
            error
        })?;
        if let Ok(chunk) = frame.into_data() {
            if chunk.len() > MAX_BODY_BYTES - bytes.len() {
                return Err(too_large().into());
            }
            bytes.extend_from_slice(&chunk);
            match std::str::from_utf8(&bytes[valid_utf8..]) {
                Ok(_) => valid_utf8 = bytes.len(),
                Err(error) if error.error_len().is_none() => valid_utf8 += error.valid_up_to(),
                Err(_) => return Err(invalid_body().into()),
            }
        }
    }
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
    let text = std::str::from_utf8(bytes).map_err(|_| invalid_body())?;
    parse(text).map_err(|_| invalid_body().into())
}

fn parse_username_write(text: &str) -> serde_json::Result<Value> {
    let (mut value, [unpaired]) = json::parse_with_unpaired_surrogate_fields(text, ["username"])?;
    if unpaired && let Some(username) = value.get_mut("username") {
        // The validator rejects this control marker in its normal check order.
        *username = Value::String("\0".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io;
    use std::pin::Pin;
    use std::rc::Rc;
    use std::task::{Context, Poll};

    use http_body_util::Full;
    use hyper::body::Frame;
    use serde_json::json;

    use super::*;

    fn request<B>(body: B) -> Request<B> {
        Request::builder()
            .header(CONTENT_TYPE, "Application/JSON; charset=utf-8")
            .body(body)
            .unwrap()
    }

    #[derive(Default)]
    struct Stream {
        chunks: VecDeque<Result<Bytes, io::Error>>,
        stalled: bool,
        dropped: Rc<Cell<bool>>,
    }

    impl Body for Stream {
        type Data = Bytes;
        type Error = io::Error;

        fn poll_frame(
            mut self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, io::Error>>> {
            match self.chunks.pop_front() {
                Some(chunk) => Poll::Ready(Some(chunk.map(Frame::data))),
                None if self.stalled => Poll::Pending,
                None => Poll::Ready(None),
            }
        }
    }

    impl Drop for Stream {
        fn drop(&mut self) {
            self.dropped.set(true);
        }
    }

    #[tokio::test]
    async fn decodes_multibyte_utf8_split_across_chunks_and_accepts_json_media_type_parameters() {
        let stream = Stream {
            chunks: "\u{feff}{\"username\":\"caf\u{e9}-\u{2603}\"}"
                .bytes()
                .map(|byte| Ok(Bytes::copy_from_slice(&[byte])))
                .collect(),
            stalled: false,
            dropped: Rc::default(),
        };
        let parsed = AuthBodyReaders::default()
            .read(request(stream), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(parsed, json!({"username": "caf\u{e9}-\u{2603}"}));
    }

    #[tokio::test]
    async fn accepts_the_exact_byte_limit_and_counts_bytes_rather_than_decoded_characters() {
        let readers = AuthBodyReaders::default();
        let signal = CancellationToken::new();
        let text = "a".repeat(4094);
        assert_eq!(
            readers
                .read(
                    request(Full::new(Bytes::from(format!("\"{text}\"")))),
                    &signal
                )
                .await
                .unwrap(),
            json!(text)
        );
        for declared in [false, true] {
            let mut oversized = request(Full::new(Bytes::from(format!(
                "\"{}\"",
                "\u{e9}".repeat(2048)
            ))));
            if declared {
                oversized
                    .headers_mut()
                    .insert(CONTENT_LENGTH, http::HeaderValue::from_static("4097"));
            }
            let error = readers.read(oversized, &signal).await.unwrap_err();
            assert_eq!(
                error.downcast_ref::<DomainError>().unwrap().code,
                ErrorCode::AUTH_REQUEST_TOO_LARGE
            );
        }
        assert_eq!(readers.0.get(), 0);
    }

    #[tokio::test]
    async fn rejects_missing_non_json_and_malformed_bodies_and_releases_the_reader_slot() {
        let readers = AuthBodyReaders::default();
        let signal = CancellationToken::new();
        for body in [b"{".as_slice(), b"\"\xff\"", b"{}\xc3"] {
            let error = readers
                .read(request(Full::new(Bytes::from_static(body))), &signal)
                .await
                .unwrap_err();
            assert_eq!(error.to_string(), invalid_body().to_string());
            assert_eq!(readers.0.get(), 0);
        }
        let stream = Stream {
            chunks: [
                Ok(Bytes::from_static(b"\"\xff")),
                Ok(Bytes::from(vec![b'x'; MAX_BODY_BYTES])),
            ]
            .into(),
            stalled: false,
            dropped: Rc::default(),
        };
        let error = readers.read(request(stream), &signal).await.unwrap_err();
        assert_eq!(error.to_string(), invalid_body().to_string());

        let mut duplicate = request(Full::new(Bytes::from_static(b"{}")));
        duplicate
            .headers_mut()
            .insert(CONTENT_TYPE, "application/json".parse().unwrap());
        duplicate
            .headers_mut()
            .append(CONTENT_TYPE, "text/plain".parse().unwrap());
        for input in [duplicate, request(Full::new(Bytes::new()))] {
            let error = readers.read(input, &signal).await.unwrap_err();
            assert_eq!(error.to_string(), "A JSON body is required.");
        }
        let stream = Stream {
            chunks: [Err(io::Error::other("Synthetic source failure"))].into(),
            stalled: false,
            dropped: Rc::default(),
        };
        let failure = readers.read(request(stream), &signal).await.unwrap_err();
        assert_eq!(failure.to_string(), "Synthetic source failure");
        assert_eq!(
            readers
                .read(request(Full::new(Bytes::from_static(b"{}"))), &signal)
                .await
                .unwrap(),
            json!({})
        );
    }

    #[tokio::test]
    async fn durable_username_writes_reject_the_original_surrogate_without_rejecting_replacement_text()
     {
        use garcon_contract::auth::{parse_change_username_request, parse_register_request};

        let readers = AuthBodyReaders::default();
        let signal = CancellationToken::new();
        for (raw, expected) in [
            (
                r#"{"username":"\uFFFDarity","password":"fixture-password"}"#,
                "\u{fffd}arity",
            ),
            (
                r#"{"username":"\uD800arity","username":"\uFFFDarity","password":"fixture-password"}"#,
                "\u{fffd}arity",
            ),
            (
                r#"{"username":"\uFFFDarity","password":"fixture-\uD800"}"#,
                "\u{fffd}arity",
            ),
            (
                r#"{"username":"\uD83D\uDE80arity","password":"fixture-password"}"#,
                "\u{1f680}arity",
            ),
            (
                r#"{"username":"\\ud800arity","password":"fixture-password"}"#,
                r"\ud800arity",
            ),
            (
                r#"{"username":"parity","password":"fixture-\ud800"}"#,
                "parity",
            ),
        ] {
            let input = request(Full::new(Bytes::from_static(raw.as_bytes())));
            let body = readers.read_username_write(input, &signal).await.unwrap();
            assert_eq!(parse_register_request(&body).unwrap().username, expected);
        }
        let raw = request(Full::new(Bytes::from_static(
            br#"{"username":"\uD800arity","password":"fixture-password"}"#,
        )));
        let body = readers.read_username_write(raw, &signal).await.unwrap();
        let error = parse_register_request(&body).unwrap_err();
        assert_eq!(
            error.to_string(),
            "Username must contain 1-64 characters on one line without controls."
        );

        let raw = request(Full::new(Bytes::from_static(
            br#"{"currentPassword":null,"username":"\uD800arity"}"#,
        )));
        let body = readers.read_username_write(raw, &signal).await.unwrap();
        assert_eq!(
            parse_change_username_request(&body)
                .unwrap_err()
                .to_string(),
            "Password is required."
        );
    }

    #[tokio::test(start_paused = true)]
    async fn bounds_concurrent_readers_and_recovers_capacity_after_abort_and_deadline() {
        let readers = AuthBodyReaders::default();
        let signal = CancellationToken::new();
        let second_signal = CancellationToken::new();
        let stalled = || Stream {
            stalled: true,
            chunks: VecDeque::new(),
            dropped: Rc::default(),
        };
        let first = stalled();
        let second = stalled();
        let first_dropped = first.dropped.clone();
        let second_dropped = second.dropped.clone();
        let mut first = std::pin::pin!(readers.read(request(first), &signal));
        let mut second = std::pin::pin!(readers.read(request(second), &second_signal));
        tokio::select! {
            biased;
            _ = &mut first => panic!("first stream should still be pending"),
            _ = &mut second => panic!("second stream should still be pending"),
            () = std::future::ready(()) => {},
        }
        let request_bytes = || request(Full::new(Bytes::from_static(b"{}")));
        let error = readers
            .read(request_bytes(), &second_signal)
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<DomainError>().unwrap().code,
            ErrorCode::AUTH_BUSY
        );
        signal.cancel();
        assert!(first.await.unwrap_err().is::<AuthValidationError>());
        assert!(first_dropped.get());
        assert_eq!(
            readers.read(request_bytes(), &second_signal).await.unwrap(),
            json!({})
        );
        assert!(second.await.unwrap_err().is::<AuthValidationError>());
        assert!(second_dropped.get());
        assert!(!second_signal.is_cancelled());
        assert_eq!(readers.0.get(), 0);
    }
}
