//! Bounded UTF-8 prefixes of byte streams.

use bytes::Bytes;
use futures::{Stream, StreamExt};

/// Drains a stream while retaining only its bounded prefix.
pub async fn read_text_stream_prefix<S, E>(
    stream: Option<&mut S>,
    max_bytes: usize,
    mut on_truncate: Option<impl FnOnce() -> Result<(), E>>,
) -> Result<String, E>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
{
    let Some(stream) = stream else {
        return Ok(String::new());
    };
    let mut prefix = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let remaining = max_bytes - prefix.len();
        if chunk.len() > remaining
            && let Some(notify) = on_truncate.take()
        {
            notify()?;
        }
        prefix.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    }
    let prefix = prefix.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&prefix);
    Ok(String::from_utf8_lossy(prefix).into_owned())
}

pub async fn read_text_stream_with_limit<S, E>(
    stream: Option<&mut S>,
    max_bytes: usize,
    create_limit_error: impl FnOnce() -> E,
) -> Result<String, E>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
{
    read_text_stream_prefix(stream, max_bytes, Some(|| Err(create_limit_error()))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream;

    #[tokio::test]
    async fn decodes_one_byte_frames_as_one_utf8_stream_and_replaces_partial_sequences() {
        let text = "\u{feff}a\u{e9}\u{1f600}z";
        for limit in 0..=text.len() + 1 {
            let chunks = text
                .bytes()
                .map(|b| Ok::<_, ()>(Bytes::copy_from_slice(&[b])));
            let mut stream = stream::iter(chunks);
            let mut truncated = 0;
            let prefix = read_text_stream_prefix(
                Some(&mut stream),
                limit,
                Some(|| {
                    truncated += 1;
                    Ok(())
                }),
            )
            .await
            .unwrap();
            let bytes = &text.as_bytes()[..limit.min(text.len())];
            let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
            assert_eq!(prefix, String::from_utf8_lossy(bytes), "{limit}");
            assert_eq!(truncated, usize::from(text.len() > limit));
            assert!(stream.next().await.is_none());
        }
    }

    #[tokio::test]
    async fn a_limit_error_does_not_cancel_the_remaining_frames() {
        let mut stream = stream::iter([
            Ok(Bytes::from_static(b"too long")),
            Ok(Bytes::from_static(b"tail")),
        ]);
        let answer = read_text_stream_with_limit(Some(&mut stream), 3, || "synthetic limit").await;
        assert_eq!(answer, Err("synthetic limit"));
        assert_eq!(stream.next().await, Some(Ok(Bytes::from_static(b"tail"))));
    }

    #[tokio::test]
    async fn reports_a_pull_failure_even_after_retaining_all_the_bytes() {
        let mut stream = stream::iter([
            Ok(Bytes::from_static(b"prefix")),
            Err("synthetic stream failure"),
        ]);
        let answer = read_text_stream_prefix(Some(&mut stream), 1, None::<fn() -> _>).await;
        assert_eq!(answer, Err("synthetic stream failure"));
    }
}
