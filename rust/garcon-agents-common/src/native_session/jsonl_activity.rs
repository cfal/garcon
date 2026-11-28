//! Ports `server-agents/common/src/native-session/jsonl-activity.ts`.

use std::io::{self, SeekFrom};
use std::rc::Rc;

use async_trait::async_trait;
use garcon_base::errors::NamedError;
use garcon_interface::native_history::{
    AgentNativeActivity, AgentNativeActivityProbe, AgentNativeActivityResult,
};
use garcon_interface::resources::ExecutorResult;
use garcon_interface::transcript::AgentNativeSessionRef;
use garcon_js::clock::to_iso_string;
use garcon_js::date_parse::date_parse;
use garcon_js::json::Opaque;
use garcon_js::{OptionalNullable, trim};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::sync::CancellationToken;

use super::path_native_session::PathNativeSessionCodec;
use crate::execution::admission::check_signal;

const DEFAULT_TAIL_BYTES: u64 = 256 * 1024;

/// A timestamp a provider's transcript entry carries: a value, `null`, or none.
pub type JsonlActivityTimestamp = OptionalNullable<String>;
pub type ActivityTimestampReader = dyn Fn(&Opaque) -> ExecutorResult<JsonlActivityTimestamp>;

pub struct JsonlNativeActivityProbeOptions {
    pub native_sessions: Rc<PathNativeSessionCodec>,
    pub activity_timestamp: Rc<ActivityTimestampReader>,
    pub max_tail_bytes: Option<u64>,
}

pub struct JsonlNativeActivityProbe {
    native_sessions: Rc<PathNativeSessionCodec>,
    activity_timestamp: Rc<ActivityTimestampReader>,
    max_tail_bytes: u64,
}

pub fn create_jsonl_native_activity_probe(
    options: JsonlNativeActivityProbeOptions,
) -> Result<JsonlNativeActivityProbe, NamedError> {
    let max_tail_bytes = options.max_tail_bytes.unwrap_or(DEFAULT_TAIL_BYTES);
    if !(1..=9_007_199_254_740_991).contains(&max_tail_bytes) {
        return Err(NamedError {
            name: "TypeError".to_owned(),
            message: "Native activity tail size must be a positive integer".to_owned(),
            code: None,
        });
    }
    Ok(JsonlNativeActivityProbe {
        native_sessions: options.native_sessions,
        activity_timestamp: options.activity_timestamp,
        max_tail_bytes,
    })
}

#[async_trait(?Send)]
impl AgentNativeActivityProbe for JsonlNativeActivityProbe {
    async fn last_activity(
        &self,
        native_session: AgentNativeSessionRef,
        signal: CancellationToken,
    ) -> ExecutorResult<AgentNativeActivityResult> {
        check_signal(Some(&signal))?;
        let path = match self.native_sessions.decode(Some(&native_session)) {
            Ok(value) => value.path,
            Err(_) => return Ok(AgentNativeActivityResult::Unavailable),
        };
        let Some(path) = path else {
            return Ok(AgentNativeActivityResult::Unavailable);
        };
        match read_jsonl_activity(
            &path,
            self.max_tail_bytes,
            self.activity_timestamp.as_ref(),
            &signal,
        )
        .await
        {
            Ok(result) => Ok(result),
            Err(_) => {
                check_signal(Some(&signal))?;
                Ok(AgentNativeActivityResult::Unavailable)
            }
        }
    }
}

// The file closes when the read ends, however it ends.
async fn read_jsonl_activity(
    path: &str,
    max_tail_bytes: u64,
    activity_timestamp: &ActivityTimestampReader,
    signal: &CancellationToken,
) -> ExecutorResult<AgentNativeActivityResult> {
    use AgentNativeActivityResult::{Ready, Unavailable};

    let mut file = tokio::fs::File::open(path).await?;
    let size = file.metadata().await?.len();
    let length = size.min(max_tail_bytes);
    let start = size - length;
    let capacity =
        usize::try_from(length).map_err(|_| io::Error::other("the file is too large to read"))?;
    let mut buffer = vec![0u8; capacity];
    if length > 0 {
        file.seek(SeekFrom::Start(start)).await?;
        // An intervening truncation leaves unread bytes as zeroes, as in Bun.
        let _bytes_read = file.read(&mut buffer).await?;
    }
    check_signal(Some(signal))?;
    let decoded = String::from_utf8_lossy(&buffer);
    let text = if start > 0 {
        // The tail begins inside the first entry it holds, which is cut off.
        let Some(first_newline) = decoded.find('\n') else {
            return Ok(Unavailable);
        };
        &decoded[first_newline + 1..]
    } else {
        &decoded[..]
    };
    for line in text.rsplit('\n') {
        check_signal(Some(signal))?;
        let line = trim(line);
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = garcon_js::json::from_str::<Opaque>(line) else {
            continue;
        };
        let timestamp = activity_timestamp(&entry)?;
        if timestamp.is_absent() {
            continue;
        }
        // A relevant entry whose timestamp is `null` says nothing about activity.
        let Some(timestamp) = timestamp.as_option() else {
            return Ok(Unavailable);
        };
        let Some(epoch_ms) = date_parse(timestamp) else {
            return Ok(Unavailable);
        };
        return Ok(Ready {
            value: AgentNativeActivity {
                last_entry_at: Some(to_iso_string(epoch_ms)?),
            },
        });
    }
    Ok(if start == 0 {
        Ready {
            value: AgentNativeActivity {
                last_entry_at: None,
            },
        }
    } else {
        Unavailable
    })
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::native_session::path_native_session::PathNativeSessionValue;

    const OWNER: &str = "test";
    const HOUSEKEEPING: &str = r#"{"type":"housekeeping","padding":""#;

    fn probe(max_tail_bytes: Option<u64>) -> JsonlNativeActivityProbe {
        create_jsonl_native_activity_probe(JsonlNativeActivityProbeOptions {
            native_sessions: Rc::new(PathNativeSessionCodec::new(OWNER)),
            activity_timestamp: Rc::new(|entry: &Opaque| {
                if entry.get("type").and_then(Value::as_str) != Some("message") {
                    return Ok(OptionalNullable::ABSENT);
                }
                Ok(match entry.get("timestamp") {
                    Some(Value::String(timestamp)) => OptionalNullable::some(timestamp.clone()),
                    _ => OptionalNullable::NULL,
                })
            }),
            max_tail_bytes,
        })
        .unwrap()
    }

    fn reference(native_path: &str) -> AgentNativeSessionRef {
        PathNativeSessionCodec::new(OWNER)
            .encode(PathNativeSessionValue {
                path: Some(native_path.to_owned()),
                agent_session_id: Some("session-1".to_owned()),
                model_endpoint_id: None,
            })
            .unwrap()
    }

    // Writes the entries as a session file, one JSON line each.
    async fn fixture(entries: &[String]) -> (tempfile::TempDir, String) {
        let directory = tempfile::tempdir().unwrap();
        let native_path = directory.path().join("session.jsonl");
        let mut text = entries.join("\n");
        text.push('\n');
        tokio::fs::write(&native_path, text).await.unwrap();
        (directory, native_path.to_string_lossy().into_owned())
    }

    fn ready(last_entry_at: Option<&str>) -> AgentNativeActivityResult {
        AgentNativeActivityResult::Ready {
            value: AgentNativeActivity {
                last_entry_at: last_entry_at.map(str::to_owned),
            },
        }
    }

    async fn last_activity(
        probe: &JsonlNativeActivityProbe,
        native_path: &str,
    ) -> AgentNativeActivityResult {
        probe
            .last_activity(reference(native_path), CancellationToken::new())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn reads_the_newest_relevant_timestamp_from_a_bounded_tail() {
        let (_directory, native_path) = fixture(&[
            r#"{"type":"message","timestamp":"2026-08-12T00:00:01.000Z"}"#.to_owned(),
            r#"{"type":"housekeeping","timestamp":"2026-08-12T00:00:02.000Z"}"#.to_owned(),
            r#"{"type":"message","timestamp":"2026-08-12T00:00:03.000Z"}"#.to_owned(),
        ])
        .await;

        let result = last_activity(&probe(None), &native_path).await;

        assert_eq!(result, ready(Some("2026-08-12T00:00:03.000Z")));
    }

    #[tokio::test]
    async fn returns_unavailable_when_the_bounded_slice_cannot_prove_the_tail() {
        let (_directory, native_path) = fixture(&[
            r#"{"type":"message","timestamp":"2026-08-12T00:00:01.000Z"}"#.to_owned(),
            format!(r#"{HOUSEKEEPING}{}"}}"#, "x".repeat(512)),
        ])
        .await;

        let result = last_activity(&probe(Some(64)), &native_path).await;

        assert_eq!(result, AgentNativeActivityResult::Unavailable);
    }

    #[tokio::test]
    async fn drops_the_entry_the_tail_cuts_off() {
        let entries = [
            r#"{"type":"message","timestamp":"2026-08-12T00:00:00.000Z"}"#.to_owned(),
            format!(r#"{HOUSEKEEPING}{}"}}"#, "x".repeat(512)),
            r#"{"type":"housekeeping"}"#.to_owned(),
            String::new(),
            r#"{"type":"message","timestamp":"2026-08-12T00:00:05.000Z"}"#.to_owned(),
        ];
        let (_directory, native_path) = fixture(&entries).await;
        let tail = (entries[4].len() + 1 + 10) as u64;

        let result = last_activity(&probe(Some(tail)), &native_path).await;

        assert_eq!(result, ready(Some("2026-08-12T00:00:05.000Z")));
        // With only the cut-off entry, nothing proves where the file ends.
        let cut = 10;
        assert_eq!(
            last_activity(&probe(Some(cut)), &native_path).await,
            AgentNativeActivityResult::Unavailable
        );
    }

    #[tokio::test]
    async fn returns_unavailable_for_a_relevant_entry_without_a_valid_creation_timestamp() {
        let (_directory, native_path) =
            fixture(&[r#"{"type":"message","timestamp":"not-a-date"}"#.to_owned()]).await;

        let result = last_activity(&probe(None), &native_path).await;

        assert_eq!(result, AgentNativeActivityResult::Unavailable);
    }

    #[tokio::test]
    async fn returns_unavailable_for_a_relevant_entry_whose_timestamp_is_null() {
        let (_directory, native_path) = fixture(&[
            r#"{"type":"message","timestamp":"2026-08-12T00:00:01.000Z"}"#.to_owned(),
            r#"{"type":"message","timestamp":null}"#.to_owned(),
        ])
        .await;

        let result = last_activity(&probe(None), &native_path).await;

        assert_eq!(result, AgentNativeActivityResult::Unavailable);
    }

    #[tokio::test]
    async fn a_whole_file_without_a_relevant_entry_has_no_activity() {
        let (directory, native_path) = fixture(&[
            r#"{"type":"housekeeping"}"#.to_owned(),
            "not json".to_owned(),
            String::new(),
        ])
        .await;

        assert_eq!(last_activity(&probe(None), &native_path).await, ready(None));

        let empty = directory.path().join("empty.jsonl");
        tokio::fs::write(&empty, "").await.unwrap();
        let empty = empty.to_string_lossy().into_owned();
        assert_eq!(last_activity(&probe(None), &empty).await, ready(None));
    }

    #[tokio::test]
    async fn matches_bun_on_the_same_file_with_whole_and_partial_tails() {
        let (_directory, native_path) = fixture(&[
            r#"{"type":"message","timestamp":"2026-08-12T01:00:01+01:00"}"#.to_owned(),
            "not json".to_owned(),
            r#"{"type":"housekeeping"}"#.to_owned(),
        ])
        .await;
        let output = tokio::process::Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/jsonl-activity.ts"
            ))
            .arg(&native_path)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut outcomes = Vec::new();
        for tail in [None, Some(50), Some(8)] {
            outcomes.push(last_activity(&probe(tail), &native_path).await);
        }
        assert_eq!(serde_json::to_vec(&outcomes).unwrap(), output.stdout);
    }

    #[tokio::test]
    async fn a_missing_file_and_foreign_session_are_unavailable_and_an_abort_survives() {
        let (_directory, native_path) =
            fixture(&[r#"{"type":"message","timestamp":"2026-08-12T00:00:01.000Z"}"#.to_owned()])
                .await;
        let probe = probe(None);

        assert_eq!(
            last_activity(&probe, &format!("{native_path}.absent")).await,
            AgentNativeActivityResult::Unavailable
        );

        let foreign = AgentNativeSessionRef {
            owner_id: "another-owner".to_owned(),
            ..reference(&native_path)
        };
        assert_eq!(
            probe
                .last_activity(foreign, CancellationToken::new())
                .await
                .unwrap(),
            AgentNativeActivityResult::Unavailable
        );

        let signal = CancellationToken::new();
        signal.cancel();
        let error = probe
            .last_activity(reference(&native_path), signal)
            .await
            .unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<NamedError>()
                .map(|error| error.name.as_str()),
            Some("AbortError")
        );
    }

    #[test]
    fn the_tail_size_must_be_positive() {
        let Err(error) = create_jsonl_native_activity_probe(JsonlNativeActivityProbeOptions {
            native_sessions: Rc::new(PathNativeSessionCodec::new(OWNER)),
            activity_timestamp: Rc::new(|_: &Opaque| Ok(OptionalNullable::ABSENT)),
            max_tail_bytes: Some(0),
        }) else {
            panic!("invalid tail size was accepted");
        };
        assert_eq!(error.name, "TypeError");
        assert_eq!(
            error.message,
            "Native activity tail size must be a positive integer"
        );
    }
}
