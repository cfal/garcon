use std::{path::Path, process::Command};

use garcon_contract::ws_events::{
    ChatProcessingSnapshotResult, ReconnectControlResult, ReconnectStateMessage,
    parse_session_ws_message,
};
use garcon_js::json::{Opaque, from_str};

#[test]
fn reconnect_producer_preserves_the_existing_queue_entry_wire_order() {
    let output = Command::new("bun")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/oracles/reconnect-state-producer.ts"),
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    // The parser's queue-entry DTO has a different key order from the
    // controller's already-serialized projection.
    let control = Opaque::parse(
        r#"{
        "serverInstanceId":"fixture-instance",
        "queue":{"entries":[{"id":"entry","content":"Synthetic queued input",
            "kind":"turn","revision":2,"createdAt":"2001-09-09T01:46:40.000Z",
            "updatedAt":"2001-09-09T01:46:40.000Z","attachments":[]}],
            "steeringEntryId":null,"recentlyDispatched":[],"pause":null,"reorderRevision":0},
        "version":0,"updatedAt":null
    }"#,
    )
    .unwrap();
    let message = ReconnectStateMessage::with_control_results(
        ChatProcessingSnapshotResult::Snapshot { chats: vec![] },
        vec![
            ReconnectControlResult::Snapshot {
                chat_id: "1000000000000001".into(),
                control: Box::new(control),
            },
            ReconnectControlResult::NotFound {
                chat_id: "1000000000000002".into(),
            },
            ReconnectControlResult::Unavailable {
                chat_id: "1000000000000003".into(),
            },
        ],
        "fixture-instance".into(),
        Some("request".into()),
    );
    let original = String::from_utf8(output.stdout).unwrap();
    let serialized = serde_json::to_string(&message).unwrap();
    assert_eq!(serialized, original.trim_end());
    assert!(parse_session_ws_message(&from_str(&serialized).unwrap()).is_some());
}
