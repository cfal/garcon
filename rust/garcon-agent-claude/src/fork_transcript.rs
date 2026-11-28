use std::rc::Rc;

use futures::FutureExt;
use garcon_agents_common::forking::{
    fork_jsonl::{
        ForkEntryRewrite, ForkTranscriptEntryContext, ForkTranscriptTransformInput,
        ForkTranscriptTransformResult, TransformEntries,
    },
    transcript_digest::OrderedTranscriptDigest,
};
use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::chat_types::ChatMessage;
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    native_message_source::NativeSourced,
    resources::ExecutorResult,
};
use garcon_js::{
    Clock, SystemClock,
    json::{self, Opaque},
    to_iso_string,
};
use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value, json};

use crate::{
    history_loader::{
        convert_claude_entries, convert_claude_entries_in_steps, sort_claude_entries_in_steps,
    },
    user_input::claude_steering_inputs_from_native_content,
};

const SOURCE_ONLY_FIELDS: [&str; 4] = ["teamName", "agentName", "slug", "sourceToolAssistantUUID"];
const TASK_ACTIVATION_FIELDS: [&str; 3] = ["backgroundTaskId", "outputTaskId", "agentId"];

fn strip_task_activation(entry: &mut Map<String, Value>) {
    let Some(result) = entry
        .get_mut("toolUseResult")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    // Resume cannot adopt source-owned task IDs. Monitor additionally needs a numeric timeout.
    let monitor = result.get("taskId").is_some_and(Value::is_string)
        && result.get("timeoutMs").is_some_and(Value::is_number);
    for field in TASK_ACTIVATION_FIELDS {
        result.shift_remove(field);
    }
    if monitor {
        result.shift_remove("taskId");
    }
}

pub fn project_claude_fork_entry(
    entry: &Opaque,
    context: &ForkTranscriptEntryContext,
) -> ExecutorResult<ForkEntryRewrite> {
    project_fork_entry(
        entry,
        context.retained_message_count.map(|count| count as f64),
    )
}

fn project_fork_entry(entry: &Opaque, retained: Option<f64>) -> ExecutorResult<ForkEntryRewrite> {
    let (Some(object), Some(retained)) = (entry.as_object(), retained) else {
        return Ok(ForkEntryRewrite::Unchanged);
    };
    let row_count = |entry: Opaque| {
        convert_claude_entries(&[NativeSourced::new(entry)]).map(|rows| rows.len() as f64)
    };
    if row_count(entry.clone())? <= retained {
        return Ok(ForkEntryRewrite::Unchanged);
    }
    if retained == 0.0 {
        let mut projected = object.clone();
        projected.insert("isMeta".into(), Value::Bool(true));
        return Ok(ForkEntryRewrite::Replace(Value::Object(projected).into()));
    }
    let Some(content) = entry["message"]["content"].as_array() else {
        return Err("Claude fork cutoff cannot split the selected provider entry".into());
    };
    let replace = |parts: Vec<Value>| {
        let mut projected = entry.as_value().clone();
        projected["message"]["content"] = Value::Array(parts);
        Opaque::from_value(projected)
    };
    if entry["message"]["role"] == "user" {
        if claude_steering_inputs_from_native_content(&entry["message"]["content"])
            .is_some_and(|inputs| retained <= inputs.len() as f64)
        {
            return Ok(ForkEntryRewrite::Replace(replace(
                content[..slice_end(retained, content.len())].to_vec(),
            )));
        }
        let results: Vec<_> = content
            .iter()
            .filter(|part| part["type"] == "tool_result")
            .collect();
        if retained <= results.len() as f64 {
            let end = slice_end(retained, results.len());
            return Ok(ForkEntryRewrite::Replace(replace(
                results.into_iter().take(end).cloned().collect(),
            )));
        }
    }
    if entry["message"]["role"] == "assistant" {
        for index in 1..=content.len() {
            let candidate = replace(content[..index].to_vec());
            if row_count(candidate.clone())? == retained {
                return Ok(ForkEntryRewrite::Replace(candidate));
            }
        }
    }
    Err("Claude fork cutoff cannot preserve the selected provider entry prefix".into())
}

fn slice_end(index: f64, length: usize) -> usize {
    let index = index.trunc();
    if index < 0.0 {
        length.saturating_sub((-index) as usize)
    } else {
        length.min(index as usize)
    }
}

pub fn create_claude_fork_transcript_transformer(
    new_id: Rc<dyn Fn() -> String>,
    clock: Rc<dyn Clock>,
) -> Rc<TransformEntries> {
    Rc::new(move |input| {
        let new_id = new_id.clone();
        let clock = clock.clone();
        async move { transform_entries(input, new_id.as_ref(), clock.as_ref()).await }.boxed_local()
    })
}

pub async fn transform_claude_fork_transcript(
    input: ForkTranscriptTransformInput,
) -> ExecutorResult<ForkTranscriptTransformResult> {
    transform_entries(input, &|| uuid::Uuid::new_v4().to_string(), &SystemClock).await
}

async fn transform_entries(
    input: ForkTranscriptTransformInput,
    new_id: &dyn Fn() -> String,
    clock: &dyn Clock,
) -> ExecutorResult<ForkTranscriptTransformResult> {
    let mut steps = EventLoopSteps::new("claude-fork-transform");
    let timestamp = to_iso_string(clock.now_ms())?;
    let mut transcript = Vec::new();
    steps
        .for_each(&input.selected_entries, |entry| {
            if let Some((uuid, record)) = transcript_entry(entry)
                && entry["isSidechain"] != true
            {
                transcript.push((uuid, record));
            }
        })
        .await;

    // The SDK resolves links over the full selection, including parents later in physical order.
    // https://github.com/anthropics/claude-agent-sdk-python/blob/f8b9ec923982082a02c485924e0f60367949c3a1/src/claude_agent_sdk/_internal/session_mutations.py#L385-L418
    let mut by_uuid = IndexMap::new();
    let mut uuid_map = IndexMap::new();
    steps
        .for_each(&transcript, |&(uuid, entry)| {
            by_uuid.insert(uuid, entry);
            uuid_map.insert(uuid, new_id());
        })
        .await;
    let mut entries = Vec::new();
    let mut allowed_counts = IndexMap::new();
    steps
        .try_for_each(&transcript, |&(uuid, entry)| -> ExecutorResult<()> {
            if entry.get("type").and_then(Value::as_str) == Some("progress") {
                return Ok(());
            }
            // INFALLIBLE: The preceding indexing pass assigns a target ID to every transcript UUID.
            let target_uuid = uuid_map.get(uuid).expect("indexed native UUID");
            let parent = remap_claude_parent(
                entry.get("parentUuid").and_then(Value::as_str),
                &by_uuid,
                &uuid_map,
            );
            let mut rewritten = entry.clone();
            rewritten.insert("uuid".into(), Value::String(target_uuid.clone()));
            rewritten.insert(
                "parentUuid".into(),
                parent.map_or(Value::Null, |uuid| Value::String(uuid.to_owned())),
            );
            rewritten.insert(
                "sessionId".into(),
                Value::String(input.target_agent_session_id.clone()),
            );
            rewritten.insert("isSidechain".into(), Value::Bool(false));
            rewritten.insert(
                "forkedFrom".into(),
                json!({
                    "sessionId":input.source_agent_session_id,
                    "messageUuid":uuid,
                }),
            );
            if let Some(id) = entry
                .get("logicalParentUuid")
                .and_then(Value::as_str)
                .and_then(|parent| uuid_map.get(parent))
            {
                rewritten.insert("logicalParentUuid".into(), Value::String(id.clone()));
            }
            if entry.get("session_id").and_then(Value::as_str)
                == Some(input.source_agent_session_id.as_str())
            {
                rewritten.insert(
                    "session_id".into(),
                    Value::String(input.target_agent_session_id.clone()),
                );
            }
            for key in SOURCE_ONLY_FIELDS {
                rewritten.shift_remove(key);
            }
            strip_task_activation(&mut rewritten);
            entries.push(Value::Object(rewritten));
            *allowed_counts.entry(target_uuid.as_str()).or_insert(0) += 1;
            Ok(())
        })
        .await?;
    if let Some(last) = entries.last_mut() {
        last["timestamp"] = Value::String(timestamp.clone());
    }

    let mut replacements = Vec::new();
    let mut source_uuids = IndexSet::new();
    steps
        .for_each(&input.source_entries, |entry| {
            if let Some((uuid, _)) = transcript_entry(entry) {
                source_uuids.insert(uuid);
            }
            if entry["type"] == "content-replacement"
                && entry["sessionId"] == input.source_agent_session_id
                && let Some(replacements_for_entry) = entry["replacements"].as_array()
            {
                replacements.extend(replacements_for_entry.iter().cloned());
            }
        })
        .await;
    if !replacements.is_empty() {
        entries.push(json!({
            "type":"content-replacement",
            "uuid":new_id(),
            "timestamp":timestamp,
            "sessionId":input.target_agent_session_id,
            "replacements":replacements,
        }));
    }
    assert_claude_fork_graph(
        &entries,
        &source_uuids,
        &input.target_agent_session_id,
        &allowed_counts,
        &mut steps,
    )
    .await?;
    let mut output = Vec::with_capacity(entries.len());
    let mut sourced = Vec::with_capacity(entries.len());
    steps
        .for_each(entries, |entry| {
            let entry = Opaque::from_value(entry);
            output.push(entry.clone());
            sourced.push(NativeSourced::new(entry));
        })
        .await;
    let sorted = sort_claude_entries_in_steps(sourced, &mut steps).await;
    let messages = convert_claude_entries_in_steps(&sorted, &mut steps).await?;
    let digest = semantic_digest(messages.iter().map(|row| &row.value), &mut steps).await?;
    Ok(ForkTranscriptTransformResult {
        entries: output,
        expected_semantic_digest: Some(digest),
    })
}

pub async fn claude_fork_semantic_digest(messages: &[ChatMessage]) -> ExecutorResult<String> {
    semantic_digest(messages, &mut EventLoopSteps::new("claude-fork-digest")).await
}

async fn semantic_digest<'a>(
    messages: impl IntoIterator<Item = &'a ChatMessage>,
    steps: &mut EventLoopSteps,
) -> ExecutorResult<String> {
    let mut digest = OrderedTranscriptDigest::default();
    steps
        .try_for_each(messages, |message| -> ExecutorResult<()> {
            let mut projected: Value = json::from_slice(&serde_json::to_vec(message)?)?;
            projected["timestamp"] = Value::String(String::new());
            if let ChatMessage::User(_) = message
                && let Some(fields) = projected.as_object_mut()
                && let Some(metadata) = fields.get_mut("metadata").and_then(Value::as_object_mut)
            {
                metadata.shift_remove("upstreamRequestId");
                if metadata.is_empty() {
                    fields.shift_remove("metadata");
                }
            }
            digest.add_serialized(&serde_json::to_vec(&Opaque::from_value(projected))?)?;
            Ok(())
        })
        .await?;
    Ok(digest.digest())
}

fn transcript_entry(entry: &Value) -> Option<(&str, &Map<String, Value>)> {
    let object = entry.as_object()?;
    matches!(
        entry["type"].as_str(),
        Some("user" | "assistant" | "attachment" | "system" | "progress")
    )
    .then_some(())?;
    Some((entry["uuid"].as_str()?, object))
}

fn remap_claude_parent<'a>(
    mut parent: Option<&'a str>,
    by_uuid: &IndexMap<&str, &'a Map<String, Value>>,
    uuid_map: &'a IndexMap<&str, String>,
) -> Option<&'a str> {
    let mut visited = IndexSet::new();
    while let Some(uuid) = parent.filter(|uuid| !uuid.is_empty() && visited.insert(*uuid)) {
        let entry = by_uuid.get(uuid)?;
        if entry.get("type").and_then(Value::as_str) != Some("progress") {
            return uuid_map.get(uuid).map(String::as_str);
        }
        parent = entry.get("parentUuid").and_then(Value::as_str);
    }
    None
}

async fn assert_claude_fork_graph(
    entries: &[Value],
    source_uuids: &IndexSet<&str>,
    target_id: &str,
    allowed_counts: &IndexMap<&str, u64>,
    steps: &mut EventLoopSteps,
) -> ExecutorResult<()> {
    let mut emitted = IndexSet::new();
    steps
        .for_each(entries, |entry| {
            if entry["type"] != "content-replacement"
                && let Some(uuid) = entry["uuid"].as_str()
            {
                emitted.insert(uuid);
            }
        })
        .await;
    let mut counts = IndexMap::<_, u64>::new();
    steps
        .try_for_each(entries, |entry| {
            if entry["type"] == "content-replacement" {
                return Ok(());
            }
            let identity_error =
                || unavailable("Claude fork did not create independent message identities");
            let uuid = entry["uuid"]
                .as_str()
                .filter(|id| !source_uuids.contains(*id))
                .ok_or_else(identity_error)?;
            let count = counts.entry(uuid).or_default();
            *count += 1;
            if *count > allowed_counts.get(uuid).copied().unwrap_or(1) {
                return Err(identity_error().into());
            }
            if entry["sessionId"] != target_id {
                return Err(
                    unavailable("Claude fork contains inconsistent session identity").into(),
                );
            }
            if !entry["parentUuid"].is_null()
                && !entry["parentUuid"]
                    .as_str()
                    .is_some_and(|parent| emitted.contains(parent))
            {
                return Err(unavailable("Claude fork contains an invalid parent graph").into());
            }
            Ok(())
        })
        .await
}

fn unavailable(message: &str) -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
        message,
        false,
        None,
    )
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use garcon_cases::{CaseError, javascript_number, replay, unknown};
    use garcon_js::{ManualClock, date_parse::date_parse};
    use serde::Serialize;
    use tokio::{fs, process::Command};

    use super::*;

    #[test]
    fn recorded_fork_entry_projections_match() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/fork-entry"),
            |function, args| {
                if function != "projectForkEntry" {
                    return Err(CaseError::unhandled(function));
                }
                let entry = Opaque::from_value(unknown(function, args.first())?.into_owned());
                let retained = javascript_number(function, args.get(1))?;
                match project_fork_entry(&entry, Some(retained)) {
                    Ok(ForkEntryRewrite::Unchanged) => Ok(entry.into_value()),
                    Ok(ForkEntryRewrite::Replace(value)) => Ok(value.into_value()),
                    Ok(ForkEntryRewrite::Undefined) => Ok(garcon_cases::markers::undefined()),
                    Err(error) => {
                        Ok(json!({"$":"error","name":"Error","message":error.to_string()}))
                    }
                }
            },
        );
    }

    #[tokio::test]
    async fn fork_graph_and_ordered_digest_match_the_original_on_the_same_selection() {
        let selected = [
            json!({
                "type":"assistant", "uuid":"child", "parentUuid":"progress", "logicalParentUuid":"root",
                "sessionId":"source", "session_id":"source", "teamName":"synthetic-team",
                "timestamp":"2026-07-21T14:00:01.000Z",
                "message":{"role":"assistant", "content":"synthetic child"},
            }),
            json!({"type":"progress", "uuid":"progress", "parentUuid":"root", "sessionId":"source"}),
            json!({
                "type":"user", "uuid":"root", "parentUuid":null, "sessionId":"source",
                "timestamp":"2026-07-21T14:00:00.000Z",
                "message":{"role":"user","content":"synthetic root"},
            }),
            json!({
                "type":"user", "uuid":"root", "parentUuid":null, "sessionId":"source",
                "timestamp":"2026-07-21T14:00:00.000Z",
                "message":{"role":"user","content":"synthetic root"},
            }),
            json!({"type":"assistant", "uuid":"sidechain", "parentUuid":"child", "sessionId":"source", "isSidechain":true}),
            json!({
                "type":"user", "uuid":"result", "parentUuid":"child", "sessionId":"source",
                "timestamp":"2026-07-21T14:00:05.000Z",
                "toolUseResult":{"taskId":"synthetic-monitor","timeoutMs":200,"backgroundTaskId":"source-job","agentId":"source-agent","exitCode":0},
                "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"synthetic-tool","content":"synthetic result"}]},
            }),
        ];
        let mut source = selected.to_vec();
        source.push(json!({
            "type":"content-replacement","sessionId":"source",
            "replacements":[{"messageId":"synthetic-cache-key","replacement":"generic replacement"}],
        }));
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("fork-input.json");
        fs::write(
            &path,
            serde_json::to_vec(&json!({
                "selectedEntries":selected,"sourceEntries":source,
                "sourceAgentSessionId":"source","targetAgentSessionId":"target",
            }))
            .unwrap(),
        )
        .await
        .unwrap();

        let next = Cell::new(0);
        let transform = create_claude_fork_transcript_transformer(
            Rc::new(move || {
                next.set(next.get() + 1);
                format!("synthetic-target-{}", next.get())
            }),
            Rc::new(ManualClock::new(
                date_parse("2026-07-21T14:00:30.000Z").unwrap(),
            )),
        );
        let result = transform(ForkTranscriptTransformInput {
            selected_entries: selected.into_iter().map(Opaque::from_value).collect(),
            source_entries: source.into_iter().map(Opaque::from_value).collect(),
            source_agent_session_id: "source".into(),
            target_agent_session_id: "target".into(),
        })
        .await
        .unwrap();
        assert_eq!(result.entries.len(), 5);
        assert_eq!(result.entries[0]["parentUuid"], result.entries[1]["uuid"]);
        assert_eq!(result.entries[1]["uuid"], result.entries[2]["uuid"]);
        assert_eq!(result.entries[3]["toolUseResult"].get("taskId"), None);
        let original = Command::new("bun")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/oracles/fork-transcript.ts"
            ))
            .arg(path)
            .output()
            .await
            .unwrap();
        assert!(
            original.status.success(),
            "{}",
            String::from_utf8_lossy(&original.stderr)
        );
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Output<'a> {
            entries: &'a [Opaque],
            expected_semantic_digest: &'a str,
        }
        let actual = serde_json::to_string(&Output {
            entries: &result.entries,
            expected_semantic_digest: result.expected_semantic_digest.as_deref().unwrap(),
        })
        .unwrap();
        assert_eq!(actual, String::from_utf8(original.stdout).unwrap());
    }
}
