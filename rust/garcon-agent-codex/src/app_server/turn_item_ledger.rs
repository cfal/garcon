use std::collections::HashSet;

use garcon_contract::chat_types::{ChatMessage, CompactionTrigger};
use garcon_interface::native_message_source::{NativeSourced, attach_native_message_source};
use garcon_js::Number;

use crate::message_source_identity::{codex_message_source_identity, message_tool_id};

use super::protocol::{CodexThreadItem, CodexThreadItemType};

#[derive(Default)]
pub struct CodexTurnItemLedger {
    seen_ids: HashSet<String>,
    manual_compaction_pending: bool,
}

impl CodexTurnItemLedger {
    pub fn mark_manual_compaction(&mut self) {
        self.manual_compaction_pending = true;
    }

    pub fn emit(
        &mut self,
        turn_id: &str,
        item: &CodexThreadItem,
        convert: impl FnOnce(&CodexThreadItem, Option<CompactionTrigger>) -> Vec<ChatMessage>,
    ) -> Vec<NativeSourced<ChatMessage>> {
        if !self.seen_ids.insert(item.id.clone()) {
            return Vec::new();
        }
        let trigger = (item.kind == CodexThreadItemType::ContextCompaction).then(|| {
            if std::mem::take(&mut self.manual_compaction_pending) {
                CompactionTrigger::Manual
            } else {
                CompactionTrigger::Auto
            }
        });
        emit_with_source(turn_id, Some(&item.id), convert(item, trigger))
    }

    pub fn emit_converted(
        &mut self,
        turn_id: &str,
        item_id: Option<&str>,
        messages: Vec<ChatMessage>,
    ) -> Vec<NativeSourced<ChatMessage>> {
        for tool_id in messages
            .iter()
            .filter_map(message_tool_id)
            .filter(|id| !id.is_empty())
        {
            self.seen_ids.insert(tool_id.into());
        }
        emit_with_source(turn_id, item_id, messages)
    }
}

fn emit_with_source(
    turn_id: &str,
    item_id: Option<&str>,
    messages: Vec<ChatMessage>,
) -> Vec<NativeSourced<ChatMessage>> {
    messages
        .into_iter()
        .enumerate()
        .map(|(ordinal, message)| {
            let identity = codex_message_source_identity(
                Some(turn_id),
                item_id,
                &message,
                Number(ordinal as f64),
            );
            let mut row = NativeSourced::new(message);
            attach_native_message_source(
                &mut row,
                identity.as_ref().map(|identity| identity.as_source_input()),
            );
            row
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use garcon_contract::chat_types::{AssistantMessage, ToolResultMessage, ToolUseChatMessage};
    use garcon_interface::native_message_source::get_native_message_revision_source;
    use garcon_js::json::Opaque;
    use serde_json::json;

    use super::*;
    use crate::app_server::protocol::parse_codex_thread_item;

    #[test]
    fn names_the_turn_on_live_item_output() {
        let item = parse_codex_thread_item(
            &json!({"id":"item-1","type":"agentMessage","text":"hello"}),
            "item",
        )
        .unwrap();
        let mut ledger = CodexTurnItemLedger::default();
        let rows = ledger.emit("turn-1", &item, |input, trigger| {
            assert_eq!(trigger, None);
            vec![ChatMessage::Assistant(AssistantMessage {
                timestamp: "at".into(),
                content: input.payload()["text"].as_str().unwrap().into(),
                questions: None,
            })]
        });
        assert_eq!(rows.len(), 1);
        let source = get_native_message_revision_source(&rows[0]).unwrap();
        assert_eq!(source.entry_id.as_deref(), Some("turn:turn-1:item:item-1"));
        assert_eq!(source.within_source_ordinal, Some(0));
        assert!(
            ledger
                .emit("turn-1", &item, |_, _| panic!("duplicate item"))
                .is_empty()
        );
    }

    #[test]
    fn manually_requested_compaction_labels_only_the_next_new_compaction_item() {
        let mut ledger = CodexTurnItemLedger::default();
        let compact = |id| {
            parse_codex_thread_item(&json!({"id":id,"type":"contextCompaction"}), "item").unwrap()
        };
        let first = compact("first");
        ledger.mark_manual_compaction();
        ledger.emit("turn", &first, |_, trigger| {
            assert_eq!(trigger, Some(CompactionTrigger::Manual));
            Vec::new()
        });
        ledger.emit("turn", &first, |_, _| panic!("duplicate compaction"));
        ledger.emit("turn", &compact("second"), |_, trigger| {
            assert_eq!(trigger, Some(CompactionTrigger::Auto));
            Vec::new()
        });
    }

    #[test]
    fn tool_result_and_call_use_distinct_slots_on_the_same_turn_source() {
        let mut ledger = CodexTurnItemLedger::default();
        let messages = vec![
            ChatMessage::ToolUse(ToolUseChatMessage::Bash {
                timestamp: "at".into(),
                tool_id: "tool".into(),
                command: "pwd".into(),
                description: None,
            }),
            ChatMessage::ToolResult(ToolResultMessage::new(
                "at".into(),
                "tool".into(),
                Opaque::from_value(json!("synthetic")),
                false,
                None,
            )),
        ];
        let rows = ledger.emit_converted("turn", Some("unused-item"), messages);
        let sources: Vec<_> = rows
            .iter()
            .map(|row| get_native_message_revision_source(row).unwrap())
            .collect();
        assert_eq!(sources[0].entry_id.as_deref(), Some("turn:turn:tool:tool"));
        assert_eq!(sources[1].entry_id, sources[0].entry_id);
        assert_eq!(sources[0].within_source_ordinal, Some(0));
        assert_eq!(sources[1].within_source_ordinal, Some(1));
    }
}
