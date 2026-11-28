use std::rc::Rc;

use garcon_agents_common::native_session::{
    jsonl_activity::{
        JsonlNativeActivityProbe, JsonlNativeActivityProbeOptions,
        create_jsonl_native_activity_probe,
    },
    path_native_session::PathNativeSessionCodec,
};
use garcon_base::errors::NamedError;
use garcon_js::OptionalNullable;

use crate::history_normalizer::{CodexJsonlNormalizationContext, normalize_codex_jsonl_entry};

pub fn create_codex_native_activity_probe(
    native_sessions: Rc<PathNativeSessionCodec>,
) -> Result<JsonlNativeActivityProbe, NamedError> {
    create_jsonl_native_activity_probe(JsonlNativeActivityProbeOptions {
        native_sessions,
        max_tail_bytes: None,
        activity_timestamp: Rc::new(|entry| {
            let normalized =
                normalize_codex_jsonl_entry(entry, &CodexJsonlNormalizationContext::default())?;
            let has_messages = normalized.is_some_and(|row| {
                !row.canonical.is_empty()
                    || !row.fallback_user.is_empty()
                    || !row.fallback_assistant.is_empty()
                    || !row.fallback_thinking.is_empty()
            });
            if !has_messages {
                return Ok(OptionalNullable::ABSENT);
            }
            Ok(entry["timestamp"]
                .as_str()
                .map_or(OptionalNullable::NULL, |value| {
                    OptionalNullable::some(value.into())
                }))
        }),
    })
}
