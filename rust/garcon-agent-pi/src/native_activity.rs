//! Ports `server-agents/pi/src/agents/pi/native-activity.ts`.

use std::rc::Rc;

use garcon_agents_common::native_session::{
    jsonl_activity::{
        JsonlNativeActivityProbe, JsonlNativeActivityProbeOptions,
        create_jsonl_native_activity_probe,
    },
    path_native_session::PathNativeSessionCodec,
};
use garcon_base::errors::NamedError;
use garcon_js::{OptionalNullable, SystemClock};
use serde_json::Value;

use crate::message_converter::{ConvertPiMessageOptions, convert_pi_message};

pub fn create_pi_native_activity_probe(
    native_sessions: Rc<PathNativeSessionCodec>,
) -> Result<JsonlNativeActivityProbe, NamedError> {
    create_jsonl_native_activity_probe(JsonlNativeActivityProbeOptions {
        native_sessions,
        activity_timestamp: Rc::new(|entry| {
            if entry["type"] != "message"
                || convert_pi_message(
                    &entry["message"],
                    ConvertPiMessageOptions::default(),
                    &SystemClock,
                )?
                .is_empty()
            {
                return Ok(OptionalNullable::ABSENT);
            }
            Ok(entry
                .get("timestamp")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .into())
        }),
        max_tail_bytes: None,
    })
}

#[cfg(test)]
mod tests {
    use garcon_agents_common::native_session::path_native_session::PathNativeSessionValue;
    use garcon_interface::native_history::{
        AgentNativeActivity, AgentNativeActivityProbe, AgentNativeActivityResult,
    };
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    use super::*;

    #[tokio::test]
    async fn preserves_native_drift_evidence_for_rendered_aborted_output_only() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("session.jsonl");
        let sessions = Rc::new(PathNativeSessionCodec::new("pi"));
        let reference = sessions
            .encode(PathNativeSessionValue {
                path: Some(path.to_str().unwrap().to_owned()),
                agent_session_id: Some("synthetic".to_owned()),
                model_endpoint_id: None,
            })
            .unwrap();
        let probe = create_pi_native_activity_probe(sessions).unwrap();
        let baseline_at = "2026-08-12T00:00:01.000Z";
        let aborted_at = "2026-08-12T00:00:02.000Z";
        for (message, expected) in [
            (
                json!({
                    "role": "toolResult", "toolCallId": "tool", "isError": true,
                    "content": [{"type": "text", "text": "Aborted"}],
                }),
                aborted_at,
            ),
            (
                json!({"role":"assistant", "stopReason":"aborted", "content":"partial"}),
                aborted_at,
            ),
            (
                json!({"role":"assistant", "stopReason":"aborted", "content":""}),
                baseline_at,
            ),
        ] {
            let first = json!({
                "type": "message", "timestamp": baseline_at,
                "message": {"role": "assistant", "content": "baseline"},
            });
            let last = json!({"type": "message", "timestamp": aborted_at, "message": message});
            tokio::fs::write(&path, format!("{first}\n{last}"))
                .await
                .unwrap();
            let activity = probe
                .last_activity(reference.clone(), CancellationToken::new())
                .await
                .unwrap();
            assert_eq!(
                activity,
                AgentNativeActivityResult::Ready {
                    value: AgentNativeActivity {
                        last_entry_at: Some(expected.to_owned())
                    },
                }
            );
        }
    }
}
