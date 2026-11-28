use garcon_cases::{CaseError, markers, replay, text, unknown};
use garcon_interface::resources::{
    AgentResourceScope, assert_agent_resource_scope, is_agent_resource_ref,
};
use serde_json::{Value, json};

fn required_scope(function: &str, arg: Option<&Value>) -> Result<AgentResourceScope, CaseError> {
    serde_json::from_value(unknown(function, arg)?.into_owned())
        .map_err(|_| CaseError::unhandled(function))
}

#[test]
fn resource_cases_match() {
    let stats = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/interface/resources"
        ),
        |function, args| match function {
            "isAgentResourceRef" => {
                let argument = unknown(function, args.first())?;
                let kind =
                    text(function, args.get(1))?.ok_or_else(|| CaseError::unhandled(function))?;
                let scope = if let Some(value) = args.get(2) {
                    Some(required_scope(function, Some(value))?)
                } else {
                    None
                };
                Ok(json!(is_agent_resource_ref(
                    &argument,
                    kind,
                    scope.as_ref()
                )))
            }
            "assertAgentResourceScope" => {
                let actual = required_scope(function, args.first())?;
                let expected = required_scope(function, args.get(1))?;
                match assert_agent_resource_scope(&actual, &expected) {
                    Ok(()) => Ok(markers::undefined()),
                    Err(error) => Err(CaseError::new("AgentCallError", error.message.clone())
                        .with_property("code", error.code.as_str())
                        .with_property("outcome", error.outcome.as_str())
                        .with_property("retryable", error.retryable)
                        .with_property(
                            "details",
                            error
                                .details
                                .as_ref()
                                .map_or_else(markers::undefined, |value| json!(value)),
                        )),
                }
            }
            _ => Err(CaseError::unhandled(function)),
        },
    );
    assert_eq!(stats.total, 13);
    assert_eq!(stats.with_wildcards, 0);
}
