//! Ports `common/template-tokens.ts`.

use std::{collections::HashSet, fmt, sync::LazyLock};

use garcon_js::{
    clock::{InvalidTimeValue, to_iso_string},
    date_parse::local_calendar_fields,
    number_to_string, utf16,
};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::chat_id::CHAT_ID_LENGTH;

static TEMPLATE_TOKEN_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: this constant is a valid regex.
    Regex::new(r"\\?\{\{([a-z_][a-z0-9_]*)\}\}").expect("template token pattern")
});

pub const CHAT_ID_TEMPLATE_VARIABLE: &str = "chat_id";
pub const CHAT_ID_TEMPLATE_TOKEN: &str = "{{chat_id}}";
pub const RUNTIME_TEMPLATE_VARIABLES: &[&str] = &[
    CHAT_ID_TEMPLATE_VARIABLE,
    "current_date",
    "current_date_local",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeTemplateValues<S = String> {
    pub chat_id: S,
    pub current_date: S,
    pub current_date_local: S,
}

impl<S: AsRef<str>> RuntimeTemplateValues<S> {
    pub fn get(&self, variable: &str) -> Option<&str> {
        Some(match variable {
            CHAT_ID_TEMPLATE_VARIABLE => self.chat_id.as_ref(),
            "current_date" => self.current_date.as_ref(),
            "current_date_local" => self.current_date_local.as_ref(),
            _ => return None,
        })
    }
}

const VALIDATION_CHAT_ID: [u8; CHAT_ID_LENGTH] = [b'1'; CHAT_ID_LENGTH];

pub const TEMPLATE_VALIDATION_VALUES: RuntimeTemplateValues<&str> = RuntimeTemplateValues {
    // INFALLIBLE: the array contains only ASCII ones.
    chat_id: match std::str::from_utf8(&VALIDATION_CHAT_ID) {
        Ok(id) => id,
        Err(_) => panic!("ASCII chat ID"),
    },
    current_date: "2000-01-02",
    current_date_local: "2000-01-01",
};

pub fn runtime_template_values(
    chat_id: &str,
    at_ms: i64,
) -> Result<RuntimeTemplateValues, InvalidTimeValue> {
    let local = local_calendar_fields(at_ms).ok_or(InvalidTimeValue)?;
    let year = local.year.to_string();
    let year_padding = "0".repeat(4_usize.saturating_sub(utf16::len(&year)));
    let iso = to_iso_string(at_ms)?;
    Ok(RuntimeTemplateValues {
        chat_id: chat_id.to_owned(),
        current_date: utf16::slice(&iso, 0, Some(10)).to_owned(),
        current_date_local: format!(
            "{year_padding}{year}-{:02}-{:02}",
            local.month + 1,
            local.day
        ),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TemplateTokenMatch<'a> {
    pub index: usize,
    pub raw: &'a str,
    pub variable: &'a str,
    pub escaped: bool,
    #[serde(skip)]
    byte_index: usize,
}

impl TemplateTokenMatch<'_> {
    pub fn byte_index(&self) -> usize {
        self.byte_index
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TemplateExpansionTooLongError {
    pub max_length: f64,
}

impl fmt::Display for TemplateExpansionTooLongError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Expanded template exceeds {} characters",
            number_to_string(self.max_length)
        )
    }
}

impl std::error::Error for TemplateExpansionTooLongError {}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TemplateExpansionError {
    TooLong(TemplateExpansionTooLongError),
    MissingValue,
}

impl fmt::Display for TemplateExpansionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLong(error) => fmt::Display::fmt(error, f),
            Self::MissingValue => {
                f.write_str("undefined is not an object (evaluating 'value.length')")
            }
        }
    }
}

impl std::error::Error for TemplateExpansionError {}

pub fn match_template_tokens<'text, 'variables>(
    template: &'text str,
    allowed_variables: &[&'variables str],
) -> impl Iterator<Item = TemplateTokenMatch<'text>> + use<'text, 'variables> {
    let allowed: HashSet<&str> = allowed_variables.iter().copied().collect();
    let mut last_byte_index = 0;
    let mut index = 0;
    TEMPLATE_TOKEN_PATTERN
        .captures_iter(template)
        .filter_map(move |captures| {
            let variable = captures.get(1)?.as_str();
            if !allowed.contains(variable) {
                return None;
            }
            let token = captures.get(0)?;
            let byte_index = token.start();
            index += utf16::len(&template[last_byte_index..byte_index]);
            last_byte_index = byte_index;
            let raw = token.as_str();
            Some(TemplateTokenMatch {
                index,
                raw,
                variable,
                escaped: raw.starts_with('\\'),
                byte_index,
            })
        })
}

pub fn expand_template<'values>(
    template: &str,
    allowed_variables: &[&str],
    values: impl Fn(&str) -> Option<&'values str>,
    max_length: f64,
) -> Result<String, TemplateExpansionError> {
    let mut chunks = Vec::new();
    let mut length = 0;
    let mut cursor = 0;
    let mut append = |value| {
        length += utf16::len(value);
        if length as f64 > max_length {
            return Err(TemplateExpansionError::TooLong(
                TemplateExpansionTooLongError { max_length },
            ));
        }
        chunks.push(value);
        Ok(())
    };

    for token in match_template_tokens(template, allowed_variables) {
        let start = token.byte_index();
        append(&template[cursor..start])?;
        let value = if token.escaped {
            utf16::slice(token.raw, 1, None)
        } else {
            values(token.variable).ok_or(TemplateExpansionError::MissingValue)?
        };
        append(value)?;
        cursor = start + token.raw.len();
    }
    append(&template[cursor..])?;
    Ok(chunks.concat())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_exact_allowed_variables_and_reports_escapes() {
        let template = "\u{1f600} {{chat_id}} \\{{project_path}} {{arguments}} {{ chat_id }}";
        let tokens =
            match_template_tokens(template, &["chat_id", "project_path"]).collect::<Vec<_>>();
        assert_eq!(tokens.len(), 2);
        assert_eq!(
            (
                tokens[0].index,
                tokens[0].raw,
                tokens[0].variable,
                tokens[0].escaped
            ),
            (3, "{{chat_id}}", "chat_id", false)
        );
        assert_eq!(
            (
                tokens[1].index,
                tokens[1].raw,
                tokens[1].variable,
                tokens[1].escaped
            ),
            (15, "\\{{project_path}}", "project_path", true)
        );
    }

    #[test]
    fn expands_in_one_pass_while_preserving_unknown_tokens() {
        let expanded = expand_template(
            "{{chat_id}} \\{{chat_id}} {{arguments}}",
            &["chat_id"],
            |_| Some("{{project_path}}"),
            100.0,
        );
        assert_eq!(
            expanded.unwrap(),
            "{{project_path}} {{chat_id}} {{arguments}}"
        );
    }

    #[test]
    fn rejects_output_beyond_the_configured_limit() {
        assert_eq!(
            expand_template(
                "{{chat_id}}",
                &["chat_id"],
                |_| Some("\u{1f600}\u{1f600}"),
                3.0
            ),
            Err(TemplateExpansionError::TooLong(
                TemplateExpansionTooLongError { max_length: 3.0 }
            ))
        );
    }
}
