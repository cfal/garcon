use garcon_interface::producer::AgentFinalResponse;

use garcon_js::json::Opaque;
use serde_json::Value;

use crate::app_server::protocol::{CodexThreadItem, CodexThreadItemType, CodexTurnStatus};

pub struct CodexCompletedTurn {
    pub id: String,
    pub items: Vec<CodexThreadItem>,
    pub status: Option<CodexTurnStatus>,
    pub error: Option<Opaque>,
}

pub fn final_response(turn: &CodexCompletedTurn) -> Option<AgentFinalResponse> {
    if turn.status != Some(CodexTurnStatus::Completed) {
        return None;
    }
    let message = turn.items.iter().rev().find(|item| {
        let payload = item.payload();
        item.kind == CodexThreadItemType::AgentMessage
            && payload["delivery"] != "async"
            && (payload["phase"].is_null() || payload["phase"] == "final_answer")
    })?;
    let text = message.payload()["text"].as_str()?;
    Some(AgentFinalResponse::Text { text: text.into() })
}

pub fn detached_turn_failure(turn: &CodexCompletedTurn) -> Option<&str> {
    let error = turn.error.as_deref();
    if turn.status == Some(CodexTurnStatus::Failed)
        || (turn.status == Some(CodexTurnStatus::Interrupted) && error.is_some())
    {
        return Some(
            error
                .and_then(|error| error["message"].as_str())
                .unwrap_or("Codex turn failed"),
        );
    }
    None
}

impl CodexCompletedTurn {
    pub(super) fn read(turn_id: &str, turn: &Value) -> Self {
        let status = match turn["status"].as_str() {
            Some("completed") => Some(CodexTurnStatus::Completed),
            Some("failed") => Some(CodexTurnStatus::Failed),
            Some("interrupted") => Some(CodexTurnStatus::Interrupted),
            Some("inProgress") => Some(CodexTurnStatus::InProgress),
            _ => None,
        };
        Self {
            id: turn_id.into(),
            items: turn["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(crate::app_server::protocol::read_live_thread_item)
                .collect(),
            status,
            error: turn
                .get("error")
                .filter(|error| !error.is_null())
                .map(|error| Opaque::from_value(error.clone())),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::app_server::protocol::parse_codex_thread_item;

    use super::*;

    fn turn(status: CodexTurnStatus, items: &[Value], error: Option<Value>) -> CodexCompletedTurn {
        CodexCompletedTurn {
            id: "turn-1".into(),
            items: items
                .iter()
                .map(|item| parse_codex_thread_item(item, "test item").unwrap())
                .collect(),
            status: Some(status),
            error: error.map(Opaque::from_value),
        }
    }

    #[test]
    fn selects_only_a_completed_final_response_without_trimming() {
        let item = |id, phase: Value, text, delivery: Option<&str>| {
            let mut item = json!({"type":"agentMessage","id":id,"text":text,"phase":phase});
            if let Some(delivery) = delivery {
                item["delivery"] = json!(delivery);
            }
            item
        };
        let final_text = "Final A.\n\nFinal B.\r";
        let items = [
            item("early", json!(null), "earlier", None),
            item("final", json!("final_answer"), final_text, None),
            item("progress", json!("commentary"), "progress", None),
            item("draft", json!("partial_answer"), "draft", None),
            item("question", json!(null), "question", Some("async")),
        ];
        let selected = final_response(&turn(CodexTurnStatus::Completed, &items, None));
        assert_eq!(
            selected,
            Some(AgentFinalResponse::Text {
                text: final_text.into()
            })
        );
        assert_eq!(
            final_response(&turn(CodexTurnStatus::Completed, &items[2..], None)),
            None
        );
        assert_eq!(
            final_response(&turn(CodexTurnStatus::Failed, &items, None)),
            None
        );
        assert_eq!(
            final_response(&turn(CodexTurnStatus::Interrupted, &items, None)),
            None
        );
        assert_eq!(
            final_response(&turn(
                CodexTurnStatus::Completed,
                &[item("empty", json!(null), "", None)],
                None,
            )),
            Some(AgentFinalResponse::Text { text: "".into() })
        );
    }

    #[test]
    fn treats_detached_interruptions_as_failed_only_when_they_carry_errors() {
        let error = json!({"message":"synthetic failure"});
        assert_eq!(
            detached_turn_failure(&turn(CodexTurnStatus::Interrupted, &[], Some(error))),
            Some("synthetic failure")
        );
        assert_eq!(
            detached_turn_failure(&turn(CodexTurnStatus::Interrupted, &[], None)),
            None
        );
        assert_eq!(
            detached_turn_failure(&turn(CodexTurnStatus::Failed, &[], None)),
            Some("Codex turn failed")
        );
    }
}
