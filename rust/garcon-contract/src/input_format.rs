//! Ports `common/input-format.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::json::JsonObject;

/// How an integration reads a prompt: as plain text or as Markdown.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum InputFormat {
    #[default]
    Plain,
    Markdown,
}

impl InputFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            InputFormat::Plain => "plain",
            InputFormat::Markdown => "markdown",
        }
    }
}

/// The input format of each model, by model name. `is_input_format_by_model`
/// says whether a value that came from outside is one.
pub type InputFormatByModel = JsonObject;

/// Whether `value` maps every model name to `plain` or `markdown`.
pub fn is_input_format_by_model(value: &Value) -> bool {
    let Some(formats) = value.as_object() else {
        return false;
    };
    formats
        .iter()
        .all(|(model, format)| !model.is_empty() && is_input_format(format))
}

fn is_input_format(value: &Value) -> bool {
    matches!(value.as_str(), Some("plain" | "markdown"))
}

/// The format an integration reads `model` in: the one declared for the
/// model's own name, or `plain` when the model has no declaration of its own.
/// A declaration is returned as it is stored.
pub fn literal_input_format(formats: &InputFormatByModel, model: &str) -> Value {
    formats
        .get(model)
        .cloned()
        .unwrap_or_else(|| Value::String("plain".to_owned()))
}

/// Whether a message is plain literal text: its metadata declares literal
/// content and not Markdown. `metadata` is the message's optional metadata
/// (`ChatMessageMetadata` in `common/chat-types.ts`), `None` when the message
/// has none.
pub fn is_plain_text_input(metadata: Option<&Value>) -> bool {
    let content_mode = metadata.and_then(|metadata| metadata.get("contentMode"));
    if content_mode.and_then(Value::as_str) != Some("literal") {
        return false;
    }
    let content_format = metadata.and_then(|metadata| metadata.get("contentFormat"));
    content_format.and_then(Value::as_str) != Some("markdown")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn format_declarations_are_validated() {
        assert!(is_input_format_by_model(
            &json!({ "notes": "plain", "markdown": "markdown" })
        ));
        assert!(is_input_format_by_model(&json!({})));
        for invalid in [
            Value::Null,
            json!([]),
            json!({ "notes": "html" }),
            json!({ "": "markdown" }),
            json!("markdown"),
            json!(1),
            json!({ "notes": "Plain" }),
            json!({ "notes": null }),
            json!({ "notes": true }),
        ] {
            assert!(!is_input_format_by_model(&invalid), "{invalid}");
        }
    }

    fn declared(entries: &[(&str, &str)]) -> InputFormatByModel {
        entries
            .iter()
            .map(|(model, format)| ((*model).to_owned(), json!(format)))
            .collect()
    }

    #[test]
    fn only_own_model_names_override_plain_text() {
        let declared = declared(&[("markdown", "markdown")]);
        assert_eq!(
            literal_input_format(&declared, "markdown"),
            json!("markdown")
        );
        // A name every object has is not a declaration of its own.
        for inherited in [
            "constructor",
            "toString",
            "__proto__",
            "hasOwnProperty",
            "valueOf",
            "",
        ] {
            assert_eq!(
                literal_input_format(&declared, inherited),
                json!("plain"),
                "{inherited}"
            );
        }
        assert_eq!(
            literal_input_format(&InputFormatByModel::new(), "markdown"),
            json!("plain")
        );
    }

    #[test]
    fn a_declaration_is_returned_as_it_is_stored() {
        let stored: InputFormatByModel = serde_json::from_value(json!({
            "__proto__": "markdown",
            "other": "",
            "number": 5,
            "nothing": null,
        }))
        .unwrap();
        // A key read from JSON is a declaration of its own.
        assert_eq!(
            literal_input_format(&stored, "__proto__"),
            json!("markdown")
        );
        assert_eq!(literal_input_format(&stored, "other"), json!(""));
        assert_eq!(literal_input_format(&stored, "number"), json!(5));
        assert_eq!(literal_input_format(&stored, "nothing"), json!(null));
    }

    #[test]
    fn literal_execution_and_durable_markdown_presentation_are_independent() {
        // `new UserMessage('', '**Command**', undefined, { contentMode: 'literal' })`.
        assert!(is_plain_text_input(Some(
            &json!({ "contentMode": "literal" })
        )));
        // Literal execution of Markdown is not plain text.
        assert!(!is_plain_text_input(Some(
            &json!({ "contentMode": "literal", "contentFormat": "markdown" })
        )));
        // Markdown presentation without literal execution.
        assert!(!is_plain_text_input(Some(
            &json!({ "contentFormat": "markdown" })
        )));
        // No metadata at all.
        assert!(!is_plain_text_input(None));
        assert!(!is_plain_text_input(Some(&Value::Null)));
        // Any other format is plain text, as `!== 'markdown'` reads it.
        assert!(is_plain_text_input(Some(
            &json!({ "contentMode": "literal", "contentFormat": "html" })
        )));
        assert!(is_plain_text_input(Some(
            &json!({ "contentMode": "literal", "contentFormat": null })
        )));
        // The comparison with `'literal'` is exact, and reads a string only.
        assert!(!is_plain_text_input(Some(
            &json!({ "contentMode": "Literal" })
        )));
        assert!(!is_plain_text_input(Some(
            &json!({ "contentMode": " literal " })
        )));
        assert!(!is_plain_text_input(Some(
            &json!({ "contentMode": ["literal"] })
        )));
    }

    #[test]
    fn an_input_format_reads_and_writes_its_name() {
        for (format, name) in [
            (InputFormat::Plain, "plain"),
            (InputFormat::Markdown, "markdown"),
        ] {
            assert_eq!(serde_json::to_value(format).unwrap(), json!(name));
            assert_eq!(format.as_str(), name);
        }
    }
}
