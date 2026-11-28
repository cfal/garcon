use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    host::AgentLogger,
    resources::ExecutorResult,
};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use crate::history_profile::{
    CodexSessionIdentityInput, check_aborted, inspect_codex_session_identity,
};

pub async fn resolve_codex_native_path<F>(
    agent_session_id: Option<&str>,
    native_path: Option<&str>,
    discover: impl FnOnce() -> F,
    logger: &dyn AgentLogger,
    signal: &CancellationToken,
) -> ExecutorResult<Option<String>>
where
    F: Future<Output = ExecutorResult<Option<String>>>,
{
    check_aborted(signal)?;
    let Some(agent_session_id) = agent_session_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    if let Some(path) = native_path.filter(|path| !path.is_empty())
        && matches_codex_session(path, agent_session_id, "stored", logger, signal).await?
    {
        return Ok(Some(path.into()));
    }

    let discovered = match discover().await {
        Ok(path) => path,
        Err(error) => {
            check_aborted(signal)?;
            logger.warn(
                "Codex transcript discovery failed",
                Some(&fields([
                    ("agentSessionId", json!(agent_session_id)),
                    ("error", json!(error.to_string())),
                ])),
            );
            return Err(AgentIntegrationError::new(
                Code::UNAVAILABLE,
                "Codex transcript discovery is temporarily unavailable",
                true,
                Some(Map::from_iter([
                    ("provider".into(), json!("codex")),
                    ("agentSessionId".into(), json!(agent_session_id)),
                    ("reason".into(), json!("discovery-error")),
                ])),
            )
            .into());
        }
    };
    check_aborted(signal)?;
    let Some(path) = discovered.filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    Ok(
        matches_codex_session(&path, agent_session_id, "app-server", logger, signal)
            .await?
            .then_some(path),
    )
}

async fn matches_codex_session(
    native_path: &str,
    agent_session_id: &str,
    source: &str,
    logger: &dyn AgentLogger,
    signal: &CancellationToken,
) -> ExecutorResult<bool> {
    let Err(error) = inspect_codex_session_identity(CodexSessionIdentityInput {
        native_path,
        expected_thread_id: Some(agent_session_id),
        signal,
    })
    .await
    else {
        return Ok(true);
    };
    check_aborted(signal)?;
    let Some(typed) = error
        .downcast_ref::<AgentIntegrationError>()
        .filter(|error| error.code == Code::TRANSCRIPT_UNAVAILABLE)
    else {
        return Err(error);
    };
    let detail = |field| {
        typed
            .details
            .as_ref()
            .and_then(|details| details[field].as_str())
    };
    let reason = detail("reason").unwrap_or("invalid-metadata");
    let cause = detail("causeCode");
    let mut logged = fields([
        ("agentSessionId", json!(agent_session_id)),
        ("nativePath", json!(native_path)),
        ("resolutionSource", json!(source)),
        ("reason", json!(reason)),
    ]);
    if reason == "read-failed" && cause != Some("ENOENT") {
        logged.insert("causeCode".into(), Opaque::from_value(json!(cause)));
        logged.insert("error".into(), Opaque::from_value(json!(typed.message)));
        logger.warn(
            "Codex transcript path could not be validated",
            Some(&logged),
        );
        let mut details = Map::from_iter([
            ("provider".into(), json!("codex")),
            ("agentSessionId".into(), json!(agent_session_id)),
            ("nativePath".into(), json!(native_path)),
            ("reason".into(), json!("path-read-error")),
        ]);
        if let Some(cause) = cause.filter(|cause| !cause.is_empty()) {
            details.insert("causeCode".into(), json!(cause));
        }
        return Err(AgentIntegrationError::new(
            Code::UNAVAILABLE,
            "Codex transcript path is temporarily unavailable",
            true,
            Some(details),
        )
        .into());
    }
    if let Some(cause) = cause.filter(|cause| !cause.is_empty()) {
        logged.insert("causeCode".into(), Opaque::from_value(json!(cause)));
    }
    logger.warn(
        if source == "stored" {
            "Codex stored transcript path is unavailable"
        } else {
            "Codex discovered transcript path was rejected"
        },
        Some(&logged),
    );
    if reason == "read-failed" && cause == Some("ENOENT") {
        Ok(false)
    } else {
        Err(error)
    }
}

fn fields<const N: usize>(fields: [(&str, Value); N]) -> IndexMap<String, Opaque> {
    fields
        .into_iter()
        .map(|(key, value)| (key.into(), Opaque::from_value(value)))
        .collect()
}
