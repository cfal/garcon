use std::{process::Command, sync::OnceLock};

use garcon_contract::{
    agent_auth::{AgentAuthLoginCompleteResult, AgentAuthLoginLaunchResult, AgentAuthLoginStatus},
    agent_execution::{AgentAuthStatus, AgentEndpointSelection},
    slash_commands::SlashCommand,
};
use garcon_interface::{
    execution::*,
    execution_v5::*,
    services::*,
    transcript::{AgentNativeSessionRef, AgentTranscriptSourceLocation},
};
use garcon_js::json::from_str;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio_util::sync::CancellationToken;

fn fixtures() -> &'static [String] {
    static FIXTURES: OnceLock<Vec<String>> = OnceLock::new();
    FIXTURES.get_or_init(|| {
        let output = Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/execution-wire-fixtures.ts"
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
        assert_eq!(lines.len(), 35);
        lines
    })
}

fn round_trip<T: DeserializeOwned + Serialize>(wire: &str) {
    let decoded = from_str::<T>(wire).unwrap();
    assert_eq!(serde_json::to_string(&decoded).unwrap(), wire);
}

#[derive(Serialize, Deserialize)]
struct ConfigureSession {
    args: (
        String,
        AgentSessionConfigurationUpdate,
        AgentSessionConfiguration,
    ),
}

#[test]
fn execution_dtos_round_trip_bun_json() {
    let lines = fixtures();
    round_trip::<AgentStartRequestV5>(&lines[0]);
    round_trip::<AgentResumeRequestV5>(&lines[1]);
    round_trip::<AgentExecutionHandle>(&lines[2]);
    round_trip::<Vec<AgentRunningSession>>(&lines[3]);
}

#[test]
fn configuration_dtos_round_trip_bun_json() {
    let lines = fixtures();
    round_trip::<AgentSessionConfiguration>(&lines[4]);
    round_trip::<ConfigureSession>(&lines[5]);
    round_trip::<AgentPrepareProjectPathUpdateRequest>(&lines[6]);
    for reply in &lines[7..11] {
        round_trip::<Option<AgentPreparedProjectPathUpdate>>(reply);
    }
}

#[test]
fn transcript_dtos_round_trip_bun_json() {
    let lines = fixtures();
    let raw = r#"{"ownerId":"codex","schemaVersion":1,"value":{"10":10,"2":2,"n":1.0,"big":9007199254740993,"exp21":1e21,"zero":-0}}"#;
    let native_session = from_str::<AgentNativeSessionRef>(raw).unwrap();
    assert_eq!(serde_json::to_string(&native_session).unwrap(), lines[34]);
    round_trip::<AgentTranscriptSourceLocation>(&lines[11]);
}

#[test]
fn service_dtos_round_trip_bun_json() {
    let lines = fixtures();
    round_trip::<AgentLiteralExecution>(&lines[12]);
    round_trip::<AgentAttachments>(&lines[13]);
    round_trip::<AgentReadinessStatus>(&lines[14]);
    let mut catalog: AgentCatalogRequest = from_str(&lines[15]).unwrap();
    catalog.signal = CancellationToken::new();
    catalog.timeout_ms = Some(123.0);
    catalog.dispatch_deadline = Some(456.0);
    assert_eq!(serde_json::to_string(&catalog).unwrap(), lines[15]);
    round_trip::<AgentCatalogSnapshot>(&lines[16]);
    round_trip::<AgentTranslateLegacyModelRequest>(&lines[17]);
    round_trip::<AgentTranslateLegacyNativeSessionRequest>(&lines[18]);
    for request in &lines[19..21] {
        round_trip::<AgentTranslateLegacySettingsRequest>(request);
    }
    round_trip::<AgentAuthStatus>(&lines[21]);
    round_trip::<AgentAuthLoginLaunchResult>(&lines[22]);
    round_trip::<AgentAuthLoginCompleteResult>(&lines[23]);
    round_trip::<AgentAuthLoginStatus>(&lines[24]);
    round_trip::<Vec<SlashCommand>>(&lines[25]);
    round_trip::<AgentSteerTargetRequest>(&lines[26]);
    round_trip::<Option<AgentSteerTarget>>(&lines[27]);
    round_trip::<AgentSteerRequest>(&lines[28]);
    for reply in &lines[29..32] {
        round_trip::<AgentSteerResult>(reply);
    }
    round_trip::<AgentEndpointSelection>(&lines[32]);
    round_trip::<AgentSingleQueryRequest>(&lines[33]);
}
