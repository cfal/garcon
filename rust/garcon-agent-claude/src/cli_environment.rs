use std::ffi::OsString;

use garcon_interface::errors::AgentIntegrationError;
use indexmap::IndexMap;

use crate::model_context::resolve_claude_model;

pub fn build_claude_cli_environment(
    model: &str,
    inherited: impl IntoIterator<Item = (OsString, OsString)>,
    overrides: impl IntoIterator<Item = (OsString, OsString)>,
) -> Result<IndexMap<OsString, OsString>, AgentIntegrationError> {
    let mut environment: IndexMap<_, _> = inherited
        .into_iter()
        .filter(|(key, _)| key != "CLAUDECODE")
        .collect();
    environment.extend(overrides);
    if resolve_claude_model(model)?.auto_compact_window.is_some() {
        environment.shift_remove(std::ffi::OsStr::new("CLAUDE_CODE_AUTO_COMPACT_WINDOW"));
    }
    Ok(environment)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

    use garcon_cases::{CaseError, replay, text, unknown};
    use serde_json::{Map, Value, json};

    use super::*;

    fn pairs(values: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        values
            .iter()
            .map(|(key, value)| ((*key).into(), (*value).into()))
            .collect()
    }

    #[test]
    fn strips_only_the_inherited_nested_marker_and_a_conflicting_window() {
        let parent = pairs(&[
            ("CLAUDECODE", "nested"),
            ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "240000"),
            ("KEEP", "keep"),
        ]);
        let overrides = pairs(&[
            ("TOKEN", "synthetic"),
            ("CLAUDE_CODE_AUTO_COMPACT_WINDOW", "250000"),
        ]);
        let native =
            build_claude_cli_environment("sonnet[1m]", parent.clone(), overrides.clone()).unwrap();
        assert_eq!(
            native[OsStr::new("CLAUDE_CODE_AUTO_COMPACT_WINDOW")],
            "250000"
        );
        let capped =
            build_claude_cli_environment("sonnet[300k]", parent.clone(), overrides).unwrap();
        assert!(!capped.contains_key(OsStr::new("CLAUDECODE")));
        assert!(!capped.contains_key(OsStr::new("CLAUDE_CODE_AUTO_COMPACT_WINDOW")));
        assert_eq!(capped[OsStr::new("TOKEN")], "synthetic");
        assert_eq!(capped[OsStr::new("KEEP")], "keep");
        let explicit =
            build_claude_cli_environment("", parent, pairs(&[("CLAUDECODE", "override")])).unwrap();
        assert_eq!(explicit[OsStr::new("CLAUDECODE")], "override");
    }

    #[test]
    fn recorded_cli_environments_match() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/cli-environment"),
            |function, args| {
                if function != "buildWithEnvironment" {
                    return Err(CaseError::unhandled(function));
                }
                let model = text(function, args.first())?.expect("recorded model");
                let parent = unknown(function, args.get(1))?;
                let overrides = unknown(function, args.get(2))?;
                fn pairs(record: &Value) -> impl Iterator<Item = (OsString, OsString)> + '_ {
                    record
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(|(key, value)| (key.as_str().into(), value.as_str().unwrap().into()))
                }
                match build_claude_cli_environment(model, pairs(&parent), pairs(&overrides)) {
                    Ok(env) => Ok(Value::Object(
                        env.into_iter()
                            .map(|(key, value)| {
                                (
                                    key.into_string().unwrap(),
                                    Value::String(value.into_string().unwrap()),
                                )
                            })
                            .collect::<Map<_, _>>(),
                    )),
                    Err(error) => Ok(json!({
                        "$": "error", "name": "AgentIntegrationError", "message": error.message,
                        "properties": { "code": error.code.as_str(), "retryable": error.retryable },
                    })),
                }
            },
        );
    }
}
