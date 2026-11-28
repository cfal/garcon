use std::rc::Rc;

use garcon_agents_common::native_session::{
    jsonl_activity::{
        JsonlActivityTimestamp, JsonlNativeActivityProbe, JsonlNativeActivityProbeOptions,
        create_jsonl_native_activity_probe,
    },
    path_native_session::PathNativeSessionCodec,
};
use garcon_base::errors::NamedError;
use garcon_interface::{native_message_source::NativeSourced, resources::ExecutorResult};
use garcon_js::json::Opaque;

use crate::history_loader::convert_claude_entries;

pub fn create_claude_native_activity_probe(
    native_sessions: Rc<PathNativeSessionCodec>,
) -> Result<JsonlNativeActivityProbe, NamedError> {
    create_jsonl_native_activity_probe(JsonlNativeActivityProbeOptions {
        native_sessions,
        activity_timestamp: Rc::new(activity_timestamp),
        max_tail_bytes: None,
    })
}

fn activity_timestamp(entry: &Opaque) -> ExecutorResult<JsonlActivityTimestamp> {
    if matches!(
        entry["type"].as_str(),
        Some("progress" | "queue-operation" | "file-history-snapshot" | "summary" | "attachment")
    ) || convert_claude_entries(&[NativeSourced::new(entry.clone())])?.is_empty()
    {
        return Ok(JsonlActivityTimestamp::ABSENT);
    }
    Ok(JsonlActivityTimestamp::from(
        entry["timestamp"].as_str().map(str::to_owned),
    ))
}

#[cfg(test)]
mod tests {
    use garcon_agents_common::native_session::path_native_session::PathNativeSessionValue;
    use garcon_interface::native_history::{AgentNativeActivityProbe, AgentNativeActivityResult};
    use serde_json::json;
    use tokio::fs;
    use tokio_util::sync::CancellationToken;

    use super::*;

    #[tokio::test]
    async fn reports_recent_conversation_entries_not_claude_housekeeping() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let codec = Rc::new(PathNativeSessionCodec::new("claude"));
        let probe = create_claude_native_activity_probe(codec.clone()).unwrap();
        let session = codec
            .encode(PathNativeSessionValue {
                path: Some(path.to_string_lossy().into_owned()),
                agent_session_id: Some("synthetic-session".into()),
                model_endpoint_id: None,
            })
            .unwrap();
        let headers = concat!(
            "{\"type\":\"assistant\",\"timestamp\":\"2026-08-12T00:00:01.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"synthetic answer\"}]}}\n",
            "{\"type\":\"queue-operation\",\"timestamp\":\"2026-08-12T00:00:02.000Z\"}\n",
            "{\"type\":\"attachment\",\"timestamp\":\"2026-08-12T00:00:03.000Z\",\"attachment\":{\"type\":\"queued_command\",\"commandMode\":\"prompt\",\"prompt\":\"synthetic queued prompt\"}}\n",
            "{\"type\":\"assistant\",\"timestamp\":\"2026-08-12T00:00:04.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"  \"}]}}\n",
        );
        let original = || async {
            let output = tokio::process::Command::new("bun")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/oracles/native-activity.ts"
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
            String::from_utf8(output.stdout).unwrap()
        };
        fs::write(&path, headers).await.unwrap();
        let ready = probe
            .last_activity(session.clone(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&ready).unwrap(),
            json!({
                "kind":"ready", "value":{"lastEntryAt":"2026-08-12T00:00:01.000Z"},
            })
        );
        assert_eq!(serde_json::to_string(&ready).unwrap(), original().await);

        fs::write(&path, format!("{headers}{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"synthetic missing timestamp\"}}}}\n"))
            .await.unwrap();
        let unavailable = probe
            .last_activity(session, CancellationToken::new())
            .await
            .unwrap();
        assert!(matches!(
            unavailable,
            AgentNativeActivityResult::Unavailable
        ));
        assert_eq!(
            serde_json::to_string(&unavailable).unwrap(),
            original().await
        );
    }
}
