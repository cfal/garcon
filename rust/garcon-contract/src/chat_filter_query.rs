//! Ports `common/chat-filter-query.ts`.

use std::{collections::HashSet, sync::LazyLock};

use garcon_js::{clock::to_iso_string, date_parse::date_parse, trim};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_id::parse_chat_id;
use crate::chat_order_contracts::{PERSISTED_CHAT_ORDER_GROUPS, PersistedChatOrderGroup};

pub type ChatFilterOrGroup = Vec<String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatFilterStatus {
    Active,
    Unread,
}

impl ChatFilterStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Unread => "unread",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatOrderGroupFilter {
    pub group: PersistedChatOrderGroup,
    pub negated: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFilterSpec {
    pub text_tokens: Vec<String>,
    pub titles: Vec<ChatFilterOrGroup>,
    pub tags: Vec<ChatFilterOrGroup>,
    pub agents: Vec<String>,
    pub models: Vec<String>,
    pub project: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ChatFilterStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_group: Option<ChatOrderGroupFilter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<ChatFilterOrGroup>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parents: Option<Vec<ChatFilterOrGroup>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<ChatFilterOrGroup>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_before: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_after: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_before: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_after: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFilterParseResult {
    pub spec: ChatFilterSpec,
    pub invalid_tokens: Vec<String>,
    pub text_terms: Vec<ChatFilterTerm>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChatFilterTerm {
    pub text: String,
    pub quoted: bool,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFilterLineage {
    pub source_chat_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatFilterTarget {
    pub id: String,
    pub parent_chat_id: Option<String>,
    pub lineage: Option<ChatFilterLineage>,
    pub title: String,
    pub project_path: String,
    pub agent_id: String,
    pub model: Option<String>,
    pub tags: Vec<String>,
    pub is_processing: bool,
    pub is_unread: bool,
    pub is_pinned: bool,
    pub is_archived: bool,
    pub created_at: Option<String>,
    pub last_activity_at: Option<String>,
    pub first_message: Option<String>,
    pub last_message: Option<String>,
}

pub fn empty_filter_spec() -> ChatFilterSpec {
    ChatFilterSpec::default()
}

pub fn is_empty_filter(spec: &ChatFilterSpec) -> bool {
    spec.text_tokens.is_empty()
        && spec.titles.is_empty()
        && spec.tags.is_empty()
        && spec.agents.is_empty()
        && spec.models.is_empty()
        && spec.status.is_none()
        && spec.order_group.is_none()
        && spec.project.is_empty()
        && spec.ids.as_deref().unwrap_or_default().is_empty()
        && spec.parents.as_deref().unwrap_or_default().is_empty()
        && spec.sources.as_deref().unwrap_or_default().is_empty()
        && spec
            .created_before
            .as_deref()
            .unwrap_or_default()
            .is_empty()
        && spec.created_after.as_deref().unwrap_or_default().is_empty()
        && spec
            .updated_before
            .as_deref()
            .unwrap_or_default()
            .is_empty()
        && spec.updated_after.as_deref().unwrap_or_default().is_empty()
}

pub fn parse_chat_filter_query(query: &str) -> ChatFilterParseResult {
    let mut spec = empty_filter_spec();
    let mut invalid_tokens = Vec::new();
    let mut text_terms = Vec::new();
    for term in tokenize_chat_filter(trim(query)) {
        let lower = term.text.to_lowercase();
        let valid = match lower.split_once(':') {
            Some(("status", value)) => match trim(value) {
                "active" => {
                    spec.status = Some(ChatFilterStatus::Active);
                    true
                }
                "unread" => {
                    spec.status = Some(ChatFilterStatus::Unread);
                    true
                }
                _ => false,
            },
            Some(("is", value)) => {
                let value = trim(value);
                let negated = value.starts_with('!');
                let raw_group = value.strip_prefix('!').unwrap_or(value);
                if let Some(group) = PERSISTED_CHAT_ORDER_GROUPS
                    .iter()
                    .find(|group| group.as_str() == raw_group)
                {
                    spec.order_group = Some(ChatOrderGroupFilter {
                        group: *group,
                        negated,
                    });
                    true
                } else {
                    false
                }
            }
            Some((operator @ ("title" | "tag" | "agent" | "model" | "project"), _)) => {
                let value = &term.text[operator.len() + 1..];
                if let Some(parts) = parse_pipe_value(value) {
                    match operator {
                        "title" => spec.titles.push(parts),
                        "tag" => spec.tags.push(parts),
                        "agent" => spec.agents.extend(parts),
                        "model" => spec.models.extend(parts),
                        _ => spec.project.extend(parts),
                    }
                    true
                } else {
                    false
                }
            }
            Some((operator @ ("id" | "parent" | "source"), _)) => {
                if let Some(parts) = parse_chat_id_group(&term.text[operator.len() + 1..]) {
                    let field = match operator {
                        "id" => &mut spec.ids,
                        "parent" => &mut spec.parents,
                        _ => &mut spec.sources,
                    };
                    field.get_or_insert_with(Vec::new).push(parts);
                    true
                } else {
                    false
                }
            }
            Some((
                operator
                @ ("created-before" | "created-after" | "updated-before" | "updated-after"),
                _,
            )) => {
                if let Some(timestamp) = parse_filter_timestamp(&term.text[operator.len() + 1..]) {
                    let field = match operator {
                        "created-before" => &mut spec.created_before,
                        "created-after" => &mut spec.created_after,
                        "updated-before" => &mut spec.updated_before,
                        _ => &mut spec.updated_after,
                    };
                    field.get_or_insert_with(Vec::new).push(timestamp);
                    true
                } else {
                    false
                }
            }
            _ => {
                spec.text_tokens.push(lower);
                text_terms.push(term);
                continue;
            }
        };
        if !valid {
            invalid_tokens.push(term.text);
        }
    }
    ChatFilterParseResult {
        spec,
        invalid_tokens,
        text_terms,
    }
}

pub fn parse_chat_search(query: &str) -> ChatFilterSpec {
    parse_chat_filter_query(query).spec
}

pub fn matches_chat_filter(chat: &ChatFilterTarget, spec: &ChatFilterSpec) -> bool {
    if (spec.status == Some(ChatFilterStatus::Active) && !chat.is_processing)
        || (spec.status == Some(ChatFilterStatus::Unread) && !chat.is_unread)
    {
        return false;
    }
    if let Some(filter) = spec.order_group {
        let group = chat_order_group_for(chat.is_pinned, chat.is_archived);
        if (group == filter.group) == filter.negated {
            return false;
        }
    }
    if !matches_id_groups(Some(&chat.id), spec.ids.as_deref().unwrap_or_default())
        || !matches_id_groups(
            chat.parent_chat_id.as_deref(),
            spec.parents.as_deref().unwrap_or_default(),
        )
        || !matches_id_groups(
            chat.lineage
                .as_ref()
                .map(|lineage| lineage.source_chat_id.as_str()),
            spec.sources.as_deref().unwrap_or_default(),
        )
    {
        return false;
    }
    if !matches_time_constraints(
        chat.created_at.as_deref(),
        spec.created_before.as_deref().unwrap_or_default(),
        spec.created_after.as_deref().unwrap_or_default(),
    ) || !matches_time_constraints(
        chat.last_activity_at.as_deref(),
        spec.updated_before.as_deref().unwrap_or_default(),
        spec.updated_after.as_deref().unwrap_or_default(),
    ) {
        return false;
    }
    if !spec.titles.is_empty() {
        let title = chat.title.to_lowercase();
        if !spec
            .titles
            .iter()
            .all(|group| group.iter().any(|candidate| title.contains(candidate)))
        {
            return false;
        }
    }
    if !matches_any_substring(&chat.project_path, &spec.project) {
        return false;
    }
    if !spec.tags.is_empty() {
        let tags: HashSet<_> = chat.tags.iter().map(|tag| tag.to_lowercase()).collect();
        if !spec
            .tags
            .iter()
            .all(|group| group.iter().any(|tag| tags.contains(tag)))
        {
            return false;
        }
    }
    if !matches_any_substring(&chat.agent_id, &spec.agents)
        || !matches_any_substring(chat.model.as_deref().unwrap_or_default(), &spec.models)
    {
        return false;
    }
    if !spec.text_tokens.is_empty() {
        let haystack = [
            chat.title.as_str(),
            chat.project_path.as_str(),
            chat.first_message.as_deref().unwrap_or_default(),
            chat.last_message.as_deref().unwrap_or_default(),
        ]
        .into_iter()
        .chain(chat.tags.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
        if !spec
            .text_tokens
            .iter()
            .all(|token| haystack.contains(token))
        {
            return false;
        }
    }
    true
}

fn matches_id_groups(id: Option<&str>, groups: &[ChatFilterOrGroup]) -> bool {
    groups
        .iter()
        .all(|group| id.is_some_and(|id| group.iter().any(|candidate| candidate == id)))
}

fn matches_any_substring(text: &str, values: &[String]) -> bool {
    if values.is_empty() {
        return true;
    }
    let text = text.to_lowercase();
    values.iter().any(|value| text.contains(value))
}

pub fn chat_order_group_for(is_pinned: bool, is_archived: bool) -> PersistedChatOrderGroup {
    if is_pinned {
        PersistedChatOrderGroup::Pinned
    } else if is_archived {
        PersistedChatOrderGroup::Archived
    } else {
        PersistedChatOrderGroup::Normal
    }
}

pub fn serialize_chat_filter(spec: &ChatFilterSpec) -> String {
    let mut parts = Vec::new();
    if let Some(status) = spec.status {
        parts.push(format!("status:{}", status.as_str()));
    }
    if let Some(filter) = spec.order_group {
        parts.push(format!(
            "is:{}{}",
            if filter.negated { "!" } else { "" },
            filter.group.as_str()
        ));
    }
    for (operator, groups) in [("title", &spec.titles), ("tag", &spec.tags)] {
        parts.extend(
            groups
                .iter()
                .map(|group| format!("{operator}:{}", quote_filter_value(&group.join("|")))),
        );
    }
    for (operator, values) in [("agent", &spec.agents), ("model", &spec.models)] {
        parts.extend(
            values
                .iter()
                .map(|value| format!("{operator}:{}", quote_filter_value(value))),
        );
    }
    if !spec.project.is_empty() {
        parts.push(format!(
            "project:{}",
            quote_filter_value(&spec.project.join("|"))
        ));
    }
    for (operator, groups) in [
        ("id", &spec.ids),
        ("parent", &spec.parents),
        ("source", &spec.sources),
    ] {
        parts.extend(
            groups
                .iter()
                .flatten()
                .map(|group| format!("{operator}:{}", group.join("|"))),
        );
    }
    for (operator, values) in [
        ("created-before", &spec.created_before),
        ("created-after", &spec.created_after),
        ("updated-before", &spec.updated_before),
        ("updated-after", &spec.updated_after),
    ] {
        parts.extend(
            values
                .iter()
                .flatten()
                .map(|value| format!("{operator}:{value}")),
        );
    }
    parts.extend(
        spec.text_tokens
            .iter()
            .map(|token| quote_filter_value(token)),
    );
    parts.join(" ")
}

pub fn query_has_tag(query: &str, tag: &str) -> bool {
    let tag = tag.to_lowercase();
    parse_chat_search(query)
        .tags
        .iter()
        .any(|group| group.contains(&tag))
}

pub fn add_tag_to_query(query: &str, tag: &str) -> String {
    if query_has_tag(query, tag) {
        return query.to_owned();
    }
    let prefix = trim(query);
    if prefix.is_empty() {
        format!("tag:{tag}")
    } else {
        format!("{prefix} tag:{tag}")
    }
}

pub fn remove_tag_from_query(query: &str, tag: &str) -> String {
    let escaped = regex::escape(tag);
    let pattern = format!(r"\btag:{escaped}\b");
    // The original's non-u regex folds individual UTF-16 code units.
    // INFALLIBLE: the tag is escaped and both boundaries are fixed.
    let pattern = regress::Regex::from_unicode(pattern.encode_utf16().map(u32::from), "i")
        .expect("escaped tag pattern");
    let query: Vec<_> = query.encode_utf16().collect();
    let mut result = Vec::with_capacity(query.len());
    let mut end = 0;
    for found in pattern.find_from_ucs2(&query, 0) {
        result.extend_from_slice(&query[end..found.range.start]);
        end = found.range.end;
    }
    result.extend_from_slice(&query[end..]);
    let result = String::from_utf16_lossy(&result);
    static SPACES: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: ECMAScript WhiteSpace and LineTerminator code points.
        Regex::new(r"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]{2,}").expect("whitespace pattern")
    });
    trim(&SPACES.replace_all(&result, " ")).to_owned()
}

fn parse_pipe_value(raw: &str) -> Option<Vec<String>> {
    let parts: Vec<_> = raw
        .split('|')
        .map(trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect();
    (!parts.is_empty()).then_some(parts)
}

fn parse_chat_id_group(raw: &str) -> Option<ChatFilterOrGroup> {
    parse_pipe_value(raw)?
        .iter()
        .map(|id| {
            parse_chat_id(&Value::String(id.clone()))
                .ok()
                .map(|id| id.to_string())
        })
        .collect()
}

fn parse_filter_timestamp(value: &str) -> Option<String> {
    static DATE: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: a fixed date pattern.
        Regex::new(r"\A([0-9]{4})-([0-9]{2})-([0-9]{2})\z").expect("date pattern")
    });
    static TIMESTAMP: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: a fixed timestamp pattern.
        Regex::new(r"\A([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})\z").expect("timestamp pattern")
    });
    if let Some(date) = DATE.captures(value) {
        return valid_calendar_date(
            date[1].parse().ok()?,
            date[2].parse().ok()?,
            date[3].parse().ok()?,
        )
        .then(|| format!("{value}T00:00:00.000Z"));
    }
    let stamp = TIMESTAMP.captures(value)?;
    if !valid_calendar_date(
        stamp[1].parse().ok()?,
        stamp[2].parse().ok()?,
        stamp[3].parse().ok()?,
    ) || stamp[4].parse::<u8>().ok()? > 23
        || stamp[5].parse::<u8>().ok()? > 59
        || stamp[6].parse::<u8>().ok()? > 59
    {
        return None;
    }
    let offset = &stamp[7];
    if offset != "Z"
        && (offset[1..3].parse::<u8>().ok()? > 23 || offset[4..6].parse::<u8>().ok()? > 59)
    {
        return None;
    }
    to_iso_string(date_parse(value)?).ok()
}

fn valid_calendar_date(year: u16, month: u8, day: u8) -> bool {
    if year == 0 || year > 9999 || day == 0 {
        return false;
    }
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 28 + u8::from(leap),
        _ => return false,
    };
    day <= days
}

fn matches_time_constraints(value: Option<&str>, before: &[String], after: &[String]) -> bool {
    if before.is_empty() && after.is_empty() {
        return true;
    }
    let Some(epoch) = value.and_then(date_parse) else {
        return false;
    };
    before
        .iter()
        .all(|limit| date_parse(limit).is_some_and(|limit| epoch < limit))
        && after
            .iter()
            .all(|limit| date_parse(limit).is_some_and(|limit| epoch > limit))
}

pub(crate) fn filter_whitespace(ch: char) -> bool {
    garcon_js::unicode::is_white_space(ch) || ch == '\u{feff}'
}

pub fn has_chat_filter_whitespace(value: &str) -> bool {
    value.chars().any(filter_whitespace)
}

pub fn tokenize_chat_filter(input: &str) -> Vec<ChatFilterTerm> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut in_quote = None;
    let mut quoted = false;
    let mut source = String::new();
    for ch in input.chars() {
        if let Some(close) = in_quote {
            source.push(ch);
            if ch == close {
                in_quote = None;
                push_term(&mut tokens, &mut current, &mut quoted, &mut source);
            } else {
                current.push(ch);
            }
        } else if matches!(ch, '"' | '\'') && (current.is_empty() || current.ends_with(':')) {
            source.push(ch);
            in_quote = Some(ch);
            quoted = true;
        } else if ch == '"' {
            push_term(&mut tokens, &mut current, &mut quoted, &mut source);
            source.push(ch);
            in_quote = Some(ch);
            quoted = true;
        } else if filter_whitespace(ch) {
            push_term(&mut tokens, &mut current, &mut quoted, &mut source);
        } else {
            current.push(ch);
            source.push(ch);
        }
    }
    push_term(&mut tokens, &mut current, &mut quoted, &mut source);
    tokens
}

fn push_term(
    tokens: &mut Vec<ChatFilterTerm>,
    current: &mut String,
    quoted: &mut bool,
    source: &mut String,
) {
    if current.is_empty() {
        source.clear();
    } else {
        tokens.push(ChatFilterTerm {
            text: std::mem::take(current),
            quoted: *quoted,
            source: std::mem::take(source),
        });
    }
    *quoted = false;
}

fn quote_filter_value(value: &str) -> String {
    if has_chat_filter_whitespace(value) {
        format!("\"{value}\"")
    } else {
        value.to_owned()
    }
}
