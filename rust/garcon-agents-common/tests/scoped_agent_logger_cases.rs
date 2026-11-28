//! Replays cases from `server-agents/common/src/logging/scoped-agent-logger.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use garcon_agents_common::logging::scoped_agent_logger::create_scoped_agent_logger;
use garcon_cases::{CaseError, replay, round_tripped, text};
use garcon_interface::host::AgentLogger;
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;

type LoggerFields = IndexMap<String, Opaque>;

// A value as it crosses the JSON boundary, where object keys follow JavaScript's order.
fn wire(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    garcon_js::json::from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn opaque_fields(value: Option<&Value>) -> LoggerFields {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(key, item)| (key.clone(), Opaque::from_value(item.clone())))
        .collect()
}

#[derive(Default)]
struct Captured(RefCell<Option<LoggerFields>>);

impl AgentLogger for Captured {
    fn debug(&self, _message: &str, _fields: Option<&LoggerFields>) {}
    fn info(&self, _message: &str, fields: Option<&LoggerFields>) {
        *self.0.borrow_mut() = fields.cloned();
    }
    fn warn(&self, _message: &str, _fields: Option<&LoggerFields>) {}
    fn error(&self, _message: &str, _fields: Option<&LoggerFields>) {}
}

#[test]
fn recorded_scoped_agent_logger_matches() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/scoped-agent-logger"
        ),
        |function, args| {
            let scope = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("expected a scope"))?;
            let captured = Rc::new(Captured::default());
            let logger = create_scoped_agent_logger(captured.clone(), scope);
            let value = match function {
                "scopedFields" => opaque_fields(round_tripped(function, args.get(1))?.as_deref()),
                "scopedFieldsWithoutValue" => LoggerFields::new(),
                _ => return Err(CaseError::unhandled(function)),
            };
            logger.info("message", Some(&value));
            let captured = captured.0.borrow();
            wire(
                captured
                    .as_ref()
                    .ok_or_else(|| CaseError::undeliverable("the logger was not called"))?,
            )
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
