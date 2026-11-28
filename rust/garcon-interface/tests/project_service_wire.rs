use std::process::Command;

use garcon_contract::tickets::TicketProjectDefault;
use garcon_interface::execution_runtime::*;
use garcon_js::json::from_str;
use serde::{Serialize, de::DeserializeOwned};

fn round_trip<T: DeserializeOwned + Serialize>(wire: &str) {
    let decoded = from_str::<T>(wire).unwrap();
    assert_eq!(serde_json::to_string(&decoded).unwrap(), wire);
}

#[test]
fn project_service_dtos_round_trip_bun_json() {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/project-service-wire-fixtures.ts"
        ))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let fixtures = String::from_utf8(output.stdout).unwrap();
    let lines: Vec<_> = fixtures.lines().collect();
    assert_eq!(lines.len(), 16);
    round_trip::<ExecutorInfo>(lines[0]);
    for wire in &lines[1..5] {
        round_trip::<ExecutorAvailability>(wire);
    }
    for wire in &lines[5..7] {
        round_trip::<ApiProviderDiscoveryRequest>(wire);
    }
    for wire in &lines[7..9] {
        round_trip::<ExecutionProjectInspectRequest>(wire);
    }
    for wire in &lines[9..11] {
        round_trip::<ExecutionProjectInspectResponse>(wire);
    }
    round_trip::<TicketProjectDefaultRequest>(lines[11]);
    for wire in &lines[12..14] {
        round_trip::<TicketProjectDefault>(wire);
    }
    round_trip::<ResolveFileMentionsRequest>(lines[14]);
    round_trip::<String>(lines[15]);
}
