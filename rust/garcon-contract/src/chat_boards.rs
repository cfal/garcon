//! Ports `common/chat-boards.ts`.

use std::sync::LazyLock;

use garcon_js::{is_safe_integer, trim};
use icu_normalizer::ComposingNormalizer;
use indexmap::IndexSet;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::tags::{normalize_tag_slug, normalize_tag_strings, normalize_tags};

pub const CHAT_BOARD_MAX_COUNT: usize = 50;
pub const CHAT_BOARD_COLUMN_MAX_COUNT: usize = 20;
pub const CHAT_BOARD_COLUMN_TAG_MAX_COUNT: usize = 32;
pub const CHAT_BOARD_NAME_MAX_CODE_POINTS: usize = 80;
pub const CHAT_BOARD_TAG_MAX_CODE_POINTS: usize = 64;
pub const CHAT_BOARDS_FILE_MAX_BYTES: usize = 4 * 1024 * 1024;

pub type ChatBoardId = String;
pub type ChatBoardColumnId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatBoardMatchMode {
    All,
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatBoardColumnRule {
    pub r#match: ChatBoardMatchMode,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatBoardColumn {
    pub id: ChatBoardColumnId,
    pub name: String,
    #[serde(flatten)]
    pub rule: ChatBoardColumnRule,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatBoard {
    pub id: ChatBoardId,
    pub name: String,
    pub columns: Vec<ChatBoardColumn>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatBoardCatalog {
    pub revision: u64,
    pub boards: Vec<ChatBoard>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChatBoardRequest {
    pub expected_revision: u64,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChatBoardRequest {
    pub expected_revision: u64,
    pub board: ChatBoard,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteChatBoardRequest {
    pub expected_revision: u64,
    pub board_id: ChatBoardId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderChatBoardsRequest {
    pub expected_revision: u64,
    pub ordered_board_ids: Vec<ChatBoardId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatBoardMutationResponse {
    pub success: bool,
    pub catalog: ChatBoardCatalog,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChatBoardResponse {
    #[serde(flatten)]
    pub response: ChatBoardMutationResponse,
    pub board_id: ChatBoardId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatBoardInvalidationReason {
    Created,
    Updated,
    Removed,
    Reordered,
}

pub const CHAT_BOARD_INVALIDATION_REASONS: &[ChatBoardInvalidationReason] = &[
    ChatBoardInvalidationReason::Created,
    ChatBoardInvalidationReason::Updated,
    ChatBoardInvalidationReason::Removed,
    ChatBoardInvalidationReason::Reordered,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatBoardErrorCodes {
    pub validation_failed: &'static str,
    pub not_found: &'static str,
    pub revision_conflict: &'static str,
    pub revision_exhausted: &'static str,
    pub limit_reached: &'static str,
    pub catalog_save_unknown: &'static str,
    pub transition_invalid: &'static str,
    pub transition_chat_archived: &'static str,
    pub transition_noop: &'static str,
}

pub const CHAT_BOARD_ERROR_CODES: ChatBoardErrorCodes = ChatBoardErrorCodes {
    validation_failed: "CHAT_BOARD_VALIDATION_FAILED",
    not_found: "CHAT_BOARD_NOT_FOUND",
    revision_conflict: "CHAT_BOARD_REVISION_CONFLICT",
    revision_exhausted: "CHAT_BOARD_REVISION_EXHAUSTED",
    limit_reached: "CHAT_BOARD_LIMIT_REACHED",
    catalog_save_unknown: "CHAT_BOARD_CATALOG_SAVE_UNKNOWN",
    transition_invalid: "CHAT_BOARD_TRANSITION_INVALID",
    transition_chat_archived: "CHAT_BOARD_TRANSITION_CHAT_ARCHIVED",
    transition_noop: "CHAT_BOARD_TRANSITION_NOOP",
};

static UUID_V4_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the original uses the same literal regex.
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        .expect("the board UUID pattern compiles")
});

pub fn is_chat_board_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|value| UUID_V4_PATTERN.is_match(value))
}

pub use is_chat_board_id as is_chat_board_column_id;

fn has_only_keys(value: &Map<String, Value>, keys: &[&str]) -> bool {
    value.keys().all(|key| keys.contains(&key.as_str()))
}

fn canonical_name(value: &Value) -> Option<String> {
    let name = ComposingNormalizer::new_nfc().normalize(trim(value.as_str()?));
    (!name.is_empty() && name.chars().count() <= CHAT_BOARD_NAME_MAX_CODE_POINTS)
        .then(|| name.into_owned())
}

fn name_key(value: &str) -> String {
    ComposingNormalizer::new_nfkc()
        .normalize(value)
        .to_lowercase()
}

fn canonical_rule_tags(raw: &[Value]) -> Option<Vec<String>> {
    if raw.is_empty()
        || raw.len() > CHAT_BOARD_COLUMN_TAG_MAX_COUNT
        || !raw.iter().all(Value::is_string)
    {
        return None;
    }
    let tags = normalize_tags(raw);
    if tags.len() != raw.len()
        || tags
            .iter()
            .zip(raw)
            .any(|(tag, raw)| Some(tag.as_str()) != raw.as_str())
        || tags
            .iter()
            .any(|tag| tag.chars().count() > CHAT_BOARD_TAG_MAX_CODE_POINTS)
    {
        return None;
    }
    Some(tags)
}

pub fn normalize_chat_board_column(value: &Value) -> Option<ChatBoardColumn> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["id", "name", "match", "tags"])
        || !is_chat_board_column_id(raw.get("id")?)
    {
        return None;
    }
    let mode = match raw.get("match")?.as_str()? {
        "all" => ChatBoardMatchMode::All,
        "any" => ChatBoardMatchMode::Any,
        _ => return None,
    };
    let name = canonical_name(raw.get("name")?)?;
    let tags = canonical_rule_tags(raw.get("tags")?.as_array()?)?;
    Some(ChatBoardColumn {
        id: raw.get("id")?.as_str()?.to_owned(),
        name,
        rule: ChatBoardColumnRule {
            r#match: mode,
            tags,
        },
    })
}

pub fn normalize_chat_board(value: &Value) -> Option<ChatBoard> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["id", "name", "columns"]) || !is_chat_board_id(raw.get("id")?) {
        return None;
    }
    let name = canonical_name(raw.get("name")?)?;
    let columns = raw.get("columns")?.as_array()?;
    if columns.len() > CHAT_BOARD_COLUMN_MAX_COUNT {
        return None;
    }
    let columns: Vec<_> = columns
        .iter()
        .map(normalize_chat_board_column)
        .collect::<Option<_>>()?;
    if columns
        .iter()
        .map(|column| &column.id)
        .collect::<IndexSet<_>>()
        .len()
        != columns.len()
        || columns
            .iter()
            .map(|column| name_key(&column.name))
            .collect::<IndexSet<_>>()
            .len()
            != columns.len()
    {
        return None;
    }
    Some(ChatBoard {
        id: raw.get("id")?.as_str()?.to_owned(),
        name,
        columns,
    })
}

pub fn normalize_chat_board_catalog(value: &Value) -> Option<ChatBoardCatalog> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["revision", "boards"]) {
        return None;
    }
    let revision = raw.get("revision")?.as_f64()?;
    if !is_safe_integer(revision) || revision < 0.0 {
        return None;
    }
    let boards = raw.get("boards")?.as_array()?;
    if boards.len() > CHAT_BOARD_MAX_COUNT {
        return None;
    }
    let boards: Vec<_> = boards
        .iter()
        .map(normalize_chat_board)
        .collect::<Option<_>>()?;
    let mut column_ids = IndexSet::new();
    if boards
        .iter()
        .map(|board| &board.id)
        .collect::<IndexSet<_>>()
        .len()
        != boards.len()
        || !boards
            .iter()
            .flat_map(|board| &board.columns)
            .all(|column| column_ids.insert(&column.id))
        || boards
            .iter()
            .map(|board| name_key(&board.name))
            .collect::<IndexSet<_>>()
            .len()
            != boards.len()
    {
        return None;
    }
    Some(ChatBoardCatalog {
        revision: revision as u64,
        boards,
    })
}

pub fn normalize_chat_board_mutation_response(value: &Value) -> Option<ChatBoardMutationResponse> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["success", "catalog"]) || raw.get("success")?.as_bool() != Some(true) {
        return None;
    }
    let catalog = normalize_chat_board_catalog(raw.get("catalog")?)?;
    Some(ChatBoardMutationResponse {
        success: true,
        catalog,
    })
}

pub fn normalize_create_chat_board_response(value: &Value) -> Option<CreateChatBoardResponse> {
    let raw = value.as_object()?;
    if !has_only_keys(raw, &["success", "catalog", "boardId"])
        || raw.get("success")?.as_bool() != Some(true)
    {
        return None;
    }
    let catalog = normalize_chat_board_catalog(raw.get("catalog")?)?;
    let board_id = raw.get("boardId")?;
    if !is_chat_board_id(board_id) {
        return None;
    }
    Some(CreateChatBoardResponse {
        response: ChatBoardMutationResponse {
            success: true,
            catalog,
        },
        board_id: board_id.as_str()?.into(),
    })
}

pub fn chat_matches_board_column(chat_tags: &[String], column: &ChatBoardColumnRule) -> bool {
    tag_set_matches_board_column(&chat_tags.iter().map(String::as_str).collect(), column)
}

pub fn tag_set_matches_board_column(
    present: &IndexSet<&str>,
    column: &ChatBoardColumnRule,
) -> bool {
    if column.tags.is_empty() {
        return false;
    }
    match column.r#match {
        ChatBoardMatchMode::All => column.tags.iter().all(|tag| present.contains(tag.as_str())),
        ChatBoardMatchMode::Any => column.tags.iter().any(|tag| present.contains(tag.as_str())),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTagTransitionPreview {
    pub removed_tags: Vec<String>,
    pub added_tags: Vec<String>,
    pub resulting_tags: Vec<String>,
}

pub fn calculate_chat_tag_transition(
    current: &[String],
    source: &[String],
    applied_target: &[String],
) -> ChatTagTransitionPreview {
    let current = normalize_tag_strings(current.iter().map(String::as_str));
    let source: IndexSet<_> = normalize_tag_strings(source.iter().map(String::as_str))
        .into_iter()
        .collect();
    let target = normalize_tag_strings(applied_target.iter().map(String::as_str));
    let resulting_tags = normalize_tag_strings(
        current
            .iter()
            .filter(|tag| !source.contains(*tag))
            .chain(&target)
            .map(String::as_str),
    );
    let before: IndexSet<_> = current.iter().collect();
    let after: IndexSet<_> = resulting_tags.iter().collect();
    let removed_tags = current
        .iter()
        .filter(|tag| !after.contains(*tag))
        .cloned()
        .collect();
    let added_tags = resulting_tags
        .iter()
        .filter(|tag| !before.contains(*tag))
        .cloned()
        .collect();
    ChatTagTransitionPreview {
        removed_tags,
        added_tags,
        resulting_tags,
    }
}

pub fn normalize_board_tag_input(value: &Value) -> Option<String> {
    let normalized = normalize_tag_slug(value.as_str()?);
    (!normalized.is_empty() && normalized.chars().count() <= CHAT_BOARD_TAG_MAX_CODE_POINTS)
        .then_some(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const BOARD: &str = "11111111-1111-4111-8111-111111111111";
    const COLUMN_A: &str = "22222222-2222-4222-8222-222222222222";
    const COLUMN_B: &str = "33333333-3333-4333-8333-333333333333";

    #[test]
    fn accepts_canonical_empty_and_populated_catalogs() {
        let empty = json!({"revision":0,"boards":[]});
        assert_eq!(normalize_chat_board_catalog(&empty).unwrap().revision, 0);
        let raw = json!({"revision":4,"boards":[{"id":BOARD,"name":"Delivery","columns":[
            {"id":COLUMN_A,"name":"Ready","match":"all","tags":["ready","web"]}
        ]}]});
        assert_eq!(
            serde_json::to_value(normalize_chat_board_catalog(&raw).unwrap()).unwrap(),
            raw
        );
    }

    #[test]
    fn rejects_unknown_keys_noncanonical_ids_tags_and_empty_rules() {
        assert!(
            normalize_chat_board_catalog(&json!({"revision":0,"boards":[],"extra":true})).is_none()
        );
        assert!(normalize_chat_board_catalog(&json!({"revision":-1,"boards":[]})).is_none());
        assert!(
            normalize_chat_board(&json!({"id":"board","name":"Delivery","columns":[]})).is_none()
        );
        for tags in [json!([]), json!(["Web"]), json!(["web", "ready"])] {
            let raw = json!({"id":COLUMN_A,"name":"Ready","match":"all","tags":tags});
            assert!(normalize_chat_board_column(&raw).is_none());
        }
    }

    #[test]
    fn rejects_duplicate_identities_and_case_folded_names_across_their_scopes() {
        let catalog = json!({"revision":0,"boards":[
            {"id":BOARD,"name":"\u{ff24}elivery","columns":[]},
            {"id":COLUMN_A,"name":"delivery","columns":[]}
        ]});
        assert!(normalize_chat_board_catalog(&catalog).is_none());
        let columns = json!({"id":BOARD,"name":"Delivery","columns":[
            {"id":COLUMN_A,"name":"Caf\u{e9}","match":"all","tags":["ready"]},
            {"id":COLUMN_B,"name":"Cafe\u{301}","match":"any","tags":["review"]}
        ]});
        assert!(normalize_chat_board(&columns).is_none());
    }

    #[test]
    fn calculates_net_transition_changes_and_reapplies_shared_tags() {
        let preview = calculate_chat_tag_transition(
            &["customer-a".into(), "ready".into(), "shared".into()],
            &["ready".into(), "shared".into()],
            &["review".into(), "shared".into()],
        );
        assert_eq!(preview.removed_tags, ["ready"]);
        assert_eq!(preview.added_tags, ["review"]);
        assert_eq!(preview.resulting_tags, ["customer-a", "review", "shared"]);
    }
}
