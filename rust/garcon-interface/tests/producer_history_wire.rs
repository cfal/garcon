use std::{collections::HashMap, process::Command, sync::OnceLock};

use garcon_contract::api_providers::ApiProviderModelDiscoveryResponse;
use garcon_interface::{
    native_fork::{AgentNativeForkOutcome, AgentNativeForkRequest},
    native_history::{
        AgentHistoryImportRequest, AgentImportedTranscriptRow, AgentNativeActivityResult,
        AgentNativeSessionReleaseRequest,
    },
    producer::{
        AgentEstablishedSession, AgentPermissionLifecycle, AgentPermissionRespondRequest,
        AgentProducerBindRequest, AgentProducerEvent, AgentProducerNotification,
    },
    resources::AgentProducerBinding,
    transcript::AgentNativeSessionRef,
};
use garcon_js::json::{from_slice, from_str};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

fn fixtures() -> &'static HashMap<String, String> {
    static FIXTURES: OnceLock<HashMap<String, String>> = OnceLock::new();
    FIXTURES.get_or_init(|| {
        let output = Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/producer-history-wire-fixtures.ts"
            ))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        from_slice(&output.stdout).unwrap()
    })
}

fn round_trip<T: DeserializeOwned + Serialize>(name: &str) {
    let wire = &fixtures()[name];
    let decoded = from_str::<T>(wire).unwrap_or_else(|err| panic!("{name}: {err}"));
    assert_eq!(&serde_json::to_string(&decoded).unwrap(), wire, "{name}");
}

#[test]
fn producer_and_permission_dtos_round_trip_bun_json() {
    round_trip::<AgentProducerBindRequest>("bind");
    round_trip::<AgentProducerBinding>("close");
    round_trip::<Vec<AgentProducerNotification>>("notifications");
    round_trip::<AgentPermissionRespondRequest>("decision");
    round_trip::<AgentPermissionLifecycle>("resolved");

    let fixtures = fixtures();
    let raw = from_str::<AgentPermissionRespondRequest>(&fixtures["rawDecision"]).unwrap();
    assert_eq!(serde_json::to_string(&raw).unwrap(), fixtures["decision"]);
}

#[derive(Serialize, Deserialize)]
struct HistoryPage {
    done: bool,
    rows: Vec<AgentImportedTranscriptRow>,
}

#[test]
fn history_fork_and_discovery_dtos_round_trip_bun_json() {
    round_trip::<AgentHistoryImportRequest>("historyRequest");
    round_trip::<HistoryPage>("historyPage");
    round_trip::<AgentNativeSessionReleaseRequest>("release");
    round_trip::<Vec<AgentNativeActivityResult>>("activity");
    round_trip::<AgentNativeSessionRef>("nativeSession");
    round_trip::<AgentNativeForkRequest>("fork");
    round_trip::<AgentNativeForkRequest>("wholeFork");
    round_trip::<Vec<AgentNativeForkOutcome>>("forkResults");
    round_trip::<AgentEstablishedSession>("discard");
    round_trip::<Vec<ApiProviderModelDiscoveryResponse>>("discovery");
}

#[test]
fn rejects_unreadable_messages_and_invalid_completion_paths() {
    let row = r#"{"message":{"type":"not-a-chat-message"}}"#;
    assert!(from_str::<AgentImportedTranscriptRow>(row).is_err());
    assert!(
        from_str::<AgentProducerEvent>(&format!(r#"{{"type":"rows","rows":[{row}]}}"#)).is_err()
    );
    assert!(
        from_str::<AgentProducerEvent>(
            r#"{"type":"run-ended","runId":"run","outcome":"finished","workingDirectory":{"kind":"reported","path":""}}"#
        )
        .is_err()
    );
}

#[test]
fn permission_requests_need_a_tool_and_a_response_reference() {
    let no_response = r#"{"type":"permission","runId":"run","lifecycle":{"kind":"requested","permissionOccurrenceId":"occurrence","requestedTool":{"type":"read-tool-use","timestamp":"2026-11-28T00:00:00Z","toolId":"tool","filePath":"/work/example"},"options":[]}}"#;
    assert!(from_str::<AgentProducerEvent>(no_response).is_err());
    let with_response = format!(
        r#"{},"decision":{{"permissionOccurrenceId":"occurrence","response":{{"executorId":"local","instanceId":"instance","integrationId":"codex","kind":"permission-response","id":"response"}}}}}}"#,
        no_response.strip_suffix('}').unwrap()
    );
    assert!(from_str::<AgentProducerEvent>(&with_response).is_ok());
    assert!(
        from_str::<AgentProducerEvent>(
            &with_response.replace("read-tool-use", "assistant-message")
        )
        .is_err()
    );
}
