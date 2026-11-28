//! Ports `common/snippet-template.ts`.

use std::fmt;

use garcon_js::utf16;

use crate::snippets::{SNIPPET_EXPANDED_MAX_LENGTH, SNIPPET_TEMPLATE_VARIABLES, SnippetErrorCode};
use crate::template_tokens::{
    RUNTIME_TEMPLATE_VARIABLES, RuntimeTemplateValues, TemplateExpansionError, expand_template,
    match_template_tokens,
};

const INSERTION_VARIABLES: &[&str] = &["arguments", "project_path"];

pub struct SnippetTemplateValues<'a, S = String> {
    pub arguments: &'a str,
    pub project_path: &'a str,
    pub context: &'a RuntimeTemplateValues<S>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnippetExpansionError;

impl fmt::Display for SnippetExpansionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Expanded snippet exceeds {SNIPPET_EXPANDED_MAX_LENGTH} characters"
        )
    }
}

impl std::error::Error for SnippetExpansionError {}

impl SnippetExpansionError {
    pub fn code(self) -> SnippetErrorCode {
        SnippetErrorCode::EXPANSION_TOO_LONG
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScheduledSnippetBoundaryError;

impl fmt::Display for ScheduledSnippetBoundaryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Scheduled snippet replacements must not create or escape adjacent template variables. Add a separator.")
    }
}

impl std::error::Error for ScheduledSnippetBoundaryError {}

impl ScheduledSnippetBoundaryError {
    pub fn code(self) -> SnippetErrorCode {
        SnippetErrorCode::VALIDATION_FAILED
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SnippetTemplateError {
    ExpansionTooLong(SnippetExpansionError),
    Boundary(ScheduledSnippetBoundaryError),
    Template(TemplateExpansionError),
}

impl fmt::Display for SnippetTemplateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ExpansionTooLong(error) => fmt::Display::fmt(error, f),
            Self::Boundary(error) => fmt::Display::fmt(error, f),
            Self::Template(error) => fmt::Display::fmt(error, f),
        }
    }
}

impl std::error::Error for SnippetTemplateError {}

impl From<TemplateExpansionError> for SnippetTemplateError {
    fn from(error: TemplateExpansionError) -> Self {
        match error {
            TemplateExpansionError::TooLong(_) => Self::ExpansionTooLong(SnippetExpansionError),
            _ => Self::Template(error),
        }
    }
}

pub fn expand_scheduled_snippet_template(
    template: &str,
    arguments: &str,
    project_path: &str,
) -> Result<String, SnippetTemplateError> {
    let arguments = escape_deferred_tokens(arguments);
    let project_path = escape_deferred_tokens(project_path);
    let replacement = |name: &str| match name {
        "arguments" => Some(arguments.as_str()),
        "project_path" => Some(project_path.as_str()),
        _ => None,
    };
    let expanded = expand_template(
        template,
        INSERTION_VARIABLES,
        replacement,
        SNIPPET_EXPANDED_MAX_LENGTH as f64,
    )?;
    assert_deferred_token_boundaries(template, replacement, &expanded)?;
    Ok(expanded)
}

fn escape_deferred_tokens(value: &str) -> String {
    let mut result = String::new();
    let mut cursor = 0;
    for token in match_template_tokens(value, RUNTIME_TEMPLATE_VARIABLES) {
        let start = token.byte_index();
        result.push_str(&value[cursor..start]);
        result.push('\\');
        result.push_str(token.raw);
        cursor = start + token.raw.len();
    }
    result.push_str(&value[cursor..]);
    result
}

fn assert_deferred_token_boundaries<'a>(
    template: &'a str,
    replacement: impl Fn(&str) -> Option<&'a str>,
    expanded: &str,
) -> Result<(), SnippetTemplateError> {
    let mut expected = Vec::new();
    let mut offset = 0;
    let mut collect_fragment_tokens = |fragment: &'a str| {
        expected.extend(
            match_template_tokens(fragment, RUNTIME_TEMPLATE_VARIABLES)
                .map(|token| (offset + token.index, token.raw)),
        );
        offset += utf16::len(fragment);
    };
    let mut cursor = 0;
    for token in match_template_tokens(template, INSERTION_VARIABLES) {
        let start = token.byte_index();
        collect_fragment_tokens(&template[cursor..start]);
        collect_fragment_tokens(if token.escaped {
            utf16::slice(token.raw, 1, None)
        } else {
            replacement(token.variable).ok_or(TemplateExpansionError::MissingValue)?
        });
        cursor = start + token.raw.len();
    }
    collect_fragment_tokens(&template[cursor..]);

    if match_template_tokens(expanded, RUNTIME_TEMPLATE_VARIABLES)
        .map(|token| (token.index, token.raw))
        .ne(expected)
    {
        return Err(SnippetTemplateError::Boundary(
            ScheduledSnippetBoundaryError,
        ));
    }
    Ok(())
}

pub fn expand_snippet_template<S: AsRef<str>>(
    template: &str,
    values: &SnippetTemplateValues<'_, S>,
) -> Result<String, SnippetTemplateError> {
    Ok(expand_template(
        template,
        SNIPPET_TEMPLATE_VARIABLES,
        |variable| match variable {
            "arguments" => Some(values.arguments),
            "project_path" => Some(values.project_path),
            _ => values.context.get(variable),
        },
        SNIPPET_EXPANDED_MAX_LENGTH as f64,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::template_tokens::TEMPLATE_VALIDATION_VALUES;

    #[test]
    fn expands_immediate_and_scheduled_templates() {
        let values = SnippetTemplateValues {
            arguments: "API",
            project_path: "/repo",
            context: &TEMPLATE_VALIDATION_VALUES,
        };
        assert_eq!(
            expand_snippet_template(
                "Chat {{chat_id}}: {{arguments}} in {{project_path}}",
                &values
            )
            .unwrap(),
            "Chat 1111111111111111: API in /repo"
        );
        assert_eq!(
            expand_scheduled_snippet_template(
                "{{arguments}} for {{chat_id}} \\{{chat_id}}",
                "{{chat_id}}",
                "/repo"
            )
            .unwrap(),
            "\\{{chat_id}} for {{chat_id}} \\{{chat_id}}"
        );
    }

    #[test]
    fn rejects_joins_that_create_or_escape_runtime_tokens() {
        for variable in RUNTIME_TEMPLATE_VARIABLES {
            let mut template = format!("{{{{arguments}}}}{{{{{variable}}}}}");
            assert_eq!(
                expand_scheduled_snippet_template(&template, "report\\", "/repo"),
                Err(SnippetTemplateError::Boundary(
                    ScheduledSnippetBoundaryError
                ))
            );
            template.insert(13, ' ');
            assert!(expand_scheduled_snippet_template(&template, "report\\", "/repo").is_ok());
        }
    }
}
