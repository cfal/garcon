//! Ports common/queue-state.ts.

use std::sync::LazyLock;

use garcon_js::trim;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::ws_value_parsing::{NonNegativeSafeInteger, non_negative_int};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueEntryKind {
    Turn,
    Steer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntryAttachment {
    pub name: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub id: String,
    pub content: String,
    pub kind: QueueEntryKind,
    pub attachments: Vec<QueueEntryAttachment>,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentlyDispatchedQueueEntry {
    pub entry_id: String,
    pub revision: u64,
    pub dispatched_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QueuePause {
    pub id: String,
    #[serde(flatten)]
    pub kind: QueuePauseKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum QueuePauseKind {
    Manual {
        paused_at: String,
    },
    QueuedTurnFailed {
        entry_id: String,
        paused_at: String,
    },
    TurnFailed {
        turn_id: String,
        paused_at: String,
    },
    CompletionUncertain {
        entry_id: String,
        paused_at: String,
    },
    Unknown {
        #[serde(skip_serializing_if = "Option::is_none")]
        entry_id: Option<String>,
        paused_at: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutomaticQueuePauseKind {
    QueuedTurnFailed,
    CompletionUncertain,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatQueueState {
    pub entries: Vec<QueueEntry>,
    pub steering_entry_id: Option<String>,
    pub recently_dispatched: Vec<RecentlyDispatchedQueueEntry>,
    pub pause: Option<QueuePause>,
    pub reorder_revision: NonNegativeSafeInteger,
}

pub const MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES: usize = 32;

pub fn empty_chat_queue_state() -> ChatQueueState {
    ChatQueueState {
        entries: Vec::new(),
        steering_entry_id: None,
        recently_dispatched: Vec::new(),
        pause: None,
        reorder_revision: NonNegativeSafeInteger::ZERO,
    }
}

fn nonempty(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn parse_queue_entry_attachment(value: &Value) -> Option<QueueEntryAttachment> {
    let item = value.as_object()?;
    let name = item.get("name")?.as_str()?.to_owned();
    let mime_type = nonempty(item.get("mimeType")?)?.to_owned();
    Some(QueueEntryAttachment { name, mime_type })
}

fn positive_revision(value: &Value) -> Option<u64> {
    non_negative_int(value)
        .map(NonNegativeSafeInteger::get)
        .filter(|value| *value > 0)
}

fn parse_queue_entry(value: &Value) -> Option<QueueEntry> {
    let item = value.as_object()?;
    let id = item
        .get("id")?
        .as_str()
        .map(trim)
        .filter(|id| !id.is_empty())?;
    let content = item.get("content")?.as_str()?;
    let kind = match item.get("kind")?.as_str()? {
        "turn" => QueueEntryKind::Turn,
        "steer" => QueueEntryKind::Steer,
        _ => return None,
    };
    let created_at = nonempty(item.get("createdAt")?)?;
    let revision = positive_revision(item.get("revision")?)?;
    let updated_at = nonempty(item.get("updatedAt")?)?;
    let attachments = item
        .get("attachments")?
        .as_array()?
        .iter()
        .map(parse_queue_entry_attachment)
        .collect::<Option<_>>()?;
    Some(QueueEntry {
        id: id.to_owned(),
        content: content.to_owned(),
        kind,
        attachments,
        revision,
        created_at: created_at.to_owned(),
        updated_at: updated_at.to_owned(),
    })
}

fn parse_recently_dispatched(value: &Value) -> Option<RecentlyDispatchedQueueEntry> {
    let item = value.as_object()?;
    Some(RecentlyDispatchedQueueEntry {
        entry_id: nonempty(item.get("entryId")?)?.to_owned(),
        revision: positive_revision(item.get("revision")?)?,
        dispatched_at: nonempty(item.get("dispatchedAt")?)?.to_owned(),
    })
}

static CANONICAL_ISO: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the literal pattern is valid.
    Regex::new(r"^([0-9]{4}|[+-][0-9]{6})-([0-9]{2})-([0-9]{2})T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$")
        .expect("canonical ISO pattern compiles")
});

// The round-trip check admits only real calendar days in ISO's exact UTC spelling.
pub(crate) fn canonical_iso_timestamp(value: &Value) -> Option<&str> {
    let text = value.as_str()?;
    let captures = CANONICAL_ISO.captures(text)?;
    let year_text = captures.get(1)?.as_str();
    let year: i32 = year_text.parse().ok()?;
    if (year_text.starts_with('+') && year < 10_000) || (year_text.starts_with('-') && year == 0) {
        return None;
    }
    let month: u8 = captures.get(2)?.as_str().parse().ok()?;
    let day: u8 = captures.get(3)?.as_str().parse().ok()?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if !(1..=month_days).contains(&day) {
        return None;
    }
    let in_range = match year {
        -271_821 => text >= "-271821-04-20T00:00:00.000Z",
        275_760 => text <= "+275760-09-13T00:00:00.000Z",
        other => (-271_821..275_760).contains(&other),
    };
    in_range.then_some(text)
}

/// Returns None for invalid or missing input, and Some(None) for an explicit null.
pub fn parse_queue_pause(value: Option<&Value>) -> Option<Option<QueuePause>> {
    let value = value?;
    if value.is_null() {
        return Some(None);
    }
    let raw = value.as_object()?;
    let id = raw
        .get("id")?
        .as_str()
        .map(trim)
        .filter(|id| !id.is_empty())?;
    let kind = raw.get("kind")?.as_str()?;
    let paused_at = raw.get("pausedAt")?;
    let kind = if kind == "unknown" {
        let paused_at = if paused_at.is_null() {
            None
        } else {
            Some(canonical_iso_timestamp(paused_at)?.to_owned())
        };
        QueuePauseKind::Unknown {
            entry_id: raw.get("entryId").and_then(nonempty).map(str::to_owned),
            paused_at,
        }
    } else {
        let paused_at = canonical_iso_timestamp(paused_at)?.to_owned();
        let entry_id = || {
            raw.get("entryId")?
                .as_str()
                .map(trim)
                .filter(|entry_id| !entry_id.is_empty())
                .map(str::to_owned)
        };
        match kind {
            "manual" => QueuePauseKind::Manual { paused_at },
            "turn-failed" => QueuePauseKind::TurnFailed {
                turn_id: nonempty(raw.get("turnId")?)?.to_owned(),
                paused_at,
            },
            "queued-turn-failed" => QueuePauseKind::QueuedTurnFailed {
                entry_id: entry_id()?,
                paused_at,
            },
            "completion-uncertain" => QueuePauseKind::CompletionUncertain {
                entry_id: entry_id()?,
                paused_at,
            },
            _ => return None,
        }
    };
    Some(Some(QueuePause {
        id: id.to_owned(),
        kind,
    }))
}

pub fn parse_chat_queue_state(value: &Value) -> Option<ChatQueueState> {
    let raw = value.as_object()?;
    let pause = parse_queue_pause(raw.get("pause"))?;
    let entries = raw.get("entries")?.as_array()?;
    let recently_dispatched = raw.get("recentlyDispatched")?.as_array()?;
    let reorder_revision = non_negative_int(raw.get("reorderRevision")?)?;
    let entries = entries
        .iter()
        .map(parse_queue_entry)
        .collect::<Option<_>>()?;
    let mut recently_dispatched = recently_dispatched
        .iter()
        .map(parse_recently_dispatched)
        .collect::<Option<Vec<_>>>()?;
    let steering_entry_id = match raw.get("steeringEntryId")? {
        Value::Null => None,
        Value::String(id) if !trim(id).is_empty() => Some(id.clone()),
        _ => return None,
    };
    let excess = recently_dispatched
        .len()
        .saturating_sub(MAX_RECENTLY_DISPATCHED_QUEUE_ENTRIES);
    drop(recently_dispatched.drain(..excess));
    Some(ChatQueueState {
        entries,
        steering_entry_id,
        recently_dispatched,
        pause,
        reorder_revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn baseline() -> Value {
        json!({"entries":[],"steeringEntryId":null,"recentlyDispatched":[],"pause":null,"reorderRevision":0})
    }

    #[test]
    fn initializes_a_zero_reorder_revision() {
        let queue = empty_chat_queue_state();
        assert_eq!(queue.reorder_revision.get(), 0);
        assert_eq!(queue.steering_entry_id, None);
        assert_eq!(json!(queue), baseline());
    }

    #[test]
    fn requires_an_explicit_steering_entry_identity() {
        let mut queue = baseline();
        queue["steeringEntryId"] = json!(" entry-1 ");
        assert_eq!(
            parse_chat_queue_state(&queue)
                .unwrap()
                .steering_entry_id
                .as_deref(),
            Some(" entry-1 ")
        );
        queue["steeringEntryId"] = json!("");
        assert_eq!(parse_chat_queue_state(&queue), None);
        queue.as_object_mut().unwrap().remove("steeringEntryId");
        assert_eq!(parse_chat_queue_state(&queue), None);
    }

    #[test]
    fn parses_non_negative_safe_reorder_revisions() {
        for revision in [0, 42, 9_007_199_254_740_991_u64] {
            let mut queue = baseline();
            queue["reorderRevision"] = json!(revision);
            assert_eq!(
                parse_chat_queue_state(&queue)
                    .unwrap()
                    .reorder_revision
                    .get(),
                revision
            );
        }
    }

    #[test]
    fn rejects_missing_and_malformed_reorder_revisions() {
        let mut queue = baseline();
        for rejected in [json!(-1), json!(1.5), json!(9_007_199_254_740_992_u64)] {
            queue["reorderRevision"] = rejected;
            assert_eq!(parse_chat_queue_state(&queue), None);
        }
        queue.as_object_mut().unwrap().remove("reorderRevision");
        assert_eq!(parse_chat_queue_state(&queue), None);
    }

    #[test]
    fn requires_each_entry_to_say_whether_it_starts_a_turn_or_steers_the_active_one() {
        let mut queue = baseline();
        let entry = |kind| {
            json!({
                "id": "entry", "content": "guidance", "kind": kind, "attachments": [], "revision": 1,
                "createdAt": "2026-07-22T00:00:00.000Z", "updatedAt": "2026-07-22T00:00:00.000Z"
            })
        };
        queue["entries"] = json!([entry("turn"), entry("steer")]);
        let queue_kinds: Vec<_> = parse_chat_queue_state(&queue)
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| entry.kind)
            .collect();
        assert_eq!(queue_kinds, [QueueEntryKind::Turn, QueueEntryKind::Steer]);
        queue["entries"] = json!([entry("later")]);
        assert_eq!(parse_chat_queue_state(&queue), None);
        queue["entries"][0].as_object_mut().unwrap().remove("kind");
        assert_eq!(parse_chat_queue_state(&queue), None);
    }

    #[test]
    fn requires_dispatched_markers_to_retain_the_dispatched_content_revision() {
        let mut queue = baseline();
        queue["recentlyDispatched"] = json!([{ "entryId": "entry-1", "revision": 3, "dispatchedAt": "2026-07-22T00:00:00.000Z" }]);
        assert_eq!(
            json!(parse_chat_queue_state(&queue).unwrap().recently_dispatched),
            queue["recentlyDispatched"]
        );
        queue["recentlyDispatched"][0]
            .as_object_mut()
            .unwrap()
            .remove("revision");
        assert_eq!(parse_chat_queue_state(&queue), None);
    }

    #[test]
    fn keeps_only_the_latest_dispatched_markers_after_validation() {
        let mut queue = baseline();
        queue["recentlyDispatched"] = Value::Array((1..=33)
            .map(|revision| json!({"entryId": "entry", "revision": revision, "dispatchedAt": "timestamp"})).collect());
        let parsed = parse_chat_queue_state(&queue).unwrap();
        assert_eq!(parsed.recently_dispatched.len(), 32);
        assert_eq!(parsed.recently_dispatched[0].revision, 2);
        queue["recentlyDispatched"][0]["revision"] = json!(0);
        assert_eq!(parse_chat_queue_state(&queue), None);
    }
}
