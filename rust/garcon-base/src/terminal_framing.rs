//! Frames terminal messages for bounded delivery.

use base64::{Engine, engine::general_purpose::STANDARD};
use garcon_contract::terminal::{
    TerminalEncodedOutputChunk, TerminalStreamServerMessage, TerminalStreamServerPayload,
};
use garcon_js::Number;

pub const TERMINAL_STREAM_TARGET_MESSAGE_BYTES: usize = 64 * 1024;
const OUTPUT_FRAGMENT_BASE64_CHARS: usize = 48 * 1024;

pub struct SerializedTerminalMessage {
    pub payload: String,
    pub byte_length: usize,
}

pub fn serialize_terminal_message(
    message: &TerminalStreamServerMessage,
) -> Result<SerializedTerminalMessage, serde_json::Error> {
    let payload = serde_json::to_string(message)?;
    let byte_length = payload.len();
    Ok(SerializedTerminalMessage {
        payload,
        byte_length,
    })
}

pub fn expand_terminal_message_for_delivery(
    message: &TerminalStreamServerMessage,
) -> Result<Vec<TerminalStreamServerMessage>, serde_json::Error> {
    let mut expanded = expand_terminal_payload(message)?;
    if let Some(attachment_id) = message.attachment_id.as_ref().filter(|id| !id.is_empty()) {
        for part in &mut expanded {
            part.attachment_id = Some(attachment_id.clone());
        }
    }
    Ok(expanded)
}

fn expand_terminal_payload(
    message: &TerminalStreamServerMessage,
) -> Result<Vec<TerminalStreamServerMessage>, serde_json::Error> {
    use TerminalStreamServerPayload::{TerminalAttached, TerminalOutput, TerminalReplayBatch};
    if fits(message)? {
        return Ok(vec![message.clone()]);
    }
    match &message.payload {
        TerminalOutput {
            terminal_id,
            sequence,
            data,
        } => Ok(fragment_base64(
            terminal_id,
            *sequence,
            &STANDARD.encode(data),
        )),
        TerminalAttached { terminal, replay } => {
            let mut expanded = vec![TerminalStreamServerMessage {
                payload: TerminalAttached {
                    terminal: terminal.clone(),
                    replay: Vec::new(),
                },
                attachment_id: message.attachment_id.clone(),
            }];
            let make_batch = |chunks| TerminalStreamServerMessage {
                payload: TerminalReplayBatch {
                    terminal_id: terminal.terminal_id.clone(),
                    chunks,
                },
                attachment_id: None,
            };
            let mut chunks = Vec::new();
            for chunk in replay {
                let encoded = TerminalEncodedOutputChunk {
                    sequence: chunk.sequence,
                    data_base64: STANDARD.encode(&chunk.data),
                };
                let mut next = chunks.clone();
                next.push(encoded.clone());
                if fits(&make_batch(next))? {
                    chunks.push(encoded);
                    continue;
                }
                if !chunks.is_empty() {
                    expanded.push(make_batch(std::mem::take(&mut chunks)));
                }
                if fits(&make_batch(vec![encoded.clone()]))? {
                    chunks.push(encoded);
                } else {
                    expanded.extend(fragment_base64(
                        &terminal.terminal_id,
                        encoded.sequence,
                        &encoded.data_base64,
                    ));
                }
            }
            if !chunks.is_empty() {
                expanded.push(make_batch(chunks));
            }
            Ok(expanded)
        }
        _ => Ok(vec![message.clone()]),
    }
}

fn fits(message: &TerminalStreamServerMessage) -> Result<bool, serde_json::Error> {
    Ok(serialize_terminal_message(message)?.byte_length <= TERMINAL_STREAM_TARGET_MESSAGE_BYTES)
}

fn fragment_base64(
    terminal_id: &str,
    sequence: Number,
    encoded: &str,
) -> Vec<TerminalStreamServerMessage> {
    let count = encoded.len().div_ceil(OUTPUT_FRAGMENT_BASE64_CHARS).max(1);
    (0..count)
        .map(|index| {
            let start = index * OUTPUT_FRAGMENT_BASE64_CHARS;
            let end = (start + OUTPUT_FRAGMENT_BASE64_CHARS).min(encoded.len());
            TerminalStreamServerMessage {
                payload: TerminalStreamServerPayload::TerminalOutputFragment {
                    terminal_id: terminal_id.to_owned(),
                    sequence,
                    fragment_index: Number(index as f64),
                    fragment_count: Number(count as f64),
                    data_base64: encoded[start..end].to_owned(),
                },
                attachment_id: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_contract::terminal::{
        TerminalMetadata, TerminalOutputChunk, TerminalProcessStatus,
        TerminalServerAttachmentStatus,
    };

    #[test]
    fn fragments_utf8_output_without_losing_sequence_attachment_or_bytes() {
        let data = "\u{1f600}\n".repeat(20_000);
        let message = TerminalStreamServerMessage {
            payload: TerminalStreamServerPayload::TerminalOutput {
                terminal_id: "synthetic-terminal".into(),
                sequence: Number(17.0),
                data: data.clone(),
            },
            attachment_id: Some("fixture".into()),
        };
        let output = expand_terminal_message_for_delivery(&message).unwrap();
        let mut encoded = String::new();
        for (index, part) in output.iter().enumerate() {
            assert_eq!(part.attachment_id.as_deref(), Some("fixture"));
            assert!(fits(part).unwrap());
            let TerminalStreamServerPayload::TerminalOutputFragment {
                sequence,
                fragment_index,
                fragment_count,
                data_base64,
                ..
            } = &part.payload
            else {
                panic!("expected a fragment");
            };
            assert_eq!(*sequence, Number(17.0));
            assert_eq!(*fragment_index, Number(index as f64));
            assert_eq!(*fragment_count, Number(output.len() as f64));
            encoded.push_str(data_base64);
        }
        assert_eq!(STANDARD.decode(encoded).unwrap(), data.into_bytes());
    }

    #[test]
    fn flushes_replay_batches_before_an_overlong_chunk_and_after_it() {
        let terminal = TerminalMetadata {
            terminal_id: "fixture".into(),
            display_sequence: Number(1.0),
            title: None,
            initial_working_directory: "/fixture".into(),
            process_status: TerminalProcessStatus::Running,
            attachment_status: TerminalServerAttachmentStatus::Attached,
            created_at: "1970-01-01T00:00:00.000Z".into(),
            exit_code: None,
            latest_output_sequence: Number(3.0),
        };
        let replay = [
            (1.0, "small".into()),
            (2.0, "x".repeat(66_000)),
            (3.0, "tail".into()),
        ]
        .into_iter()
        .map(|(sequence, data)| TerminalOutputChunk {
            sequence: Number(sequence),
            data,
        })
        .collect();
        let output = expand_terminal_message_for_delivery(&TerminalStreamServerMessage {
            payload: TerminalStreamServerPayload::TerminalAttached { terminal, replay },
            attachment_id: Some("fixture-attachment".into()),
        })
        .unwrap();
        assert_eq!(output.len(), 5);
        assert!(
            matches!(&output[0].payload, TerminalStreamServerPayload::TerminalAttached { replay, .. } if replay.is_empty())
        );
        for index in [1, 4] {
            assert!(
                matches!(&output[index].payload, TerminalStreamServerPayload::TerminalReplayBatch { chunks, .. } if chunks.len() == 1)
            );
        }
        for part in output {
            assert!(fits(&part).unwrap());
            assert_eq!(part.attachment_id.as_deref(), Some("fixture-attachment"));
        }
    }
}
