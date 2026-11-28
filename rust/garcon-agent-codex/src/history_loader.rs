use std::cmp::Ordering;

use futures::TryStreamExt;
use garcon_agents_common::{
    jsonl::{JsonlLineResult, parse_first_jsonl_value},
    shared::history_loader_utils::{JsonlLineReadOptions, read_jsonl_line_entries},
};
use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::chat_types::ChatMessage;
use garcon_interface::{
    host::AgentLogger,
    native_message_source::{
        NativeMessageSourceInput, NativeSourced, attach_native_message_source,
        get_native_message_revision_source,
    },
    resources::ExecutorResult,
};
use garcon_js::{Number, json::Opaque, trim};
use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    history_normalizer::CodexJsonlNormalizationContext, history_profile::check_aborted,
    legacy_history_projection::LegacyCodexProjection,
    message_source_identity::codex_message_source_identity,
};

#[derive(Default)]
pub struct CodexMessageBuckets {
    canonical: Vec<NativeSourced<ChatMessage>>,
    fallback_user: Vec<NativeSourced<ChatMessage>>,
    fallback_assistant: Vec<NativeSourced<ChatMessage>>,
    fallback_thinking: Vec<NativeSourced<ChatMessage>>,
    has_canonical_user: bool,
    has_canonical_assistant: bool,
    has_canonical_thinking: bool,
}

pub fn add_codex_jsonl_line(
    buckets: &mut CodexMessageBuckets,
    line: &str,
    context: &CodexJsonlNormalizationContext,
    projection: &mut LegacyCodexProjection,
    strict: bool,
) -> ExecutorResult<()> {
    let entry = match parse_first_jsonl_value(line) {
        JsonlLineResult::Value {
            value,
            discarded_suffix,
            ..
        } => {
            if strict && (discarded_suffix || !value.is_object()) {
                return Err("Codex transcript record is invalid".into());
            }
            value
        }
        JsonlLineResult::Empty => return Ok(()),
        _ if strict => return Err("Codex transcript record is invalid".into()),
        _ => return Ok(()),
    };
    if strict {
        assert_importable(&entry)?;
    }
    let result = match projection.project(&entry, context) {
        Ok(Some(result)) => result,
        Ok(None) => return Ok(()),
        Err(error) if strict => return Err(error.into()),
        Err(_) => return Ok(()),
    };
    let payload = if entry["type"] == "response_item" {
        &entry["payload"]
    } else {
        &Value::Null
    };
    let turn_id = payload["internal_chat_message_metadata_passthrough"]["turn_id"]
        .as_str()
        .map(trim);
    let item_id = payload["id"].as_str().map(trim);
    let mut ordinal = 0.0;
    for (target, messages) in [
        (&mut buckets.canonical, result.canonical),
        (&mut buckets.fallback_user, result.fallback_user),
        (&mut buckets.fallback_assistant, result.fallback_assistant),
        (&mut buckets.fallback_thinking, result.fallback_thinking),
    ] {
        for message in messages {
            let identity =
                codex_message_source_identity(turn_id, item_id, &message, Number(ordinal));
            let mut source = identity
                .as_ref()
                .map_or_else(NativeMessageSourceInput::default, |identity| {
                    identity.as_source_input()
                });
            source.byte_offset = context.source_byte_offset;
            source.line_number = context.source_line_number;
            source.within_source_ordinal = source.within_source_ordinal.or(Some(ordinal));
            let mut row = NativeSourced::new(message);
            attach_native_message_source(&mut row, Some(source));
            target.push(row);
            ordinal += 1.0;
        }
    }
    buckets.has_canonical_user |= result.is_canonical_user;
    buckets.has_canonical_assistant |= result.is_canonical_assistant;
    buckets.has_canonical_thinking |= result.is_canonical_thinking;
    Ok(())
}

fn assert_importable(entry: &Value) -> ExecutorResult<()> {
    if entry["type"] != "response_item" {
        return Ok(());
    }
    let payload = &entry["payload"];
    if !payload.is_object() {
        return Err("Codex response item is invalid".into());
    }
    if payload["type"] != "message" {
        return Ok(());
    }
    let Some(parts) = payload["content"].as_array().filter(|_| {
        matches!(
            payload["role"].as_str(),
            Some("user" | "assistant" | "developer")
        )
    }) else {
        return Err("Codex response message is invalid".into());
    };
    for part in parts {
        let Some(kind) = part["type"].as_str().filter(|kind| !kind.is_empty()) else {
            return Err("Codex response message part is invalid".into());
        };
        if matches!(kind, "input_text" | "output_text" | "text") && !part["text"].is_string() {
            return Err("Codex response message part is invalid".into());
        }
    }
    Ok(())
}

pub async fn sort_codex_messages_by_source(
    messages: Vec<NativeSourced<ChatMessage>>,
    steps: &mut EventLoopSteps,
) -> Vec<NativeSourced<ChatMessage>> {
    let mut rows = Vec::with_capacity(messages.len());
    for (index, message) in messages.into_iter().enumerate() {
        let source = get_native_message_revision_source(&message);
        rows.push((index, source, message));
        if steps.due() {
            steps.next().await;
        }
    }
    rows.sort_by(|(left_index, left, _), (right_index, right, _)| {
        let byte_offset_order = left.as_ref().and_then(|left| left.byte_offset)
            .zip(right.as_ref().and_then(|right| right.byte_offset))
            .map(|(left, right)| left.cmp(&right));
        let position = byte_offset_order.unwrap_or_else(|| {
            left.as_ref().and_then(|left| left.line_number)
                .zip(right.as_ref().and_then(|right| right.line_number))
                .map_or(Ordering::Equal, |(left, right)| left.0.total_cmp(&right.0))
        });
        position.then_with(|| {
            let ordinal = |source: &Option<_>| source.as_ref()
                .and_then(|source: &garcon_interface::native_message_source::NativeMessageSource| source.within_source_ordinal)
                .unwrap_or_default();
            ordinal(left).cmp(&ordinal(right))
        }).then_with(|| left_index.cmp(right_index))
    });
    let mut sorted = Vec::with_capacity(rows.len());
    for (_, _, message) in rows {
        sorted.push(message);
        if steps.due() {
            steps.next().await;
        }
    }
    sorted
}

pub async fn load_codex_chat_messages(
    native_path: Option<&str>,
    logger: &dyn AgentLogger,
    strict: bool,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<Vec<NativeSourced<ChatMessage>>> {
    let Some(path) = native_path.filter(|path| !path.is_empty()) else {
        return Ok(Vec::new());
    };
    let loaded = async {
        let mut steps = EventLoopSteps::new("codex-history-load");
        let mut buckets = CodexMessageBuckets::default();
        let mut projection = LegacyCodexProjection::default();
        let options = JsonlLineReadOptions {
            signal: signal.cloned(),
            ..Default::default()
        };
        let mut entries = read_jsonl_line_entries(path, options);
        while let Some(entry) = entries.try_next().await? {
            add_codex_jsonl_line(
                &mut buckets,
                &entry.line,
                &CodexJsonlNormalizationContext {
                    source_byte_offset: Some(entry.byte_offset as f64),
                    source_line_number: entry.line_number.map(|line| line as f64),
                },
                &mut projection,
                strict,
            )?;
            if steps.due() {
                steps.next().await;
            }
        }
        let mut messages = buckets.canonical;
        if !buckets.has_canonical_user {
            messages.append(&mut buckets.fallback_user);
        }
        if !buckets.has_canonical_assistant {
            messages.append(&mut buckets.fallback_assistant);
        }
        if !buckets.has_canonical_thinking {
            messages.append(&mut buckets.fallback_thinking);
        }
        Ok::<_, Box<dyn std::error::Error>>(
            sort_codex_messages_by_source(messages, &mut steps).await,
        )
    }
    .await;
    match loaded {
        Err(error) => {
            if let Some(signal) = signal {
                check_aborted(signal)?;
            }
            if strict {
                return Err(error);
            }
            logger.error(
                "Codex transcript load failed",
                Some(&IndexMap::from([
                    ("nativePath".into(), Opaque::from_value(json!(path))),
                    ("error".into(), Opaque::from_value(json!(error.to_string()))),
                ])),
            );
            Ok(Vec::new())
        }
        loaded => loaded,
    }
}
