//! Replays cases from `server-agents/common/src/environment/read-environment.ts`.

use garcon_agents_common::environment::read_environment::read_environment;
use garcon_cases::{CaseError, replay, round_tripped, text};
use garcon_interface::host::AgentEnvironmentReader;
use garcon_interface::resources::ExecutorResult;
use serde_json::{Map, Value, json};

// A reader over a record, as an injected environment reader is.
struct RecordReader<'a>(&'a Map<String, Value>);

impl AgentEnvironmentReader for RecordReader<'_> {
    fn get(&self, name: &str) -> ExecutorResult<Option<String>> {
        Ok(self.0.get(name).and_then(Value::as_str).map(str::to_owned))
    }
}

#[test]
fn recorded_read_environment_matches() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/read-environment"),
        |function, args| {
            if function != "readEnvironment" {
                return Err(CaseError::unhandled(function));
            }
            let name = text(function, args.get(1))?
                .ok_or_else(|| CaseError::undeliverable("expected a variable name"))?;
            let value = round_tripped(function, args.first())?;
            let empty = Map::new();
            let record = value
                .as_deref()
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            read_environment(&RecordReader(record), name)
                .map(|value| json!(value))
                .map_err(|error| CaseError::undeliverable(error.to_string()))
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
