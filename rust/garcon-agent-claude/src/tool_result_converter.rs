use garcon_agents_common::shared::normalize_util::normalize_tool_result_content;
use garcon_js::json::Opaque;
use serde_json::Value;

pub fn claude_tool_result_content(
    content: Option<&Opaque>,
    tool_use_result: Option<&Opaque>,
) -> Opaque {
    let normalized = normalize_tool_result_content(content);
    let Some(metadata @ Value::Object(_)) = tool_use_result.map(Opaque::as_value) else {
        return normalized;
    };
    let mut normalized = normalized.into_value();
    if let Some(fields) = normalized.as_object_mut() {
        fields.insert("toolUseResult".to_owned(), metadata.clone());
    }
    normalized.into()
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, round_tripped};

    use super::*;

    #[test]
    fn recorded_tool_results_match() {
        replay(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/cases/tool-result-converter"
            ),
            |function, args| {
                if function != "claudeToolResultContent" {
                    return Err(CaseError::unhandled(function));
                }
                let content = round_tripped(function, args.first())?
                    .map(|value| Opaque::from_value(value.into_owned()));
                let metadata = round_tripped(function, args.get(1))?
                    .map(|value| Opaque::from_value(value.into_owned()));
                let converted = claude_tool_result_content(content.as_ref(), metadata.as_ref());
                Ok(garcon_js::json::from_slice(&serde_json::to_vec(&converted).unwrap()).unwrap())
            },
        );
    }

    #[test]
    fn provider_metadata_replaces_existing_metadata_without_reordering_other_keys() {
        let content = Opaque::parse(r#"{"toolUseResult":{"old":true},"raw":"body"}"#).unwrap();
        let metadata = Opaque::parse(r#"{"exitCode":0,"elapsed":1e21}"#).unwrap();
        let output = claude_tool_result_content(Some(&content), Some(&metadata));
        assert_eq!(
            serde_json::to_string(&output).unwrap(),
            r#"{"toolUseResult":{"exitCode":0,"elapsed":1e+21},"raw":"body"}"#
        );
        let array = Opaque::parse("[1,2]").unwrap();
        assert_eq!(
            claude_tool_result_content(Some(&content), Some(&array)),
            content,
        );
    }
}
