//! Ports `server/runtime/terminals/terminal-replay-buffer.ts`.

use std::collections::VecDeque;

use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_contract::terminal::TerminalOutputChunk;
use garcon_js::Number;

pub const DEFAULT_TERMINAL_REPLAY_BYTES: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
#[error("Terminal replay byte limit must be a positive integer")]
pub struct InvalidTerminalReplayLimit;

impl DiagnosticError for InvalidTerminalReplayLimit {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        ErrorMetadata {
            name: "RangeError",
            code: None,
        }
    }
}

pub struct TerminalReplayBuffer {
    limit_bytes: f64,
    chunks: VecDeque<TerminalOutputChunk>,
    bytes: usize,
    first_retained_sequence: Number,
}

impl TerminalReplayBuffer {
    pub fn new(limit_bytes: Option<f64>) -> Result<Self, InvalidTerminalReplayLimit> {
        let limit_bytes = limit_bytes.unwrap_or(DEFAULT_TERMINAL_REPLAY_BYTES as f64);
        if !limit_bytes.is_finite() || limit_bytes.fract() != 0.0 || limit_bytes < 1.0 {
            return Err(InvalidTerminalReplayLimit);
        }
        Ok(Self {
            limit_bytes,
            chunks: VecDeque::new(),
            bytes: 0,
            first_retained_sequence: Number(1.0),
        })
    }

    pub fn first_retained_sequence(&self) -> Number {
        self.first_retained_sequence
    }

    pub fn byte_length(&self) -> usize {
        self.bytes
    }

    pub fn append(&mut self, chunk: TerminalOutputChunk) {
        let bytes = chunk.data.len();
        if bytes as f64 > self.limit_bytes {
            self.chunks.clear();
            self.bytes = 0;
            self.first_retained_sequence = Number(chunk.sequence.0 + 1.0);
            return;
        }
        self.chunks.push_back(chunk);
        self.bytes += bytes;
        while self.bytes as f64 > self.limit_bytes {
            let Some(removed) = self.chunks.pop_front() else {
                break;
            };
            self.bytes -= removed.data.len();
            self.first_retained_sequence = Number(removed.sequence.0 + 1.0);
        }
        if let Some(chunk) = self.chunks.front() {
            self.first_retained_sequence = chunk.sequence;
        }
    }

    pub fn after(&self, sequence: Number) -> Vec<TerminalOutputChunk> {
        self.chunks
            .iter()
            .filter(|chunk| chunk.sequence.0 > sequence.0)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, unknown};
    use garcon_js::json::from_slice;
    use serde::{Deserialize, Serialize};
    use serde_json::{Value, to_vec};

    use super::*;

    #[derive(Deserialize)]
    struct InputChunk {
        sequence: Number,
        data: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Snapshot {
        byte_length: usize,
        first_retained_sequence: Number,
        chunks: Vec<TerminalOutputChunk>,
    }

    #[test]
    fn recorded_terminal_replay_buffer_matches() {
        let stats = replay(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/cases/terminals/replay-buffer"
            ),
            |function, args| {
                if function != "replayTerminalOutput" {
                    return Err(CaseError::unhandled(function));
                }
                let number = |index| {
                    unknown(function, args.get(index))?
                        .as_f64()
                        .ok_or_else(|| CaseError::undeliverable("expected a numeric argument"))
                };
                let chunks = unknown(function, args.get(1))?;
                let chunks: Vec<InputChunk> = from_slice(&to_vec(&*chunks).unwrap())
                    .map_err(|error| CaseError::undeliverable(error.to_string()))?;
                let mut buffer = TerminalReplayBuffer::new(Some(number(0)?)).map_err(|error| {
                    CaseError::new(error.diagnostic_metadata().name, error.to_string())
                })?;
                for InputChunk { sequence, data } in chunks {
                    buffer.append(TerminalOutputChunk { sequence, data });
                }
                let result = Snapshot {
                    byte_length: buffer.byte_length(),
                    first_retained_sequence: buffer.first_retained_sequence(),
                    chunks: buffer.after(Number(number(2)?)),
                };
                Ok(from_slice::<Value>(&to_vec(&result).unwrap()).unwrap())
            },
        );
        assert_eq!(stats.with_wildcards, 0);
    }
}
