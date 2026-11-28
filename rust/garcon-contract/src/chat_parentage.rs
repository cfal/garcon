//! Ports `common/chat-parentage.ts`.

use garcon_js::is_safe_integer;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_id::{ChatId, parse_chat_id};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatLineageKind {
    Fork,
    Handoff,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatLineage {
    pub source_chat_id: ChatId,
    pub kind: ChatLineageKind,
    pub transcript_view_id: String,
    pub ordinal: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRelationships {
    pub parent_chat_id: Option<ChatId>,
    pub lineage: Option<ChatLineage>,
}

pub fn chat_lineages_equal(left: Option<&ChatLineage>, right: Option<&ChatLineage>) -> bool {
    left == right
}

pub fn parse_chat_lineage(value: &Value) -> Option<ChatLineage> {
    let raw = value.as_object()?;
    if !raw.keys().all(|key| {
        matches!(
            key.as_str(),
            "sourceChatId" | "kind" | "transcriptViewId" | "ordinal"
        )
    }) {
        return None;
    }
    let source_chat_id = parse_chat_id(raw.get("sourceChatId")?).ok()?;
    let kind = match raw.get("kind")?.as_str()? {
        "fork" => ChatLineageKind::Fork,
        "handoff" => ChatLineageKind::Handoff,
        _ => return None,
    };
    let transcript_view_id = raw.get("transcriptViewId")?.as_str()?;
    if transcript_view_id.is_empty() {
        return None;
    }
    let ordinal = raw.get("ordinal")?.as_f64()?;
    if !is_safe_integer(ordinal) || ordinal < 0.0 {
        return None;
    }
    Some(ChatLineage {
        source_chat_id,
        kind,
        transcript_view_id: transcript_view_id.into(),
        ordinal: ordinal as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compares_identity_kind_and_the_complete_watermark_with_nullable_values() {
        let raw = json!({"sourceChatId":"1783725900000200","kind":"fork","transcriptViewId":"source-view","ordinal":1});
        let lineage = parse_chat_lineage(&raw);
        assert!(chat_lineages_equal(None, None));
        assert!(chat_lineages_equal(
            lineage.as_ref(),
            lineage.clone().as_ref()
        ));
        for (key, change) in [
            ("sourceChatId", json!("1783725900000201")),
            ("kind", json!("handoff")),
            ("transcriptViewId", json!("other-view")),
            ("ordinal", json!(2)),
        ] {
            let mut changed = raw.clone();
            changed[key] = change;
            assert!(!chat_lineages_equal(
                lineage.as_ref(),
                parse_chat_lineage(&changed).as_ref()
            ));
        }
    }

    #[test]
    fn rejects_incomplete_mixed_legacy_and_malformed_references() {
        let raw = json!({"sourceChatId":"1783725900000200","kind":"fork","transcriptViewId":"source-view","ordinal":1});
        assert!(parse_chat_lineage(&raw).is_some());
        for (key, invalid) in [
            ("sourceChatId", json!("invalid")),
            ("kind", json!("merge")),
            ("transcriptViewId", json!("")),
            ("ordinal", json!(-1)),
            ("ordinal", json!(1.5)),
            ("ordinal", json!(9_007_199_254_740_992u64)),
            ("extra", json!(true)),
        ] {
            let mut changed = raw.clone();
            changed[key] = invalid;
            assert_eq!(parse_chat_lineage(&changed), None);
        }
    }
}
