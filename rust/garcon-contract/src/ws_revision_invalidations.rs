//! Ports common/ws-revision-invalidations.ts.

use serde::Serialize;
use serde_json::Value;

use crate::ws_value_parsing::non_negative_int;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RevisionInvalidationType {
    TicketsInvalidated,
    PullRequestReviewsInvalidated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TicketsInvalidatedMessage {
    pub revision: u64,
    #[serde(rename = "type")]
    message_type: RevisionInvalidationType,
}

impl TicketsInvalidatedMessage {
    pub fn new(revision: u64) -> Self {
        Self {
            revision,
            message_type: RevisionInvalidationType::TicketsInvalidated,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PullRequestReviewsInvalidatedMessage {
    pub revision: u64,
    #[serde(rename = "type")]
    message_type: RevisionInvalidationType,
}

impl PullRequestReviewsInvalidatedMessage {
    pub fn new(revision: u64) -> Self {
        Self {
            revision,
            message_type: RevisionInvalidationType::PullRequestReviewsInvalidated,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RevisionInvalidationMessage {
    TicketsInvalidated(TicketsInvalidatedMessage),
    PullRequestReviewsInvalidated(PullRequestReviewsInvalidatedMessage),
}

pub fn is_revision_invalidation_type(value: &Value) -> Option<RevisionInvalidationType> {
    match value.as_str()? {
        "tickets-invalidated" => Some(RevisionInvalidationType::TicketsInvalidated),
        "pull-request-reviews-invalidated" => {
            Some(RevisionInvalidationType::PullRequestReviewsInvalidated)
        }
        _ => None,
    }
}

pub fn parse_revision_invalidation(value: &Value) -> Option<RevisionInvalidationMessage> {
    let record = value.as_object()?;
    let message_type = is_revision_invalidation_type(record.get("type")?)?;
    if record.len() != 2 {
        return None;
    }
    let revision = non_negative_int(record.get("revision")?)?;
    Some(match message_type {
        RevisionInvalidationType::TicketsInvalidated => {
            RevisionInvalidationMessage::TicketsInvalidated(TicketsInvalidatedMessage::new(
                revision,
            ))
        }
        RevisionInvalidationType::PullRequestReviewsInvalidated => {
            RevisionInvalidationMessage::PullRequestReviewsInvalidated(
                PullRequestReviewsInvalidatedMessage::new(revision),
            )
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_both_invalidations_with_only_the_revision() {
        for kind in ["tickets-invalidated", "pull-request-reviews-invalidated"] {
            let valid = json!({"type":kind,"revision":3});
            assert_eq!(json!(parse_revision_invalidation(&valid)), valid);
            for invalid in [
                json!({"type":kind,"revision":3,"extra":true}),
                json!({"type":kind}),
                json!({"type":kind,"revision":-1}),
                json!({"type":kind,"revision":1.5}),
                json!({"type":kind,"revision":"3"}),
                json!({"type":kind,"revision":9_007_199_254_740_992_u64}),
            ] {
                assert_eq!(parse_revision_invalidation(&invalid), None);
            }
        }
    }
}
