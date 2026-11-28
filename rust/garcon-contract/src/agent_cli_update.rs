//! Ports `common/agent-cli-update.ts`.

use garcon_js::{array_index, date_parse::date_parse, utf16};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

macro_rules! cli_values {
    ($name:ident, $values:ident, $parser:ident, $($variant:ident => $value:literal),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum $name { $(#[serde(rename = $value)] $variant),+ }

        pub const $values: &[$name] = &[$($name::$variant),+];

        fn $parser(value: &Value) -> Option<$name> {
            match value.as_str()? { $($value => Some($name::$variant),)+ _ => None }
        }
    };
}

cli_values! {
    AgentCliInstallMethod, AGENT_CLI_INSTALL_METHODS, install_method,
    Bundled => "bundled", Native => "native", Npm => "npm", Bun => "bun", Pnpm => "pnpm",
    Yarn => "yarn", Homebrew => "homebrew", Unmanaged => "unmanaged", Missing => "missing",
}

cli_values! {
    AgentCliVersionAdvisory, AGENT_CLI_VERSION_ADVISORIES, version_advisory,
    Unknown => "unknown", Current => "current", BehindLatest => "behind-latest",
}

cli_values! {
    AgentCliUpdateRunState, AGENT_CLI_UPDATE_RUN_STATES, run_state,
    Idle => "idle", Running => "running", Succeeded => "succeeded", Failed => "failed", Unchanged => "unchanged",
}

pub const AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS: usize = 10_000;
pub const AGENT_CLI_UPDATE_MESSAGE_MAX_CHARS: usize = 500;
const MAX_TEXT_CHARS: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliUpdateRun {
    pub state: AgentCliUpdateRunState,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub message: Option<String>,
    pub output: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliUpdateStatus {
    pub cli_label: String,
    pub install_method: AgentCliInstallMethod,
    pub install_path: Option<String>,
    pub current_version: Option<String>,
    pub latest_version: Option<String>,
    pub advisory: AgentCliVersionAdvisory,
    pub update_command: Option<String>,
    pub can_update: bool,
    pub message: Option<String>,
    pub checked_at: String,
    pub run: AgentCliUpdateRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentCliUpdatesResponse {
    pub statuses: IndexMap<String, AgentCliUpdateStatus>,
    pub failures: IndexMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliUpdateRequest {
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<String>,
}

pub const IDLE_AGENT_CLI_UPDATE_RUN: AgentCliUpdateRun = AgentCliUpdateRun {
    state: AgentCliUpdateRunState::Idle,
    started_at: None,
    finished_at: None,
    message: None,
    output: None,
};

fn nullable_text(value: &Value, max_chars: usize) -> Option<Option<String>> {
    if value.is_null() {
        return Some(None);
    }
    let value = value.as_str()?;
    (utf16::len(value) <= max_chars).then(|| Some(value.to_owned()))
}

fn nullable_timestamp(value: &Value) -> Option<Option<String>> {
    if value.is_null() {
        return Some(None);
    }
    timestamp(value).map(Some)
}

fn timestamp(value: &Value) -> Option<String> {
    let value = value.as_str()?;
    date_parse(value).map(|_| value.to_owned())
}

fn parse_agent_cli_update_run(value: &Value) -> Option<AgentCliUpdateRun> {
    let raw = value.as_object()?;
    let state = run_state(raw.get("state")?)?;
    let started_at = nullable_timestamp(raw.get("startedAt")?)?;
    let finished_at = nullable_timestamp(raw.get("finishedAt")?)?;
    let message = nullable_text(raw.get("message")?, MAX_TEXT_CHARS)?;
    let output = nullable_text(raw.get("output")?, AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS)?;
    Some(AgentCliUpdateRun {
        state,
        started_at,
        finished_at,
        message,
        output,
    })
}

pub fn parse_agent_cli_update_status(value: &Value) -> Option<AgentCliUpdateStatus> {
    let raw = value.as_object()?;
    let cli_label = raw.get("cliLabel")?.as_str()?;
    if cli_label.is_empty() || utf16::len(cli_label) > 64 {
        return None;
    }
    let install_method = install_method(raw.get("installMethod")?)?;
    let advisory = version_advisory(raw.get("advisory")?)?;
    let install_path = nullable_text(raw.get("installPath")?, MAX_TEXT_CHARS)?;
    let current_version = nullable_text(raw.get("currentVersion")?, MAX_TEXT_CHARS)?;
    let latest_version = nullable_text(raw.get("latestVersion")?, MAX_TEXT_CHARS)?;
    let update_command = nullable_text(raw.get("updateCommand")?, MAX_TEXT_CHARS)?;
    let message = nullable_text(raw.get("message")?, MAX_TEXT_CHARS)?;
    let can_update = raw.get("canUpdate")?.as_bool()?;
    let checked_at = timestamp(raw.get("checkedAt")?)?;
    let run = parse_agent_cli_update_run(raw.get("run")?)?;
    Some(AgentCliUpdateStatus {
        cli_label: cli_label.to_owned(),
        install_method,
        install_path,
        current_version,
        latest_version,
        advisory,
        update_command,
        can_update,
        message,
        checked_at,
        run,
    })
}

fn ordered_entries(raw: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut entries: Vec<_> = raw.iter().collect();
    entries.sort_by_key(|(key, _)| array_index(key).unwrap_or(u64::MAX));
    entries
}

pub fn parse_agent_cli_updates_response(value: &Value) -> Option<AgentCliUpdatesResponse> {
    let raw = value.as_object()?;
    let statuses = raw.get("statuses")?.as_object()?;
    let failures = raw.get("failures")?.as_object()?;
    let mut parsed_statuses = IndexMap::with_capacity(statuses.len());
    let mut parsed_failures = IndexMap::with_capacity(failures.len());
    for (agent_id, entry) in ordered_entries(statuses) {
        let status = parse_agent_cli_update_status(entry)?;
        parsed_statuses.insert(agent_id.to_owned(), status);
    }
    for (agent_id, message) in ordered_entries(failures) {
        let message = message.as_str()?;
        if utf16::len(message) > MAX_TEXT_CHARS {
            return None;
        }
        parsed_failures.insert(agent_id.to_owned(), message.to_owned());
    }
    Some(AgentCliUpdatesResponse {
        statuses: parsed_statuses,
        failures: parsed_failures,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn status() -> Value {
        json!({"cliLabel":"Fixture CLI","installMethod":"native","installPath":"/bin/fixture","currentVersion":"2.1.0",
            "latestVersion":"2.1.0","advisory":"current","updateCommand":"fixture update","canUpdate":true,"message":null,
            "checkedAt":"2026-11-20T00:00:00.000Z","run":{
                "state":"succeeded","startedAt":"2026-11-20T00:00:00.000Z","finishedAt":"2026-11-20T00:01:00.000Z",
                "message":"Updated","output":"OK"
            }
        })
    }

    #[test]
    fn round_trips_a_cli_update_status() {
        let raw = status();
        assert_eq!(
            serde_json::to_value(parse_agent_cli_update_status(&raw).unwrap()).unwrap(),
            raw
        );
        let all = json!({"statuses":{"claude":raw},"failures":{"codex":"Timed out"}});
        assert_eq!(
            serde_json::to_value(parse_agent_cli_updates_response(&all).unwrap()).unwrap(),
            all
        );
    }

    #[test]
    fn rejects_statuses_outside_the_contract() {
        for (key, value) in [
            ("installMethod", json!("apt")),
            ("advisory", json!("stale")),
            ("canUpdate", json!("yes")),
            ("checkedAt", json!("yesterday")),
            ("currentVersion", json!(2)),
            ("run", json!(null)),
        ] {
            let mut status = status();
            status[key] = value;
            assert!(parse_agent_cli_update_status(&status).is_none());
        }
        let mut status = status();
        status["run"]["output"] =
            json!("\u{1f600}".repeat(AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS / 2 + 1));
        assert!(parse_agent_cli_update_status(&status).is_none());
        assert!(
            parse_agent_cli_updates_response(&json!({"statuses":{},"failures":{"codex":7}}))
                .is_none()
        );
    }
}
