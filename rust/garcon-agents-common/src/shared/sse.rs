//! Ports `server-agents/common/src/shared/sse.ts`.

use futures::{Stream, StreamExt};
use garcon_interface::resources::ExecutorResult;

pub async fn read_sse_data_events<T, E>(
    mut body: impl Stream<Item = Result<T, E>> + Unpin,
    mut on_data: impl FnMut(&str) -> ExecutorResult<()>,
) -> ExecutorResult<()>
where
    T: AsRef<[u8]>,
    E: Into<Box<dyn std::error::Error>>,
{
    let mut first = true;
    let mut buffer = Vec::new();
    let mut data_lines = Vec::new();
    let mut process_line = |line: &[u8]| -> ExecutorResult<()> {
        // LF cannot be part of a UTF-8 code point, even across a chunk boundary.
        let line = if std::mem::take(&mut first) {
            line.strip_prefix(b"\xef\xbb\xbf").unwrap_or(line)
        } else {
            line
        };
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            emit_event(&mut data_lines, &mut on_data)?;
        } else if line == b"data" {
            data_lines.push(String::new());
        } else if let Some(value) = line.strip_prefix(b"data:") {
            data_lines.push(
                String::from_utf8_lossy(value.strip_prefix(b" ").unwrap_or(value)).into_owned(),
            );
        }
        Ok(())
    };

    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(Into::into)?;
        for part in chunk.as_ref().split_inclusive(|byte| *byte == b'\n') {
            if let Some(line) = part.strip_suffix(b"\n") {
                if buffer.is_empty() {
                    process_line(line)?;
                } else {
                    buffer.extend_from_slice(line);
                    process_line(&buffer)?;
                    buffer.clear();
                }
            } else {
                buffer.extend_from_slice(part);
            }
        }
    }
    if !buffer.is_empty() {
        process_line(&buffer)?;
    }
    emit_event(&mut data_lines, &mut on_data)
}

fn emit_event(
    lines: &mut Vec<String>,
    on_data: &mut impl FnMut(&str) -> ExecutorResult<()>,
) -> ExecutorResult<()> {
    if !lines.is_empty() {
        on_data(&lines.join("\n"))?;
        lines.clear();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io;

    use futures::stream;

    use super::*;

    #[tokio::test]
    async fn emits_only_data_across_crlf_utf8_and_eof_boundaries() {
        let parts: &[&[u8]] = &[
            b"\xef",
            b"\xbb\xbfdata: caf\xc3",
            b"\xa9\r",
            b"\n:\n",
            b"id: ignored\ndata:\n\r\ndata\n\ndata:  extra space\ndata: \xff\n",
            b"data: eof",
        ];
        let mut events = Vec::new();
        read_sse_data_events(
            stream::iter(parts.iter().copied().map(Ok::<_, io::Error>)),
            |data| {
                events.push(data.to_owned());
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(events, ["caf\u{e9}\n", "", " extra space\n\u{fffd}\neof"]);
    }

    #[tokio::test]
    async fn stops_reading_when_the_sink_refuses_an_event() {
        let body = stream::iter([
            Ok::<_, io::Error>(b"data: accepted\n\n"),
            Err(io::Error::other("later source failure")),
        ]);
        let error = read_sse_data_events(body, |_| Err("sink refused".into()))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "sink refused");
    }
}
