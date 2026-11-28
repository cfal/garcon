use garcon_agent_codex::{
    fork_target_path::create_codex_fork_target_path,
    fork_transcript::{create_codex_fork_transcript_rewriter, rewrite_codex_fork_transcript_entry},
};
use garcon_agents_common::forking::fork_jsonl::{
    ForkEntryRewrite, ForkJsonlTargetPathInput, ForkTranscriptEntryContext,
};
use garcon_base::errors::error_metadata;
use garcon_cases::{CaseError, replay, text, unknown};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{
    date_parse::date_parse,
    json::{Opaque, as_number},
};
use serde_json::{Value, json};

#[test]
fn fork_target_paths_match_bun_date_and_path_rules() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/fork-target-path"),
        |function, args| {
            if function != "createCodexForkTargetPath" {
                return Err(CaseError::unhandled(function));
            }
            let arg = &args[0];
            Ok(outcome(
                create_codex_fork_target_path(ForkJsonlTargetPathInput {
                    source_path: text(function, Some(&arg["sourcePath"]))?.unwrap().into(),
                    target_agent_session_id: text(function, Some(&arg["targetAgentSessionId"]))?
                        .unwrap()
                        .into(),
                    created_at_ms: arg["createdAt"]["value"]
                        .as_str()
                        .and_then(date_parse)
                        .unwrap_or(i64::MAX),
                })
                .map(Value::String),
            ))
        },
    );
}

#[test]
fn rollout_fork_entry_rewrites_match_bun() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/fork-transcript"),
        |function, args| {
            if function != "rewriteCodexForkTranscriptEntry" {
                return Err(CaseError::unhandled(function));
            }
            let entry = Opaque::from_value(unknown(function, args.first())?.into_owned());
            let context = unknown(function, args.get(1))?;
            Ok(outcome(
                rewrite_codex_fork_transcript_entry(&entry, &fork_context(&context))
                    .map(|result| value_for_rewrite(result, entry)),
            ))
        },
    );
}

#[test]
fn stateful_fork_rewrites_preserve_selected_message_prefixes() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/fork-transcript-sequence"
        ),
        |function, args| {
            if function != "rewriteCodexForkTranscriptSequence" {
                return Err(CaseError::unhandled(function));
            }
            let items = unknown(function, args.first())?;
            let rewrite = create_codex_fork_transcript_rewriter();
            let rewritten = items
                .as_array()
                .unwrap()
                .iter()
                .map(|item| {
                    let entry = Opaque::from_value(item[0].clone());
                    rewrite(&entry, &fork_context(&item[1]))
                        .map(|result| value_for_rewrite(result, entry))
                })
                .collect::<ExecutorResult<Vec<_>>>();
            Ok(outcome(rewritten.map(Value::Array)))
        },
    );
}

fn fork_context(value: &Value) -> ForkTranscriptEntryContext {
    ForkTranscriptEntryContext {
        source_agent_session_id: value["sourceAgentSessionId"].as_str().unwrap().into(),
        target_agent_session_id: value["targetAgentSessionId"].as_str().unwrap().into(),
        retained_message_count: as_number(&value["retainedMessageCount"]).map(|value| value as u64),
    }
}

fn value_for_rewrite(rewrite: ForkEntryRewrite, entry: Opaque) -> Value {
    match rewrite {
        ForkEntryRewrite::Unchanged => entry.into_value(),
        ForkEntryRewrite::Replace(value) => value.into_value(),
        ForkEntryRewrite::Undefined => panic!("Codex does not drop the native entry"),
    }
}

fn outcome(result: ExecutorResult<Value>) -> Value {
    result.unwrap_or_else(|error| json!({"$":"error", "name":error_metadata(error.as_ref()).name, "message":error.to_string(), "properties":{}}))
}
