//! Ports `common/terminal-identity.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::executors::is_executor_id;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReference {
    pub executor_id: String,
    pub terminal_runtime_id: String,
    pub session_id: String,
}

pub fn terminal_id(reference: &TerminalReference) -> String {
    format!(
        "{}/{}/{}",
        reference.executor_id, reference.terminal_runtime_id, reference.session_id
    )
}

pub fn parse_terminal_reference(value: &Value) -> Option<TerminalReference> {
    let mut parts = value.as_str()?.split('/');
    let (executor_id, terminal_runtime_id, session_id) =
        (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some()
        || !is_executor_id(&Value::String(executor_id.to_owned()))
        || !is_uuid(terminal_runtime_id)
        || !is_uuid(session_id)
    {
        return None;
    }
    Some(TerminalReference {
        executor_id: executor_id.to_owned(),
        terminal_runtime_id: terminal_runtime_id.to_owned(),
        session_id: session_id.to_owned(),
    })
}

fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, unknown};
    use garcon_js::json::from_slice;
    use serde_json::{json, to_vec};

    use super::*;

    #[test]
    fn recorded_terminal_identity_matches() {
        let stats = replay(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/cases/common/terminal-identity"
            ),
            |function, args| {
                let input = unknown(function, args.first())?;
                match function {
                    "terminalId" => {
                        let reference: TerminalReference = from_slice(&to_vec(&*input).unwrap())
                            .map_err(|error| CaseError::undeliverable(error.to_string()))?;
                        Ok(json!(terminal_id(&reference)))
                    }
                    "parseTerminalReference" => Ok(from_slice(
                        &to_vec(&parse_terminal_reference(&input)).unwrap(),
                    )
                    .unwrap()),
                    _ => Err(CaseError::unhandled(function)),
                }
            },
        );
        assert_eq!(stats.with_wildcards, 0);
    }
}
