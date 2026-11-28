//! Ports `server-agents/pi/src/agents/pi/history-loader.ts`.

use futures::TryStreamExt;
use garcon_agents_common::shared::history_loader_utils::{
    JsonlLineReadOptions, read_jsonl_line_entries,
};
use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::chat_types::ChatMessage;
use garcon_interface::{
    native_message_source::{
        NativeMessageSourceInput, NativeSourced, attach_native_message_source,
    },
    resources::ExecutorResult,
};
use garcon_js::{SystemClock, json::from_str};
use serde_json::Value;

use crate::{
    message_converter::{ConvertPiMessageOptions, convert_pi_message},
    session_projection::{is_pi_session_entry, project_pi_history},
};

pub async fn load_pi_chat_messages(
    session_path: &str,
) -> ExecutorResult<Vec<NativeSourced<ChatMessage>>> {
    let mut steps = EventLoopSteps::new("pi-history-load");
    let mut entries = Vec::new();
    let mut lines = read_jsonl_line_entries(session_path, JsonlLineReadOptions::default());
    while let Some(line) = lines.try_next().await? {
        let entry =
            parse_strict_pi_session_entry(&line.line, line.line_number.unwrap_or_default())?;
        if entry["type"] != "session" {
            entries.push(entry);
        }
        steps.next().await;
    }

    let projection = project_pi_history(&entries, &mut steps).await?;
    let mut messages = Vec::new();
    // Context edits retain their target's source identity, not the editing entry's identity.
    steps
        .try_for_each(projection, |projected| {
            let id = projected.source_entry["id"]
                .as_str()
                .filter(|id| !id.is_empty());
            let mut ordinal = 0;
            for raw in projected.messages {
                for message in
                    convert_pi_message(&raw, ConvertPiMessageOptions::default(), &SystemClock)?
                {
                    let mut message = NativeSourced::new(message);
                    if let Some(entry_id) = id {
                        attach_native_message_source(
                            &mut message,
                            Some(NativeMessageSourceInput {
                                entry_id: Some(entry_id),
                                within_source_ordinal: Some(ordinal as f64),
                                ..Default::default()
                            }),
                        );
                    }
                    messages.push(message);
                    ordinal += 1;
                }
            }
            Ok::<_, Box<dyn std::error::Error>>(())
        })
        .await?;
    Ok(messages)
}

fn parse_strict_pi_session_entry(line: &str, line_number: u64) -> ExecutorResult<Value> {
    match from_str(line) {
        Ok(value) if is_pi_session_entry(&value) => Ok(value),
        _ => Err(format!("Pi transcript record {line_number} is invalid").into()),
    }
}
