use std::process::Command;

use garcon_contract::file_contracts::{
    CanonicalFileIdentity, DirectoryEntry, FileRevisionResponse, FileTreeResponse, SaveTextResponse,
};
use garcon_contract::terminal::{
    parse_terminal_create_response, parse_terminal_list_response, parse_terminal_rename_response,
    parse_terminal_terminate_response,
};
use garcon_interface::{files::*, resources::*, terminals::*};
use garcon_js::json::from_str;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

fn round_trip<T: DeserializeOwned + Serialize>(wire: &str) -> T {
    let decoded: T = from_str(wire).unwrap();
    assert_eq!(serde_json::to_string(&decoded).unwrap(), wire);
    decoded
}

fn round_trip_parsed<T: Serialize>(wire: &str, parse: impl FnOnce(&Value) -> Option<T>) {
    let value = from_str(wire).unwrap();
    let decoded = parse(&value).unwrap_or_else(|| panic!("Rust rejected {wire}"));
    assert_eq!(serde_json::to_string(&decoded).unwrap(), wire);
}

#[test]
fn resource_and_service_dtos_round_trip_bun_json() {
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/service-wire-fixtures.ts"
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
    assert_eq!(lines.len(), 24);
    let scope = round_trip::<AgentResourceScope>(lines[0]);
    round_trip::<AgentInstanceCallOptions>(lines[1]);
    let binding = round_trip::<AgentProducerBinding>(lines[2]);
    assert_eq!(
        create_agent_resource_ref(scope, AgentProducerBindingKind::Producer, || binding
            .id
            .clone()),
        binding
    );
    round_trip::<AgentPermissionResponseRef>(lines[3]);
    round_trip::<AgentProjectPathPreparation>(lines[4]);
    round_trip::<ExecutionFileTarget>(lines[5]);
    round_trip::<ExecutionDirectoryRequest>(lines[6]);
    round_trip::<ExecutionDirectoryRequest>(lines[7]);
    round_trip::<ExecutionFileListRequest>(lines[8]);
    round_trip::<ExecutionFileList>(lines[9]);
    round_trip::<ExecutionDirectoryCreation>(lines[10]);
    round_trip::<TerminalAuthority>(lines[11]);
    round_trip::<TerminalAuthority>(lines[12]);
    round_trip::<TerminalAttachRequest>(lines[13]);
    round_trip::<CanonicalFileIdentity>(lines[14]);
    round_trip::<FileTreeResponse>(lines[15]);
    round_trip::<FileRevisionResponse>(lines[16]);
    round_trip::<FileRevisionResponse>(lines[17]);
    round_trip::<SaveTextResponse>(lines[18]);
    round_trip::<DirectoryEntry>(lines[19]);
    round_trip_parsed(lines[20], parse_terminal_create_response);
    round_trip_parsed(lines[21], parse_terminal_list_response);
    round_trip_parsed(lines[22], parse_terminal_rename_response);
    round_trip_parsed(lines[23], parse_terminal_terminate_response);
}
