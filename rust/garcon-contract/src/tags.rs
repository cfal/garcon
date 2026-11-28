//! Ports `common/tags.ts`.

use std::borrow::Cow;

use garcon_js::trim;
use indexmap::IndexSet;
use serde_json::Value;

pub fn normalize_tag_slug(raw: &str) -> String {
    let lower = trim(raw).to_lowercase();
    let mut slug = String::new();
    let mut separator = false;
    let mut utf8 = [0; 4];
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            separator = false;
            slug.push(ch);
        } else if ch == '-' || trim(ch.encode_utf8(&mut utf8)).is_empty() {
            separator = true;
        }
    }
    slug
}

pub fn append_normalized_unique_tag<'a>(tags: &'a [String], raw_tag: &str) -> Cow<'a, [String]> {
    let normalized = normalize_tag_slug(raw_tag);
    if normalized.is_empty() || tags.iter().any(|tag| tag.to_lowercase() == normalized) {
        return Cow::Borrowed(tags);
    }
    let mut tags = tags.to_owned();
    tags.push(normalized);
    Cow::Owned(tags)
}

pub fn finalize_normalized_tags<'a>(tags: &'a [String], pending_tag: &str) -> Cow<'a, [String]> {
    append_normalized_unique_tag(tags, pending_tag)
}

pub fn normalize_tags(raw: &[Value]) -> Vec<String> {
    let seen: IndexSet<_> = raw
        .iter()
        .filter_map(Value::as_str)
        .map(normalize_tag_slug)
        .filter(|tag| !tag.is_empty())
        .collect();
    let mut normalized: Vec<_> = seen.into_iter().collect();
    normalized.sort();
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_whitespace_case_and_non_ascii_characters() {
        assert_eq!(
            normalize_tag_slug("\u{feff} A\u{a0}--Road! Map \u{212a} \u{130}\u{feff}"),
            "a-road-map-k-i"
        );
        assert_eq!(normalize_tag_slug("a\u{85}b"), "ab");
        assert_eq!(normalize_tag_slug(" ---!? "), "");
    }

    #[test]
    fn appends_only_new_slugs_and_normalizes_bulk_input() {
        let tags = ["DUP".to_owned()];
        assert!(matches!(
            append_normalized_unique_tag(&tags, " DuP "),
            Cow::Borrowed(_)
        ));
        assert_eq!(
            finalize_normalized_tags(&tags, " New tag ").as_ref(),
            ["DUP", "new-tag"]
        );
        assert_eq!(
            normalize_tags(&[
                json!(" B b "),
                json!(false),
                json!("a"),
                json!("b-b"),
                json!("??")
            ]),
            ["a", "b-b"]
        );
    }
}
