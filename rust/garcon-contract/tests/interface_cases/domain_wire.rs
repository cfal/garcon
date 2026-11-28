use garcon_contract::{
    git_diagnostics::GitOperationDiagnostics, git_refs::GitRefsResponse,
    slash_commands::SlashCommandsResponse,
};
use garcon_js::json::from_str;
use serde::{Serialize, de::DeserializeOwned};

use crate::bun::bun_fixtures;

fn assert_round_trip<T: DeserializeOwned + Serialize>(original: &str) {
    let decoded = from_str::<T>(original).unwrap();
    assert_eq!(serde_json::to_string(&decoded).unwrap(), original);
}

#[test]
fn domain_dtos_round_trip_bun_json() {
    let fixtures = bun_fixtures("domain-wire-fixtures.ts");
    let lines: Vec<_> = fixtures.lines().collect();
    assert_eq!(lines.len(), 3);
    assert_round_trip::<GitOperationDiagnostics>(lines[0]);
    assert_round_trip::<GitRefsResponse>(lines[1]);
    assert_round_trip::<SlashCommandsResponse>(lines[2]);
}
