//! Ports `server-agents/common/src/logging/scoped-agent-logger.ts`.

use std::rc::Rc;

use garcon_interface::host::AgentLogger;
use garcon_js::json::Opaque;
use garcon_js::{array_index, sort_object_keys};
use indexmap::IndexMap;
use serde_json::Value;

type LoggerFields = IndexMap<String, Opaque>;

pub fn create_scoped_agent_logger(
    logger: Rc<dyn AgentLogger>,
    scope: impl Into<String>,
) -> Rc<dyn AgentLogger> {
    Rc::new(ScopedAgentLogger {
        logger,
        scope: scope.into(),
    })
}

struct ScopedAgentLogger {
    logger: Rc<dyn AgentLogger>,
    scope: String,
}

impl AgentLogger for ScopedAgentLogger {
    fn debug(&self, message: &str, fields: Option<&LoggerFields>) {
        let fields = scoped_fields(&self.scope, fields);
        self.logger.debug(message, Some(&fields));
    }

    fn info(&self, message: &str, fields: Option<&LoggerFields>) {
        let fields = scoped_fields(&self.scope, fields);
        self.logger.info(message, Some(&fields));
    }

    fn warn(&self, message: &str, fields: Option<&LoggerFields>) {
        let fields = scoped_fields(&self.scope, fields);
        self.logger.warn(message, Some(&fields));
    }

    fn error(&self, message: &str, fields: Option<&LoggerFields>) {
        let fields = scoped_fields(&self.scope, fields);
        self.logger.error(message, Some(&fields));
    }
}

// The object literal `{ scope, ...value }`: `scope` leads unless `value` holds
// an array index, which JavaScript enumerates before every other key.
fn scoped_fields(scope: &str, value: Option<&LoggerFields>) -> LoggerFields {
    let mut fields = LoggerFields::with_capacity(1 + value.map_or(0, IndexMap::len));
    fields.insert(
        "scope".to_owned(),
        Opaque::from_value(Value::String(scope.to_owned())),
    );
    if let Some(value) = value {
        for (key, item) in value {
            fields.insert(key.clone(), item.clone());
        }
    }
    if fields.keys().any(|key| array_index(key).is_some()) {
        let mut keys: Vec<String> = fields.keys().cloned().collect();
        sort_object_keys(&mut keys);
        let mut source = std::mem::take(&mut fields);
        for key in keys {
            if let Some(item) = source.shift_remove(&key) {
                fields.insert(key, item);
            }
        }
    }
    fields
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use serde_json::json;

    use super::*;

    #[derive(Default)]
    struct Captured(RefCell<Vec<(&'static str, String, Option<LoggerFields>)>>);

    impl AgentLogger for Captured {
        fn debug(&self, message: &str, fields: Option<&LoggerFields>) {
            self.0
                .borrow_mut()
                .push(("debug", message.to_owned(), fields.cloned()));
        }
        fn info(&self, message: &str, fields: Option<&LoggerFields>) {
            self.0
                .borrow_mut()
                .push(("info", message.to_owned(), fields.cloned()));
        }
        fn warn(&self, message: &str, fields: Option<&LoggerFields>) {
            self.0
                .borrow_mut()
                .push(("warn", message.to_owned(), fields.cloned()));
        }
        fn error(&self, message: &str, fields: Option<&LoggerFields>) {
            self.0
                .borrow_mut()
                .push(("error", message.to_owned(), fields.cloned()));
        }
    }

    fn written(fields: &Option<LoggerFields>) -> String {
        fields
            .as_ref()
            .map(|fields| serde_json::to_string(fields).unwrap_or_default())
            .unwrap_or_default()
    }

    #[test]
    fn every_level_carries_the_scope_before_the_caller_fields() {
        let captured = Rc::new(Captured::default());
        let logger = create_scoped_agent_logger(captured.clone(), "pi:session-1");
        let fields: LoggerFields = IndexMap::from_iter([
            ("sessionId".to_owned(), Opaque::from_value(json!("s-1"))),
            ("scope".to_owned(), Opaque::from_value(json!("inner"))),
        ]);
        logger.debug("d", Some(&fields));
        logger.info("i", None);
        logger.warn("w", Some(&fields));
        logger.error("e", None);

        let lines: Vec<String> = captured
            .0
            .borrow()
            .iter()
            .map(|(level, message, fields)| format!("{level} {message} {}", written(fields)))
            .collect();
        assert_eq!(
            lines,
            [
                r#"debug d {"scope":"inner","sessionId":"s-1"}"#,
                r#"info i {"scope":"pi:session-1"}"#,
                r#"warn w {"scope":"inner","sessionId":"s-1"}"#,
                r#"error e {"scope":"pi:session-1"}"#,
            ]
        );
    }

    #[test]
    fn an_array_index_of_the_caller_fields_is_enumerated_before_the_scope() {
        let fields: LoggerFields = IndexMap::from_iter([
            ("b".to_owned(), Opaque::from_value(json!(2))),
            ("10".to_owned(), Opaque::from_value(json!(1))),
            ("1".to_owned(), Opaque::from_value(json!(0))),
        ]);
        assert_eq!(
            written(&Some(scoped_fields("x", Some(&fields)))),
            r#"{"1":0,"10":1,"scope":"x","b":2}"#
        );
    }
}
