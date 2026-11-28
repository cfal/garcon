//! Ports `server/controller/chats/carryover/page-codec.ts`.

use std::{
    fs::File,
    io::{self, Read},
    path::Path,
};

use brotli::{CompressorReader, Decompressor};
use garcon_base::{
    errors::{DiagnosticError, ErrorMetadata},
    keyed_lock::LockAborted,
    stored_json::{MalformedStoredJsonError, parse_stored_json},
};
use garcon_contract::{
    async_user_questions::InvalidAsyncQuestionReply,
    chat_types::{ChatMessage, parse_chat_messages},
};
use sha2::{Digest, Sha256};
use tokio::{fs, io::AsyncWriteExt, task};
use tokio_util::sync::CancellationToken;

use super::segment_types::{CarryOverPageDescriptor, canonical_page_file};

pub const CARRYOVER_PAGE_MAX_MESSAGES: usize = 256;
pub const CARRYOVER_PAGE_TARGET_BYTES: usize = 1024 * 1024;
const STREAM_CHUNK: usize = 16 * 1024;

#[derive(Debug)]
pub struct EncodedCarryOverPage {
    pub descriptor: CarryOverPageDescriptor,
    pub bytes: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct CarryOverPageIntegrityError {
    message: &'static str,
    #[source]
    cause: Option<IntegrityCause>,
}

#[derive(Debug, thiserror::Error)]
enum IntegrityCause {
    #[error(transparent)]
    Brotli(io::Error),
    #[error(transparent)]
    Json(#[from] MalformedStoredJsonError),
    #[error(transparent)]
    Question(#[from] InvalidAsyncQuestionReply),
}

impl DiagnosticError for CarryOverPageIntegrityError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "CarryOverPageIntegrityError",
            code: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CarryOverPageCodecError {
    #[error(transparent)]
    Aborted(#[from] LockAborted),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Integrity(#[from] CarryOverPageIntegrityError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Worker(#[from] task::JoinError),
}

pub async fn encode_carry_over_pages(
    messages: Vec<ChatMessage>,
    signal: Option<&CancellationToken>,
) -> Result<Vec<EncodedCarryOverPage>, CarryOverPageCodecError> {
    Ok(encode_segment_pages(messages, signal).await?.pages)
}

pub(super) struct EncodedSegmentPages {
    pub pages: Vec<EncodedCarryOverPage>,
    pub canonical_messages_sha256: String,
}

pub(super) async fn encode_segment_pages(
    messages: Vec<ChatMessage>,
    signal: Option<&CancellationToken>,
) -> Result<EncodedSegmentPages, CarryOverPageCodecError> {
    let signal = signal.cloned();
    task::spawn_blocking(move || encode_pages(messages, signal.as_ref())).await?
}

fn encode_pages(
    messages: Vec<ChatMessage>,
    signal: Option<&CancellationToken>,
) -> Result<EncodedSegmentPages, CarryOverPageCodecError> {
    let mut pages = Vec::new();
    let mut canonical_digest = Sha256::new_with_prefix(b"[");
    let mut contents = vec![b'['];
    let mut first_sequence = 0;
    let mut count = 0;
    for (index, message) in messages.into_iter().enumerate() {
        check_signal(signal)?;
        let serialized = serde_json::to_vec(&message)?;
        if index != 0 {
            canonical_digest.update(b",");
        }
        canonical_digest.update(&serialized);
        if count != 0
            && (count >= CARRYOVER_PAGE_MAX_MESSAGES
                || contents.len() + serialized.len() + 2 > CARRYOVER_PAGE_TARGET_BYTES)
        {
            pages.push(encode_page(
                contents,
                pages.len(),
                first_sequence,
                count,
                signal,
            )?);
            first_sequence += count as u64;
            contents = vec![b'['];
            count = 0;
        }
        if count != 0 {
            contents.push(b',');
        }
        contents.extend_from_slice(&serialized);
        count += 1;
    }
    if count != 0 {
        pages.push(encode_page(
            contents,
            pages.len(),
            first_sequence,
            count,
            signal,
        )?);
    }
    canonical_digest.update(b"]");
    Ok(EncodedSegmentPages {
        pages,
        canonical_messages_sha256: format!("{:x}", canonical_digest.finalize()),
    })
}

fn encode_page(
    mut contents: Vec<u8>,
    index: usize,
    first_sequence: u64,
    count: usize,
    signal: Option<&CancellationToken>,
) -> Result<EncodedCarryOverPage, CarryOverPageCodecError> {
    check_signal(signal)?;
    contents.push(b']');
    let mut compressor = CompressorReader::new(contents.as_slice(), STREAM_CHUNK, 5, 22);
    let mut bytes = Vec::new();
    let mut chunk = vec![0; STREAM_CHUNK];
    loop {
        check_signal(signal)?;
        let length = compressor.read(&mut chunk)?;
        if length == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..length]);
    }
    check_signal(signal)?;
    Ok(EncodedCarryOverPage {
        descriptor: CarryOverPageDescriptor {
            file: canonical_page_file(index),
            first_sequence,
            message_count: count as u64,
            uncompressed_bytes: contents.len() as u64,
            compressed_bytes: bytes.len() as u64,
            sha256: digest(&contents),
        },
        bytes,
    })
}

pub async fn write_encoded_carry_over_page(
    path: &Path,
    page: &EncodedCarryOverPage,
) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(&page.bytes).await?;
    file.sync_all().await
}

pub async fn decode_carry_over_page(
    path: &Path,
    descriptor: &CarryOverPageDescriptor,
    signal: Option<&CancellationToken>,
) -> Result<Vec<ChatMessage>, CarryOverPageCodecError> {
    check_signal(signal)?;
    let path = path.to_owned();
    let descriptor = descriptor.clone();
    let signal = signal.cloned();
    task::spawn_blocking(move || decode_page(&path, &descriptor, signal.as_ref())).await?
}

fn decode_page(
    path: &Path,
    descriptor: &CarryOverPageDescriptor,
    signal: Option<&CancellationToken>,
) -> Result<Vec<ChatMessage>, CarryOverPageCodecError> {
    check_signal(signal)?;
    let stat = std::fs::metadata(path)?;
    if !stat.is_file() || stat.len() != descriptor.compressed_bytes {
        return Err(integrity(
            "Carryover page compressed size differs from its manifest",
        ));
    }
    let mut source = PageSource {
        file: File::open(path)?,
        failure: None,
    };
    let contents = decompress(&mut source, descriptor.uncompressed_bytes, signal)?;
    if contents.len() as u64 != descriptor.uncompressed_bytes {
        return Err(integrity(
            "Carryover page uncompressed size differs from its manifest",
        ));
    }
    if digest(&contents) != descriptor.sha256 {
        return Err(integrity("Carryover page checksum mismatch"));
    }
    let json = parse_stored_json(&String::from_utf8_lossy(&contents), "Carryover page")
        .map_err(invalid_payload)?;
    let messages = parse_chat_messages(&json).map_err(invalid_payload)?;
    if messages.len() as u64 != descriptor.message_count {
        return Err(integrity(
            "Carryover page message count differs from its manifest",
        ));
    }
    Ok(messages)
}

fn decompress(
    source: &mut PageSource<impl Read>,
    limit: u64,
    signal: Option<&CancellationToken>,
) -> Result<Vec<u8>, CarryOverPageCodecError> {
    let mut reader = Decompressor::new(&mut *source, STREAM_CHUNK);
    let mut contents = Vec::new();
    let mut chunk = vec![0; STREAM_CHUNK];
    loop {
        check_signal(signal)?;
        let length = match reader.read(&mut chunk) {
            Ok(length) => length,
            Err(error) => {
                drop(reader);
                check_signal(signal)?;
                return Err(match source.failure.take() {
                    Some(error) => error.into(),
                    None => CarryOverPageIntegrityError {
                        message: "Carryover page cannot be decompressed",
                        cause: Some(IntegrityCause::Brotli(error)),
                    }
                    .into(),
                });
            }
        };
        if length == 0 {
            break;
        }
        if contents.len() as u64 + length as u64 > limit {
            return Err(integrity("Carryover page expands beyond its declared size"));
        }
        contents.extend_from_slice(&chunk[..length]);
    }
    check_signal(signal)?;
    Ok(contents)
}

struct PageSource<R> {
    file: R,
    failure: Option<io::Error>,
}

impl<R: Read> Read for PageSource<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.file.read(buffer).map_err(|error| {
            let kind = error.kind();
            self.failure = Some(error);
            kind.into()
        })
    }
}

pub(super) fn integrity(message: &'static str) -> CarryOverPageCodecError {
    CarryOverPageIntegrityError {
        message,
        cause: None,
    }
    .into()
}

fn invalid_payload(error: impl Into<IntegrityCause>) -> CarryOverPageCodecError {
    CarryOverPageIntegrityError {
        message: "Carryover page payload is invalid",
        cause: Some(error.into()),
    }
    .into()
}

pub(super) fn digest(contents: &[u8]) -> String {
    format!("{:x}", Sha256::digest(contents))
}

pub(super) fn check_signal(signal: Option<&CancellationToken>) -> Result<(), LockAborted> {
    if signal.is_some_and(CancellationToken::is_cancelled) {
        Err(LockAborted)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_decode_observes_cancellation_before_publishing() {
        struct CancellingSource<'a> {
            bytes: &'a [u8],
            signal: &'a CancellationToken,
        }

        impl Read for CancellingSource<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                let count = self.bytes.read(buffer)?;
                self.signal.cancel();
                Ok(count)
            }
        }

        let signal = CancellationToken::new();
        let encoded = encode_page(b"[\"synthetic\"".to_vec(), 0, 0, 1, None).unwrap();
        let mut source = PageSource {
            file: CancellingSource {
                bytes: &encoded.bytes,
                signal: &signal,
            },
            failure: None,
        };
        assert!(matches!(
            decompress(
                &mut source,
                encoded.descriptor.uncompressed_bytes,
                Some(&signal)
            ),
            Err(CarryOverPageCodecError::Aborted(_)),
        ));
    }
}
