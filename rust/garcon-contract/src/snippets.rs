//! Ports `common/snippets.ts`.

use std::{cmp::Ordering, collections::HashSet, fmt, sync::LazyLock};

use garcon_js::{
    OptionalNullable, clock::to_iso_string, collation::Collation, date_parse::date_parse,
    is_safe_integer, json::as_number, trim, utf16,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_id::{ChatId, parse_chat_id};
use crate::executors::{ExecutorId, LOCAL_EXECUTOR_ID, parse_executor_id};
use crate::template_tokens::{
    CHAT_ID_TEMPLATE_TOKEN, RUNTIME_TEMPLATE_VARIABLES, TemplateTokenMatch, match_template_tokens,
};

pub const SNIPPET_MAX_COUNT: usize = 100;
pub const SNIPPET_SHORT_NAME_MAX_LENGTH: usize = 64;
pub const SNIPPET_TEMPLATE_MAX_LENGTH: usize = 32_000;
pub const SNIPPET_ARGUMENTS_MAX_LENGTH: usize = 32_000;
pub const SNIPPET_EXPANDED_MAX_LENGTH: usize = 64_000;
pub const SNIPPET_ARGUMENTS_TOKEN: &str = "{{arguments}}";
pub const SNIPPET_PROJECT_PATH_TOKEN: &str = "{{project_path}}";
pub const SNIPPET_CHAT_ID_TOKEN: &str = CHAT_ID_TEMPLATE_TOKEN;

pub static SNIPPET_SHORT_NAME_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: this constant is a valid regex.
    Regex::new(r"^[a-z0-9][a-z0-9_-]{0,63}$").expect("snippet short name pattern")
});

pub const SNIPPET_TEMPLATE_VARIABLES: &[&str] = &[
    "arguments",
    "project_path",
    RUNTIME_TEMPLATE_VARIABLES[0],
    RUNTIME_TEMPLATE_VARIABLES[1],
    RUNTIME_TEMPLATE_VARIABLES[2],
];

pub type SnippetTemplateTokenMatch<'a> = TemplateTokenMatch<'a>;

pub fn match_snippet_template_tokens(
    template: &str,
) -> impl Iterator<Item = SnippetTemplateTokenMatch<'_>> {
    match_template_tokens(template, SNIPPET_TEMPLATE_VARIABLES)
}

pub fn snippet_template_token_signature(template: &str) -> Vec<String> {
    match_snippet_template_tokens(template)
        .map(|token| {
            format!(
                "{}:{}",
                if token.escaped { "escaped" } else { "active" },
                token.variable
            )
        })
        .collect()
}

pub fn has_same_snippet_template_token_signature(first: &str, second: &str) -> bool {
    snippet_template_token_signature(first) == snippet_template_token_signature(second)
}

fn snippet_template_uses_variable(template: &str, variable: &str) -> bool {
    match_snippet_template_tokens(template)
        .any(|token| !token.escaped && token.variable == variable)
}

pub fn snippet_template_uses_arguments(template: &str) -> bool {
    snippet_template_uses_variable(template, "arguments")
}

pub fn snippet_template_uses_project_path(template: &str) -> bool {
    snippet_template_uses_variable(template, "project_path")
}

pub fn snippet_template_uses_chat_id(template: &str) -> bool {
    snippet_template_uses_variable(template, "chat_id")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct SnippetErrorCode(&'static str);

impl SnippetErrorCode {
    pub const VALIDATION_FAILED: Self = Self("SNIPPET_VALIDATION_FAILED");
    pub const NOT_FOUND: Self = Self("SNIPPET_NOT_FOUND");
    pub const NAME_CONFLICT: Self = Self("SNIPPET_NAME_CONFLICT");
    pub const REVISION_CONFLICT: Self = Self("SNIPPET_REVISION_CONFLICT");
    pub const REVISION_EXHAUSTED: Self = Self("SNIPPET_REVISION_EXHAUSTED");
    pub const CATALOG_SAVE_UNKNOWN: Self = Self("SNIPPET_CATALOG_SAVE_UNKNOWN");
    pub const LIMIT_REACHED: Self = Self("SNIPPET_LIMIT_REACHED");
    pub const EXPANSION_TOO_LONG: Self = Self("SNIPPET_EXPANSION_TOO_LONG");
    pub const CHAT_NOT_FOUND: Self = Self("SNIPPET_CHAT_NOT_FOUND");
    pub const PROJECT_PATH_REQUIRED: Self = Self("SNIPPET_PROJECT_PATH_REQUIRED");
    pub const PROJECT_PATH_OUTSIDE_BASE: Self = Self("SNIPPET_PROJECT_PATH_OUTSIDE_BASE");
    pub const PROJECT_PATH_NOT_FOUND: Self = Self("SNIPPET_PROJECT_PATH_NOT_FOUND");
    pub const PROJECT_PATH_INACCESSIBLE: Self = Self("SNIPPET_PROJECT_PATH_INACCESSIBLE");
    pub const PROJECT_PATH_NOT_DIRECTORY: Self = Self("SNIPPET_PROJECT_PATH_NOT_DIRECTORY");
    pub const CONTEXT_CHANGED: Self = Self("SNIPPET_CONTEXT_CHANGED");

    pub fn as_str(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for SnippetErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

pub const SNIPPET_VALIDATION_ERROR_MESSAGE: &str = "Snippet is invalid";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    #[serde(flatten)]
    pub definition: SnippetDefinitionInput,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetDefinitionInput {
    pub short_name: String,
    pub template: String,
    pub default_arguments: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnippetsSnapshot {
    pub revision: u64,
    pub snippets: Vec<Snippet>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSnippetRequest {
    pub expected_revision: u64,
    pub snippet: SnippetDefinitionInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateSnippetRequest {
    #[serde(flatten)]
    pub request: CreateSnippetRequest,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveSnippetRequest {
    pub expected_revision: u64,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnippetsMutationResponse {
    pub success: bool,
    pub snapshot: SnippetsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ScheduledSnippetExpansionTarget {
    Chat {
        chat_id: ChatId,
    },
    NewChat {
        project_path: String,
        #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
        executor_id: OptionalNullable<ExecutorId>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SnippetExpansionContext {
    ScheduledPrompt {
        target: ScheduledSnippetExpansionTarget,
    },
    Chat {
        chat_id: ChatId,
    },
    NewChat {
        chat_id: ChatId,
        project_path: String,
        #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
        executor_id: OptionalNullable<ExecutorId>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SnippetArgumentsInput {
    Default,
    Value { value: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandSnippetRequest {
    pub short_name: String,
    pub arguments: SnippetArgumentsInput,
    pub context: SnippetExpansionContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnippetExpansionSource {
    Snippet,
    Preamble,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandSnippetResponse {
    pub success: bool,
    pub source: SnippetExpansionSource,
    pub source_id: String,
    pub source_updated_at: String,
    pub short_name: String,
    pub context_project_path: String,
    pub context_executor_id: ExecutorId,
    pub expanded_text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnippetsInvalidationReason {
    Created,
    Updated,
    Removed,
}

pub const SNIPPETS_INVALIDATION_REASONS: &[&str] = &["created", "updated", "removed"];

fn required_string(value: &Value) -> Option<&str> {
    value.as_str().map(trim).filter(|text| !text.is_empty())
}

fn required_path(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !trim(text).is_empty())
}

fn iso_timestamp(value: &Value) -> Option<String> {
    to_iso_string(date_parse(value.as_str()?)?).ok()
}

pub fn is_snippet_short_name(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|name| SNIPPET_SHORT_NAME_PATTERN.is_match(name))
}

pub fn is_snippets_invalidation_reason(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| SNIPPETS_INVALIDATION_REASONS.contains(&text))
}

pub fn normalize_snippet_definition_input(value: &Value) -> Option<SnippetDefinitionInput> {
    let raw = value.as_object()?;
    let short_name = raw
        .get("shortName")
        .filter(|value| is_snippet_short_name(value))?
        .as_str()?;
    let template = raw.get("template")?.as_str()?;
    if trim(template).is_empty() || utf16::len(template) > SNIPPET_TEMPLATE_MAX_LENGTH {
        return None;
    }
    let default_arguments = raw.get("defaultArguments")?.as_str()?;
    if utf16::len(default_arguments) > SNIPPET_ARGUMENTS_MAX_LENGTH
        || (!default_arguments.is_empty() && !snippet_template_uses_arguments(template))
    {
        return None;
    }
    Some(SnippetDefinitionInput {
        short_name: short_name.to_owned(),
        template: template.to_owned(),
        default_arguments: default_arguments.to_owned(),
    })
}

pub fn normalize_snippet(value: &Value) -> Option<Snippet> {
    let raw = value.as_object()?;
    let id = required_string(raw.get("id")?)?.to_owned();
    let definition = normalize_snippet_definition_input(value)?;
    let created_at = iso_timestamp(raw.get("createdAt")?)?;
    let updated_at = iso_timestamp(raw.get("updatedAt")?)?;
    Some(Snippet {
        id,
        definition,
        created_at,
        updated_at,
    })
}

pub fn compare_snippet_short_names(left: &str, right: &str) -> Ordering {
    Collation::english_numeric_base().compare(left, right)
}

pub fn sort_snippets_by_short_name(snippets: &[Snippet]) -> Vec<Snippet> {
    let mut sorted = snippets.to_vec();
    sorted.sort_by(|left, right| {
        compare_snippet_short_names(&left.definition.short_name, &right.definition.short_name)
            .then_with(|| Collation::english().compare(&left.id, &right.id))
    });
    sorted
}

pub fn normalize_snippets_snapshot(value: &Value) -> Option<SnippetsSnapshot> {
    let raw = value.as_object()?;
    let revision = as_number(raw.get("revision")?)
        .filter(|value| is_safe_integer(*value) && *value >= 0.0)? as u64;
    let snippets = raw.get("snippets")?.as_array()?;
    if snippets.len() > SNIPPET_MAX_COUNT {
        return None;
    }
    let snippets: Vec<_> = snippets
        .iter()
        .map(normalize_snippet)
        .collect::<Option<_>>()?;
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for snippet in &snippets {
        if !ids.insert(&snippet.id) || !names.insert(&snippet.definition.short_name) {
            return None;
        }
    }
    Some(SnippetsSnapshot {
        revision,
        snippets: sort_snippets_by_short_name(&snippets),
    })
}

pub fn normalize_snippets_mutation_response(value: &Value) -> Option<SnippetsMutationResponse> {
    let raw = value.as_object()?;
    if raw.get("success")?.as_bool() != Some(true) {
        return None;
    }
    let snapshot = normalize_snippets_snapshot(raw.get("snapshot")?)?;
    Some(SnippetsMutationResponse {
        success: true,
        snapshot,
    })
}

pub fn normalize_snippet_arguments_input(value: &Value) -> Option<SnippetArgumentsInput> {
    let raw = value.as_object()?;
    match raw.get("type")?.as_str()? {
        "default" => Some(SnippetArgumentsInput::Default),
        "value" => {
            let value = raw.get("value")?.as_str()?;
            (utf16::len(value) <= SNIPPET_ARGUMENTS_MAX_LENGTH).then(|| {
                SnippetArgumentsInput::Value {
                    value: value.to_owned(),
                }
            })
        }
        _ => None,
    }
}

fn omit_local_executor_id(value: ExecutorId) -> OptionalNullable<ExecutorId> {
    if value == LOCAL_EXECUTOR_ID {
        OptionalNullable::ABSENT
    } else {
        OptionalNullable::some(value)
    }
}

pub fn normalize_expand_snippet_request(value: &Value) -> Option<ExpandSnippetRequest> {
    let raw = value.as_object()?;
    let arguments = normalize_snippet_arguments_input(raw.get("arguments")?)?;
    let context = raw.get("context")?.as_object()?;
    let short_name = raw
        .get("shortName")
        .filter(|value| is_snippet_short_name(value))?
        .as_str()?
        .to_owned();
    let context = match context.get("type")?.as_str()? {
        "scheduled-prompt" => {
            let target = context.get("target")?.as_object()?;
            let target = match target.get("type")?.as_str()? {
                "chat" => ScheduledSnippetExpansionTarget::Chat {
                    chat_id: parse_chat_id(target.get("chatId")?).ok()?,
                },
                "new-chat" => ScheduledSnippetExpansionTarget::NewChat {
                    project_path: required_path(target.get("projectPath")?)?.to_owned(),
                    executor_id: omit_local_executor_id(parse_executor_id(
                        target.get("executorId").unwrap_or(&Value::Null),
                    )?),
                },
                _ => return None,
            };
            SnippetExpansionContext::ScheduledPrompt { target }
        }
        "chat" => SnippetExpansionContext::Chat {
            chat_id: parse_chat_id(context.get("chatId")?).ok()?,
        },
        "new-chat" => {
            let project_path = required_path(context.get("projectPath")?)?.to_owned();
            let executor_id = omit_local_executor_id(parse_executor_id(
                context.get("executorId").unwrap_or(&Value::Null),
            )?);
            SnippetExpansionContext::NewChat {
                chat_id: parse_chat_id(context.get("chatId")?).ok()?,
                project_path,
                executor_id,
            }
        }
        _ => return None,
    };
    Some(ExpandSnippetRequest {
        short_name,
        arguments,
        context,
    })
}

pub fn normalize_expand_snippet_response(value: &Value) -> Option<ExpandSnippetResponse> {
    let raw = value.as_object()?;
    let source_id = required_string(raw.get("sourceId")?)?;
    let source_updated_at = iso_timestamp(raw.get("sourceUpdatedAt")?)?;
    let context_project_path = required_path(raw.get("contextProjectPath")?)?;
    let context_executor_id =
        parse_executor_id(raw.get("contextExecutorId").unwrap_or(&Value::Null))?;
    if raw.get("success")?.as_bool() != Some(true) {
        return None;
    }
    let source = match raw.get("source")?.as_str()? {
        "snippet" => SnippetExpansionSource::Snippet,
        "preamble" => SnippetExpansionSource::Preamble,
        _ => return None,
    };
    let short_name = raw
        .get("shortName")
        .filter(|value| is_snippet_short_name(value))?
        .as_str()?;
    let expanded_text = raw.get("expandedText")?.as_str()?;
    if utf16::len(expanded_text) > SNIPPET_EXPANDED_MAX_LENGTH {
        return None;
    }
    Some(ExpandSnippetResponse {
        success: true,
        source,
        source_id: source_id.to_owned(),
        source_updated_at,
        short_name: short_name.to_owned(),
        context_project_path: context_project_path.to_owned(),
        context_executor_id,
        expanded_text: expanded_text.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compares_names_case_insensitively_with_numeric_segments() {
        let mut names = ["Zulu", "alpha-10", "Alpha-2", "beta"];
        names.sort_by(|first, second| compare_snippet_short_names(first, second));
        assert_eq!(names, ["Alpha-2", "alpha-10", "beta", "Zulu"]);
    }

    #[test]
    fn preserves_template_and_default_argument_whitespace_without_normalization() {
        let input = json!({"shortName":"review_api-2","template":"\nReview {{arguments}}\n","defaultArguments":"\n staged changes \n"});
        let definition = normalize_snippet_definition_input(&input).unwrap();
        assert_eq!(json!(definition), input);
    }

    #[test]
    fn requires_a_bounded_default_and_an_active_arguments_token_for_nonempty_values() {
        let long = "\u{1f600}".repeat(SNIPPET_ARGUMENTS_MAX_LENGTH / 2);
        for (template, default_arguments, valid) in [
            ("{{arguments}}", long.clone(), true),
            ("{{arguments}}", long + "!", false),
            ("\\{{arguments}}", "keep".to_owned(), false),
            ("\\{{arguments}}", String::new(), true),
        ] {
            let input = json!({"shortName":"review","template":template,"defaultArguments":default_arguments});
            assert_eq!(normalize_snippet_definition_input(&input).is_some(), valid);
        }
    }

    #[test]
    fn accepts_a_future_new_chat_without_inventing_a_chat_id_and_preserves_executor_identity() {
        let input = json!({"shortName":"review","arguments":{"type":"default"},"context":{
            "type":"scheduled-prompt","target":{"type":"new-chat", "projectPath":"/repo", "executorId":"11111111-1111-4111-8111-111111111111"}
        }});
        assert_eq!(
            json!(normalize_expand_snippet_request(&input).unwrap()),
            input
        );
    }

    #[test]
    fn captures_ordered_active_and_escaped_template_token_signatures() {
        assert_eq!(
            snippet_template_token_signature("{{chat_id}} \\{{arguments}} {{current_date_local}}"),
            [
                "active:chat_id",
                "escaped:arguments",
                "active:current_date_local"
            ]
        );
        assert!(has_same_snippet_template_token_signature(
            "{{current_date}}",
            "date: {{current_date}}"
        ));
        assert!(!has_same_snippet_template_token_signature(
            "{{current_date}}",
            "\\{{current_date}}"
        ));
    }
}
