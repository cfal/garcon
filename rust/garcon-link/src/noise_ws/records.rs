use super::errors::{NoiseError, NoiseErrorCode};
use super::options::{MAX_FRAME_BYTES, NoiseMessage};

pub const CLIENT_READY: u8 = 1;
pub const SERVER_READY: u8 = 2;
pub const CLOSE: u8 = 3;
const TEXT: u8 = 16;
const BINARY: u8 = 17;
const CONTINUE: u8 = 18;
const START_HEADER_BYTES: usize = 5;
const TAG_BYTES: usize = 16;
const FIRST_PAYLOAD_BYTES: usize = MAX_FRAME_BYTES - TAG_BYTES - START_HEADER_BYTES;
const NEXT_PAYLOAD_BYTES: usize = MAX_FRAME_BYTES - TAG_BYTES - 1;

pub fn record_count(length: usize) -> usize {
    1 + length
        .saturating_sub(FIRST_PAYLOAD_BYTES)
        .div_ceil(NEXT_PAYLOAD_BYTES)
}

pub fn encoded_bytes(length: usize) -> usize {
    let count = record_count(length);
    // Reserves room for WebSocket framing/masking as well as encrypted headers/tags.
    length + 4 + count * (1 + TAG_BYTES + 14)
}

/// The plaintext records of one message: a start that declares the total
/// length, then continuations. Each fragment is exactly the smaller of its
/// capacity and the remaining length.
pub fn message_records(payload: &[u8], text: bool) -> MessageRecords<'_> {
    // INFALLIBLE: a message is capped far below 4 GiB before it is split into records.
    let total = u32::try_from(payload.len()).expect("a message length fits in 32 bits");
    MessageRecords {
        payload,
        kind: if text { TEXT } else { BINARY },
        total,
        offset: 0,
        started: false,
    }
}

pub struct MessageRecords<'a> {
    payload: &'a [u8],
    kind: u8,
    total: u32,
    offset: usize,
    started: bool,
}

impl Iterator for MessageRecords<'_> {
    type Item = Vec<u8>;

    fn next(&mut self) -> Option<Self::Item> {
        // The start record is written once, for an empty message too.
        let first = !self.started;
        if !first && self.offset >= self.payload.len() {
            return None;
        }
        self.started = true;
        let capacity = if first {
            FIRST_PAYLOAD_BYTES
        } else {
            NEXT_PAYLOAD_BYTES
        };
        let end = (self.offset + capacity).min(self.payload.len());
        let mut record = Vec::with_capacity(self.payload[self.offset..end].len() + 1);
        if first {
            record.push(self.kind);
            record.extend_from_slice(&self.total.to_be_bytes());
        } else {
            record.push(CONTINUE);
        }
        record.extend_from_slice(&self.payload[self.offset..end]);
        self.offset = end;
        Some(record)
    }
}

/// Reassembles the records of the one message in progress. There is no
/// interleaving or partial delivery.
#[derive(Default)]
pub struct MessageAssembler {
    payload: Vec<u8>,
    received: usize,
    total: usize,
    text: bool,
    active: bool,
}

impl MessageAssembler {
    /// Whether a message has started and is not yet complete.
    pub fn active(&self) -> bool {
        self.active
    }

    /// Returns the complete message once its last record arrives.
    pub fn receive(
        &mut self,
        record: &[u8],
        max_bytes: usize,
    ) -> Result<Option<NoiseMessage>, NoiseError> {
        let kind = record.first().copied();
        let is_first = kind == Some(TEXT) || kind == Some(BINARY);
        if is_first {
            if self.active || record.len() < START_HEADER_BYTES {
                return Err(NoiseErrorCode::ProtocolError.into());
            }
            // INFALLIBLE: the record holds the five header bytes this branch requires.
            let length: [u8; 4] = record[1..START_HEADER_BYTES]
                .try_into()
                .expect("the start record holds its header");
            self.total = u32::from_be_bytes(length) as usize;
            if self.total > max_bytes {
                return Err(NoiseErrorCode::MessageTooLarge.into());
            }
            self.text = kind == Some(TEXT);
            self.active = true;
        } else if kind != Some(CONTINUE) || !self.active {
            return Err(NoiseErrorCode::ProtocolError.into());
        }

        let chunk = &record[if is_first { START_HEADER_BYTES } else { 1 }..];
        let capacity = if is_first {
            FIRST_PAYLOAD_BYTES
        } else {
            NEXT_PAYLOAD_BYTES
        };
        let expected_bytes = (self.total - self.received).min(capacity);
        if chunk.len() != expected_bytes {
            return Err(NoiseErrorCode::ProtocolError.into());
        }
        self.payload.extend_from_slice(chunk);
        self.received += chunk.len();
        if self.received != self.total {
            return Ok(None);
        }

        let text = self.text;
        let payload = std::mem::take(&mut self.payload);
        self.clear();
        if !text {
            return Ok(Some(NoiseMessage::Binary(payload)));
        }
        // Fatal decoding, and a byte-order mark stays part of the text.
        String::from_utf8(payload)
            .map(|text| Some(NoiseMessage::Text(text)))
            .map_err(|_| NoiseErrorCode::ProtocolError.into())
    }

    pub fn clear(&mut self) {
        self.payload = Vec::new();
        self.total = 0;
        self.received = 0;
        self.active = false;
    }
}
