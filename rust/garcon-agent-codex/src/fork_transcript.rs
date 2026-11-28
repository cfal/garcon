use std::{cell::RefCell, rc::Rc};

use garcon_agents_common::forking::fork_jsonl::{
    ForkEntryRewrite, ForkTranscriptEntryContext, RewriteEntry,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::json::Opaque;
use serde_json::{Value, json};

use crate::{
    code_mode_command_projection::{
        project_codex_code_mode_commands, rewrite_codex_code_mode_command_prefix,
    },
    history_normalizer::CodexJsonlNormalizationContext,
    legacy_history_projection::LegacyCodexProjection,
};

pub fn rewrite_codex_fork_transcript_entry(
    entry: &Opaque,
    context: &ForkTranscriptEntryContext,
) -> ExecutorResult<ForkEntryRewrite> {
    rewrite_codex_fork_entry(entry, context, &mut LegacyCodexProjection::default())
}

pub fn create_codex_fork_transcript_rewriter() -> Rc<RewriteEntry> {
    let projection = RefCell::new(LegacyCodexProjection::default());
    Rc::new(move |entry, context| {
        rewrite_codex_fork_entry(entry, context, &mut projection.borrow_mut())
    })
}

fn rewrite_codex_fork_entry(
    entry: &Opaque,
    context: &ForkTranscriptEntryContext,
    projection: &mut LegacyCodexProjection,
) -> ExecutorResult<ForkEntryRewrite> {
    if !entry.is_object() {
        return Ok(ForkEntryRewrite::Unchanged);
    }
    if let Some(retained) = context.retained_message_count {
        let result = projection.project(entry, &CodexJsonlNormalizationContext::default())?;
        let emitted = result.as_ref().map_or(0, |result| {
            result.canonical.len()
                + result.fallback_user.len()
                + result.fallback_assistant.len()
                + result.fallback_thinking.len()
        });
        if emitted as u64 > retained {
            if retained == 0 {
                return Ok(ForkEntryRewrite::Replace(Opaque::from_value(
                    json!({"type":"garcon_fork_filtered"}),
                )));
            }
            if let Some(prefix) = rewrite_code_mode_prefix(entry, retained as usize) {
                return Ok(ForkEntryRewrite::Replace(prefix));
            }
            if retained == 1
                && entry["type"] == "response_item"
                && entry["payload"]["type"] == "web_search_call"
            {
                let mut replaced = entry.as_value().clone();
                replaced["payload"]["status"] = Value::String("in_progress".into());
                return Ok(ForkEntryRewrite::Replace(Opaque::from_value(replaced)));
            }
            return Err(
                "Codex fork cutoff cannot preserve the selected provider entry prefix".into(),
            );
        }
    }
    if entry["type"] != "session_meta" || !entry["payload"].is_object() {
        return Ok(ForkEntryRewrite::Unchanged);
    }
    let mut replaced = entry.as_value().clone();
    let mut changed = false;
    for key in ["id", "session_id"] {
        if entry["payload"][key] == context.source_agent_session_id {
            replaced["payload"][key] = Value::String(context.target_agent_session_id.clone());
            changed = true;
        }
    }
    Ok(if changed {
        ForkEntryRewrite::Replace(Opaque::from_value(replaced))
    } else {
        ForkEntryRewrite::Unchanged
    })
}

fn rewrite_code_mode_prefix(entry: &Opaque, retained: usize) -> Option<Opaque> {
    let payload = &entry["payload"];
    if entry["type"] != "response_item"
        || payload["type"] != "custom_tool_call"
        || payload["name"] != "exec"
    {
        return None;
    }
    let projection = project_codex_code_mode_commands(payload["input"].as_str()?)?;
    if retained >= projection.commands.len() {
        return None;
    }
    let mut replaced = entry.as_value().clone();
    replaced["payload"]["input"] = Value::String(rewrite_codex_code_mode_command_prefix(
        &projection.commands[..retained],
    ));
    Some(Opaque::from_value(replaced))
}
