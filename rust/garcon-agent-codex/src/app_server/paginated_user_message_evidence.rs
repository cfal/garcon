use std::collections::HashSet;

use futures::TryStreamExt;
use garcon_agents_common::{
    jsonl::{JsonlLineResult, parse_first_jsonl_value},
    shared::history_loader_utils::{JsonlLineReadOptions, read_jsonl_line_entries},
};
use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::chat_types::ChatMessage;
use garcon_interface::{
    native_message_source::{
        NativeMessageSourceInput, NativeSourced, attach_native_message_source,
    },
    resources::ExecutorResult,
};
use garcon_js::{date_parse::date_parse, json::as_number, to_iso_string, trim};
use indexmap::{IndexMap, IndexSet};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::converter::convert_codex_app_server_item;

#[derive(Default)]
pub struct CodexPaginatedItemEvidence {
    pub messages: Vec<NativeSourced<ChatMessage>>,
    pub ordered_item_ids_by_turn: IndexMap<String, IndexSet<String>>,
}

pub async fn load_paginated_user_message_evidence(
    native_path: &str,
    fallback_timestamp: &str,
    signal: &CancellationToken,
    surviving_turn_ids: &HashSet<&str>,
) -> ExecutorResult<CodexPaginatedItemEvidence> {
    let mut evidence = CodexPaginatedItemEvidence::default();
    let mut steps = EventLoopSteps::new("codex-paginated-history");
    let options = JsonlLineReadOptions {
        signal: Some(signal.clone()),
        ..Default::default()
    };
    let mut lines = read_jsonl_line_entries(native_path, options);
    while let Some(entry) = lines.try_next().await? {
        if steps.due() {
            steps.next().await;
        }
        let JsonlLineResult::Value { value, .. } = parse_first_jsonl_value(&entry.line) else {
            continue;
        };
        let payload = &value["payload"];
        if value["type"] != "event_msg" || payload["type"] != "item_completed" {
            continue;
        }
        let Some(turn_id) = nonempty(&payload["turn_id"])
            .or_else(|| nonempty(&payload["turnId"]))
            .filter(|turn_id| surviving_turn_ids.contains(turn_id))
        else {
            continue;
        };
        let item = &payload["item"];
        let Some(id) = nonempty(&item["id"]) else {
            continue;
        };
        if !evidence
            .ordered_item_ids_by_turn
            .entry(turn_id.into())
            .or_default()
            .insert(id.into())
        {
            continue;
        }
        if !matches!(item["type"].as_str(), Some("UserMessage" | "userMessage"))
            || !item["content"].is_array()
        {
            continue;
        }
        let Some(client_id) = nonempty(&item["client_id"]).or_else(|| nonempty(&item["clientId"]))
        else {
            continue;
        };
        let timestamp = evidence_timestamp(
            &payload["completed_at_ms"],
            &value["timestamp"],
            fallback_timestamp,
        );
        let row =
            json!({"type":"userMessage","id":id,"clientId":client_id,"content":item["content"]});
        let entry_id = format!("turn:{turn_id}:item:{id}");
        evidence.messages.extend(
            convert_codex_app_server_item(&row, &timestamp)
                .into_iter()
                .enumerate()
                .map(|(ordinal, message)| {
                    let mut row = NativeSourced::new(message);
                    attach_native_message_source(
                        &mut row,
                        Some(NativeMessageSourceInput {
                            entry_id: Some(&entry_id),
                            byte_offset: Some(entry.byte_offset as f64),
                            line_number: entry.line_number.map(|line| line as f64),
                            within_source_ordinal: Some(ordinal as f64),
                        }),
                    );
                    row
                }),
        );
    }
    Ok(evidence)
}

fn nonempty(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !trim(text).is_empty())
}

fn evidence_timestamp(completed_at: &Value, rollout: &Value, fallback: &str) -> String {
    as_number(completed_at)
        .filter(|ms| *ms > 0.0 && *ms <= 8.64e15)
        .and_then(|ms| to_iso_string(ms as i64).ok())
        .or_else(|| {
            rollout
                .as_str()
                .filter(|at| date_parse(at).is_some())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| fallback.to_owned())
}
