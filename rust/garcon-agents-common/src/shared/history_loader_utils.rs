//! Ports `server-agents/common/src/shared/history-loader-utils.ts`.

use std::io;

use futures::{
    StreamExt, TryStreamExt,
    stream::{self, LocalBoxStream},
};
use garcon_base::errors::NamedError;
use garcon_interface::resources::ExecutorResult;
use garcon_js::trim;
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

const READ_BUFFER_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonlLineEntry {
    pub line: String,
    pub byte_offset: u64,
    pub line_number: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct JsonlLineReadOptions {
    pub complete_lines_only: bool,
    pub include_empty_lines: bool,
    pub max_line_bytes: Option<u64>,
    pub max_read_bytes: Option<u64>,
    pub signal: Option<CancellationToken>,
}

/// Reads the lines of a JSONL file one at a time, in 64 KiB chunks, with the
/// byte offset and number of each. A line is decoded once it is whole, so a
/// record longer than a chunk survives it.
pub fn read_jsonl_line_entries(
    file_path: &str,
    options: JsonlLineReadOptions,
) -> LocalBoxStream<'static, ExecutorResult<JsonlLineEntry>> {
    let file_path = file_path.to_owned();
    stream::once(async move {
        let file = tokio::fs::File::open(file_path).await?;
        Ok::<_, Box<dyn std::error::Error>>(Scan {
            file,
            options,
            position: 0,
            line_start_byte_offset: 0,
            line_number: 1,
            pending: Vec::new(),
            chunk: Vec::new(),
            segment_start: 0,
            chunk_start_offset: 0,
            buffer: vec![0; READ_BUFFER_BYTES as usize],
            finished: false,
        })
    })
    .map_ok(|scan| stream::try_unfold(scan, next_entry))
    .try_flatten()
    .boxed_local()
}

// Where the scan stands in a file.
struct Scan {
    file: tokio::fs::File,
    options: JsonlLineReadOptions,
    position: u64,
    line_start_byte_offset: u64,
    line_number: u64,
    // The start of the line being assembled, from the chunks read before this one.
    pending: Vec<u8>,
    chunk: Vec<u8>,
    segment_start: usize,
    chunk_start_offset: u64,
    buffer: Vec<u8>,
    finished: bool,
}

async fn next_entry(mut scan: Scan) -> ExecutorResult<Option<(JsonlLineEntry, Scan)>> {
    if scan.finished {
        return Ok(None);
    }
    while !scan.finished {
        if let Some(entry) = scan.completed_line()? {
            return Ok(Some((entry, scan)));
        }
        // What is left of the chunk holds no line break: it starts the next line.
        let rest = &scan.chunk[scan.segment_start..];
        let length = scan.pending.len() + rest.len();
        scan.assert_line_length(length as u64)?;
        scan.pending.extend_from_slice(rest);
        scan.chunk.clear();
        scan.segment_start = 0;

        if scan
            .options
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(NamedError {
                name: "AbortError".to_owned(),
                message: "Transcript search load cancelled".to_owned(),
                code: None,
            }
            .into());
        }
        let remaining = scan
            .options
            .max_read_bytes
            .map_or(u64::MAX, |limit| limit.saturating_sub(scan.position));
        // At the limit a one-byte read distinguishes EOF from a truncated record.
        let read_length = if remaining == 0 {
            1
        } else {
            remaining.min(READ_BUFFER_BYTES)
        };
        let bytes_read = scan
            .file
            .read(&mut scan.buffer[..read_length as usize])
            .await?;
        if bytes_read == 0 {
            scan.finished = true;
            break;
        }
        if remaining == 0 {
            return Err(io::Error::other(format!(
                "JSONL scan exceeds {} bytes",
                scan.options.max_read_bytes.unwrap_or_default()
            ))
            .into());
        }
        scan.chunk_start_offset = scan.position;
        scan.position += bytes_read as u64;
        scan.chunk = scan.buffer[..bytes_read].to_vec();
        scan.segment_start = 0;
    }
    // The last record may have lost its newline.
    if !scan.pending.is_empty() && !scan.options.complete_lines_only {
        let line = String::from_utf8_lossy(&scan.pending).into_owned();
        if !trim(&line).is_empty() || scan.options.include_empty_lines {
            return Ok(Some((
                JsonlLineEntry {
                    line,
                    byte_offset: scan.line_start_byte_offset,
                    line_number: Some(scan.line_number),
                },
                scan,
            )));
        }
    }
    Ok(None)
}

impl Scan {
    // The next complete line of the chunk, when it holds one.
    fn completed_line(&mut self) -> ExecutorResult<Option<JsonlLineEntry>> {
        while let Some(newline) = memchr::memchr(b'\n', &self.chunk[self.segment_start..]) {
            let index = self.segment_start + newline;
            let segment = &self.chunk[self.segment_start..index];
            self.assert_line_length((self.pending.len() + segment.len()) as u64)?;
            let line = if self.pending.is_empty() {
                String::from_utf8_lossy(segment).into_owned()
            } else {
                self.pending.extend_from_slice(segment);
                let line = String::from_utf8_lossy(&self.pending).into_owned();
                self.pending.clear();
                line
            };
            self.segment_start = index + 1;
            let byte_offset = self.line_start_byte_offset;
            let line_number = self.line_number;
            self.line_start_byte_offset = self.chunk_start_offset + self.segment_start as u64;
            self.line_number += 1;
            if !trim(&line).is_empty() || self.options.include_empty_lines {
                return Ok(Some(JsonlLineEntry {
                    line,
                    byte_offset,
                    line_number: Some(line_number),
                }));
            }
        }
        Ok(None)
    }

    fn assert_line_length(&self, length: u64) -> ExecutorResult<()> {
        if self
            .options
            .max_line_bytes
            .is_some_and(|max_line_bytes| length > max_line_bytes)
        {
            return Err(io::Error::other(format!(
                "JSONL record exceeds {} bytes",
                self.options.max_line_bytes.unwrap_or_default()
            ))
            .into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use futures::TryStreamExt;

    use super::*;

    async fn fixture(text: &[u8]) -> (tempfile::TempDir, String) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        tokio::fs::write(&path, text).await.unwrap();
        (directory, path.to_string_lossy().into_owned())
    }

    async fn entries(
        path: &str,
        options: JsonlLineReadOptions,
    ) -> ExecutorResult<Vec<JsonlLineEntry>> {
        read_jsonl_line_entries(path, options).try_collect().await
    }

    fn entry(line: &str, byte_offset: u64, line_number: u64) -> JsonlLineEntry {
        JsonlLineEntry {
            line: line.to_owned(),
            byte_offset,
            line_number: Some(line_number),
        }
    }

    #[tokio::test]
    async fn reads_each_line_with_its_offset_and_number() {
        let (_directory, path) = fixture(b"{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n").await;

        let lines = entries(&path, JsonlLineReadOptions::default())
            .await
            .unwrap();

        assert_eq!(
            lines,
            [
                entry("{\"a\":1}", 0, 1),
                entry("{\"b\":2}", 8, 2),
                entry("{\"c\":3}", 16, 3),
            ]
        );
    }

    #[tokio::test]
    async fn skips_blank_lines_unless_asked_to_include_them() {
        let (_directory, path) = fixture(b"a\n\n   \n\tb\n").await;

        let lines = entries(&path, JsonlLineReadOptions::default())
            .await
            .unwrap();
        assert_eq!(lines, [entry("a", 0, 1), entry("\tb", 7, 4)]);

        let lines = entries(
            &path,
            JsonlLineReadOptions {
                include_empty_lines: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            lines,
            [
                entry("a", 0, 1),
                entry("", 2, 2),
                entry("   ", 3, 3),
                entry("\tb", 7, 4),
            ]
        );
    }

    #[tokio::test]
    async fn keeps_the_last_record_without_its_newline_unless_only_complete_lines_are_wanted() {
        let (_directory, path) = fixture(b"a\nb").await;

        let lines = entries(&path, JsonlLineReadOptions::default())
            .await
            .unwrap();
        assert_eq!(lines, [entry("a", 0, 1), entry("b", 2, 2)]);

        let lines = entries(
            &path,
            JsonlLineReadOptions {
                complete_lines_only: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(lines, [entry("a", 0, 1)]);
    }

    #[tokio::test]
    async fn a_record_survives_the_chunk_boundary() {
        // The two bytes of `é` straddle the 64 KiB boundary, and the second record is longer than a chunk.
        let long = format!("{}\n", "x".repeat(READ_BUFFER_BYTES as usize * 2));
        let mut text = "a".repeat(READ_BUFFER_BYTES as usize - 1);
        text.push('é');
        text.push('\n');
        text.push_str(&long);
        text.push_str("café\n");
        let (_directory, path) = fixture(text.as_bytes()).await;

        let lines = entries(&path, JsonlLineReadOptions::default())
            .await
            .unwrap();

        assert_eq!(lines.len(), 3);
        let mut first = "a".repeat(READ_BUFFER_BYTES as usize - 1);
        first.push('é');
        assert_eq!(lines[0], entry(&first, 0, 1));
        assert_eq!(lines[1], entry(long.trim_end(), READ_BUFFER_BYTES + 2, 2));
        assert_eq!(lines[2], entry("café", 3 * READ_BUFFER_BYTES + 3, 3));
    }

    #[tokio::test]
    async fn returns_the_same_rows_and_terminal_error_bytes_as_bun() {
        let (_directory, path) = fixture(b"{\"a\":1}\n\n \n{\"b\":2}\r\n{\"c\":3}").await;
        let output = tokio::process::Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/history-loader-utils.ts"
            ))
            .arg(&path)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut outcomes = Vec::new();
        for options in [
            JsonlLineReadOptions::default(),
            JsonlLineReadOptions {
                complete_lines_only: true,
                include_empty_lines: true,
                ..Default::default()
            },
            JsonlLineReadOptions {
                max_read_bytes: Some(10),
                ..Default::default()
            },
        ] {
            let mut read = read_jsonl_line_entries(&path, options);
            let mut rows = Vec::new();
            let error = loop {
                match read.try_next().await {
                    Ok(Some(entry)) => rows.push(serde_json::json!({
                        "line": entry.line, "byteOffset": entry.byte_offset, "lineNumber": entry.line_number,
                    })),
                    Ok(None) => break None,
                    Err(error) => break Some(error.to_string()),
                }
            };
            outcomes.push(serde_json::json!({ "rows": rows, "error": error }));
        }
        assert_eq!(serde_json::to_vec(&outcomes).unwrap(), output.stdout);
    }

    #[tokio::test]
    async fn a_record_past_the_line_limit_is_refused() {
        let (_directory, path) = fixture(b"short\nthis one is long\n").await;

        let error = entries(
            &path,
            JsonlLineReadOptions {
                max_line_bytes: Some(10),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();

        assert_eq!(error.to_string(), "JSONL record exceeds 10 bytes");
    }

    #[tokio::test]
    async fn a_scan_stops_at_the_read_limit() {
        let (_directory, path) = fixture(b"aa\nbb\ncc\ndd\n").await;
        let at_limit = JsonlLineReadOptions {
            max_read_bytes: Some(12),
            ..Default::default()
        };
        assert_eq!(entries(&path, at_limit).await.unwrap().len(), 4);

        let mut lines = read_jsonl_line_entries(
            &path,
            JsonlLineReadOptions {
                max_read_bytes: Some(11),
                ..Default::default()
            },
        );
        let mut seen = Vec::new();
        let error = loop {
            match lines.try_next().await {
                Ok(Some(entry)) => seen.push(entry),
                Ok(None) => panic!("the scan must refuse the record past the limit"),
                Err(error) => break error,
            }
        };
        assert_eq!(
            seen,
            [entry("aa", 0, 1), entry("bb", 3, 2), entry("cc", 6, 3)]
        );
        assert_eq!(error.to_string(), "JSONL scan exceeds 11 bytes");
    }

    #[tokio::test]
    async fn an_empty_file_a_cancelled_scan_and_a_missing_file() {
        let (_directory, path) = fixture(b"").await;
        assert!(
            entries(&path, JsonlLineReadOptions::default())
                .await
                .unwrap()
                .is_empty()
        );

        let (_directory, path) = fixture(b"a\nb\n").await;
        let signal = CancellationToken::new();
        signal.cancel();
        let error = entries(
            &path,
            JsonlLineReadOptions {
                signal: Some(signal),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        let error = error.downcast_ref::<NamedError>().unwrap();
        assert_eq!(error.name, "AbortError");
        assert_eq!(error.message, "Transcript search load cancelled");

        let error = entries(
            "/absent/garcon-session.jsonl",
            JsonlLineReadOptions::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.downcast_ref::<io::Error>().unwrap().kind(),
            io::ErrorKind::NotFound
        );
    }
}
