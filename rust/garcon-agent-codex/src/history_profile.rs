use std::sync::LazyLock;

use futures::TryStreamExt;
use garcon_agents_common::{
    jsonl::{JsonlLineResult, parse_first_jsonl_value},
    shared::history_loader_utils::{JsonlLineReadOptions, read_jsonl_line_entries},
};
use garcon_base::errors::{NamedError, error_metadata};
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    resources::ExecutorResult,
};
use garcon_js::{
    date_parse::date_parse,
    is_safe_integer,
    json::{Opaque, as_number},
    trim,
};
use regress::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

const MAX_SESSION_META_BYTES: u64 = 1024 * 1024;

pub struct CodexSessionIdentityInput<'a> {
    pub native_path: &'a str,
    pub expected_thread_id: Option<&'a str>,
    pub signal: &'a CancellationToken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSessionIdentity {
    pub thread_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHistoryBase {
    pub thread_id: String,
    pub end_ordinal_exclusive: u64,
    pub end_byte_offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "mode",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum CodexHistoryProfile {
    Legacy {
        native_path: String,
        #[serde(flatten)]
        identity: CodexSessionIdentity,
    },
    Paginated {
        native_path: String,
        #[serde(flatten)]
        identity: CodexSessionIdentity,
        history_base: Option<CodexHistoryBase>,
    },
}

struct CodexSessionMetadata {
    identity: CodexSessionIdentity,
    payload: Opaque,
}

pub async fn inspect_codex_session_identity(
    input: CodexSessionIdentityInput<'_>,
) -> ExecutorResult<CodexSessionIdentity> {
    Ok(inspect_codex_session_metadata(input).await?.identity)
}

pub async fn inspect_codex_session_model_provider(
    input: CodexSessionIdentityInput<'_>,
) -> ExecutorResult<Option<String>> {
    let metadata = inspect_codex_session_metadata(input).await?;
    let provider = &metadata.payload["model_provider"];
    if provider.is_null() {
        return Ok(None);
    }
    nonempty_string(provider)
        .map(|provider| Some(provider.into()))
        .ok_or_else(|| {
            transcript_unavailable(
                "Codex session metadata has an invalid model provider",
                "invalid-metadata",
                None,
            )
            .into()
        })
}

pub async fn inspect_codex_history_profile(
    input: CodexSessionIdentityInput<'_>,
) -> ExecutorResult<CodexHistoryProfile> {
    let native_path = input.native_path.to_owned();
    let CodexSessionMetadata { identity, payload } = inspect_codex_session_metadata(input).await?;
    let mode = match payload.get("history_mode") {
        None => "legacy",
        Some(mode) => mode.as_str().ok_or_else(|| {
            transcript_unavailable(
                "Codex session metadata has an invalid history mode",
                "invalid-metadata",
                None,
            )
        })?,
    };
    match mode {
        "legacy" => Ok(CodexHistoryProfile::Legacy {
            native_path,
            identity,
        }),
        "paginated" => Ok(CodexHistoryProfile::Paginated {
            native_path,
            identity,
            history_base: parse_history_base(&payload["history_base"])?,
        }),
        _ => Err(AgentIntegrationError::new(
            Code::OPERATION_UNSUPPORTED,
            format!("Codex history mode {mode} is not supported"),
            false,
            Some(Map::from_iter([
                ("operation".into(), json!("load-history")),
                ("historyMode".into(), json!(mode)),
                ("provider".into(), json!("codex")),
            ])),
        )
        .into()),
    }
}

async fn inspect_codex_session_metadata(
    input: CodexSessionIdentityInput<'_>,
) -> ExecutorResult<CodexSessionMetadata> {
    check_aborted(input.signal)?;
    let mut entries = read_jsonl_line_entries(
        input.native_path,
        JsonlLineReadOptions {
            complete_lines_only: true,
            max_line_bytes: Some(MAX_SESSION_META_BYTES),
            signal: Some(input.signal.clone()),
            ..Default::default()
        },
    );
    let first = async {
        if let Some(entry) = entries.try_next().await? {
            Ok::<_, Box<dyn std::error::Error>>((Some(entry.line), false))
        } else {
            Ok((
                None,
                tokio::fs::metadata(input.native_path).await?.len() == 0,
            ))
        }
    }
    .await;
    let (line, empty) = match first {
        Ok(value) => value,
        Err(error) => {
            check_aborted(input.signal)?;
            return Err(transcript_unavailable(
                "Codex session metadata is unavailable",
                "read-failed",
                error_metadata(error.as_ref()).code,
            )
            .into());
        }
    };
    let Some(line) = line else {
        return Err(transcript_unavailable(
            "Codex session metadata is unavailable",
            if empty {
                "empty-source"
            } else {
                "invalid-metadata"
            },
            None,
        )
        .into());
    };
    parse_session_metadata(&line, input.expected_thread_id).map_err(Into::into)
}

fn parse_session_metadata(
    line: &str,
    expected_id: Option<&str>,
) -> Result<CodexSessionMetadata, AgentIntegrationError> {
    let invalid = |message| transcript_unavailable(message, "invalid-metadata", None);
    let JsonlLineResult::Value { value, .. } = parse_first_jsonl_value(line) else {
        return Err(invalid("Codex session metadata is invalid"));
    };
    let payload = &value["payload"];
    if value["type"] != "session_meta" || !payload.is_object() {
        return Err(invalid(
            "Codex transcript does not start with session metadata",
        ));
    }
    let thread_id = nonempty_string(&payload["id"])
        .ok_or_else(|| invalid("Codex session metadata has no thread id"))?;
    if expected_id.is_some_and(|id| !id.is_empty() && id != thread_id) {
        return Err(transcript_unavailable(
            "Codex transcript belongs to a different thread",
            "thread-mismatch",
            None,
        ));
    }
    let created_at = rfc3339(&payload["timestamp"])
        .or_else(|| rfc3339(&value["timestamp"]))
        .ok_or_else(|| invalid("Codex session metadata has an invalid timestamp"))?;
    Ok(CodexSessionMetadata {
        identity: CodexSessionIdentity {
            thread_id: thread_id.into(),
            created_at: created_at.into(),
        },
        payload: Opaque::from_value(payload.clone()),
    })
}

fn parse_history_base(value: &Value) -> Result<Option<CodexHistoryBase>, AgentIntegrationError> {
    if value.is_null() {
        return Ok(None);
    }
    let number =
        |key| as_number(&value[key]).filter(|&value| is_safe_integer(value) && value >= 0.0);
    let (Some(thread_id), Some(end_ordinal_exclusive), Some(end_byte_offset)) = (
        nonempty_string(&value["thread_id"]),
        number("end_ordinal_exclusive"),
        number("end_byte_offset"),
    ) else {
        return Err(transcript_unavailable(
            "Codex session metadata has an invalid history base",
            "invalid-metadata",
            None,
        ));
    };
    Ok(Some(CodexHistoryBase {
        thread_id: thread_id.into(),
        end_ordinal_exclusive: end_ordinal_exclusive as u64,
        end_byte_offset: end_byte_offset as u64,
    }))
}

fn nonempty_string(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !trim(text).is_empty())
}

fn rfc3339(value: &Value) -> Option<&str> {
    static FORMAT: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::new(r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$")
            .expect("Codex RFC 3339 metadata shape")
    });
    let value = nonempty_string(value)?;
    FORMAT.find(value)?;
    date_parse(value).map(|_| value)
}

fn transcript_unavailable(
    message: &str,
    reason: &str,
    cause: Option<&str>,
) -> AgentIntegrationError {
    let mut details = Map::from_iter([
        ("operation".into(), json!("inspect-history")),
        ("provider".into(), json!("codex")),
        ("reason".into(), json!(reason)),
    ]);
    if let Some(code) = cause.filter(|code| !code.is_empty()) {
        details.insert("causeCode".into(), json!(code));
    }
    AgentIntegrationError::new(Code::TRANSCRIPT_UNAVAILABLE, message, false, Some(details))
}

pub(super) fn check_aborted(signal: &CancellationToken) -> ExecutorResult<()> {
    if signal.is_cancelled() {
        return Err(NamedError {
            name: "AbortError".into(),
            message: "The operation was aborted.".into(),
            code: None,
        }
        .into());
    }
    Ok(())
}
