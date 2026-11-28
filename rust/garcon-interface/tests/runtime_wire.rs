use std::{process::Command, sync::OnceLock};

use garcon_contract::agent_cli_update::AgentCliUpdateStatus;
use garcon_contract::api_providers::ApiProviderModelDiscoveryResponse;
use garcon_contract::usage::AgentUsageReport;
use garcon_interface::{
    cli_updates::AgentCliUpdateStatusRequest, host::*, usage_history::AgentUsageReadRequest,
};
use garcon_js::json::from_str;
use serde::{Serialize, de::DeserializeOwned};

fn round_trip<T: DeserializeOwned + Serialize>(wire: &str) {
    let decoded = from_str::<T>(wire).unwrap();
    assert_eq!(serde_json::to_string(&decoded).unwrap(), wire);
}

fn fixtures() -> &'static [String] {
    static FIXTURES: OnceLock<Vec<String>> = OnceLock::new();
    FIXTURES.get_or_init(|| {
        let output = Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/runtime-wire-fixtures.ts"
            ))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let fixtures = String::from_utf8(output.stdout).unwrap();
        let lines: Vec<_> = fixtures.lines().map(str::to_owned).collect();
        assert_eq!(lines.len(), 9);
        lines
    })
}

#[test]
fn host_dtos_round_trip_bun_json() {
    let lines = fixtures();
    round_trip::<Option<AgentResolvedCredential>>(&lines[1]);
    let raw = r#"{"expectedVersion":0,"nextVersion":1,"set":{"fixture":{"n":1.0,"big":9007199254740993,"exp21":1e21,"negativeZero":-0}},"delete":["obsolete"]}"#;
    let commit = from_str::<AgentMigrationCommit>(raw).unwrap();
    assert_eq!(serde_json::to_string(&commit).unwrap(), lines[2]);
    round_trip::<AgentResolveCredentialRequest>(&lines[3]);
    round_trip::<Option<AgentResolvedCredential>>(&lines[8]);
}

#[test]
fn cli_update_dtos_round_trip_bun_json() {
    let lines = fixtures();
    let mut refresh: AgentCliUpdateStatusRequest = from_str(&lines[0]).unwrap();
    assert!(refresh.signal.is_none());
    refresh.signal = Some(tokio_util::sync::CancellationToken::new());
    assert_eq!(serde_json::to_string(&refresh).unwrap(), lines[0]);
    round_trip::<AgentCliUpdateStatus>(&lines[4]);
}

#[test]
fn usage_history_dtos_round_trip_bun_json() {
    let lines = fixtures();
    let mut usage: AgentUsageReadRequest = from_str(&lines[5]).unwrap();
    assert!(usage.signal.is_none());
    usage.signal = Some(tokio_util::sync::CancellationToken::new());
    assert_eq!(serde_json::to_string(&usage).unwrap(), lines[5]);
    round_trip::<AgentUsageReport>(&lines[6]);
}

#[test]
fn discovery_failure_has_no_models_key() {
    round_trip::<ApiProviderModelDiscoveryResponse>(&fixtures()[7]);
}
