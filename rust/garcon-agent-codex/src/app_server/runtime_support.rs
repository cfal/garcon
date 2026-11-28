use std::{error::Error, sync::LazyLock, time::Duration};

use garcon_base::errors::error_metadata;
use indexmap::IndexMap;
use regress::Regex;
use serde_json::{Value, json};

use crate::user_input::CODEX_USER_INPUT_METHOD;

use super::{
    cli::CODEX_CLI_NOT_FOUND,
    client::CodexAppServerRpcError,
    runtime_session_state::{FinishSessionOptions, RunningStatus},
};

pub const MAX_CAPACITY_RETRIES: usize = 3;
pub const CAPACITY_RETRY_DELAYS: [Duration; MAX_CAPACITY_RETRIES] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
];

pub struct NoopLogger;

impl garcon_interface::host::AgentLogger for NoopLogger {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, garcon_js::json::Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, garcon_js::json::Opaque>>) {}
    fn warn(&self, _: &str, _: Option<&IndexMap<String, garcon_js::json::Opaque>>) {}
    fn error(&self, _: &str, _: Option<&IndexMap<String, garcon_js::json::Opaque>>) {}
}

pub fn denial_response_for_request(method: &str, params: Option<&Value>) -> Value {
    match method {
        CODEX_USER_INPUT_METHOD => json!({"answers": {}}),
        "item/commandExecution/requestApproval"
            if params.and_then(|params| params["kind"].as_str()) == Some("writeStdin") =>
        {
            json!({"decision": "cancel"})
        }
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval" => {
            json!({"decision": "decline"})
        }
        "item/permissions/requestApproval" => json!({"permissions": {}, "scope": "turn"}),
        _ => json!({"decision": "denied"}),
    }
}

pub fn humanize_codex_app_server_error(error: &(dyn Error + 'static)) -> String {
    let mut raw = error.to_string();
    if raw.is_empty() {
        raw = error_metadata(error).name.to_owned();
    }
    if let Some(rpc) = error.downcast_ref::<CodexAppServerRpcError>()
        && matches!(
            rpc.data.as_ref().and_then(|data| data["type"].as_str()),
            Some(
                "modelProviderMismatch"
                    | "modelProviderNotConfigured"
                    | "modelProviderPolicyConflict"
            )
        )
    {
        return format!("Codex error: {raw}");
    }
    static CLASSIFICATIONS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
        [
            (
                r"executable not found|spawn.*ENOENT|ENOENT.*(?:spawn|codex)",
                CODEX_CLI_NOT_FOUND,
            ),
            (
                r"authentication|unauthorized|401|api.?key",
                "Codex authentication failed. Run \"codex\" in your terminal to sign in.",
            ),
            (
                r"rate.?limit|429",
                "Codex rate limit exceeded. Please wait a moment and try again.",
            ),
            (
                r"model.*not.?found|invalid.*model|does not exist",
                "Codex model not available. Check your model selection or Codex configuration.",
            ),
            (
                r"ECONNREFUSED|ENOTFOUND|network|timeout|ETIMEDOUT",
                "Codex could not connect to the API. Check your network connection.",
            ),
        ]
        .into_iter()
        // INFALLIBLE: The fixed ECMAScript expressions are valid.
        .map(|(pattern, description)| {
            (
                Regex::with_flags(pattern, "i").expect("Codex error pattern"),
                description,
            )
        })
        .collect()
    });
    for (pattern, description) in CLASSIFICATIONS.iter() {
        if pattern.find(&raw).is_some() {
            return (*description).into();
        }
    }
    format!("Codex error: {raw}")
}

pub fn is_utility_overload(error: &(dyn Error + 'static)) -> bool {
    static OVERLOADED: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::with_flags("overloaded", "i").expect("Codex overload pattern")
    });
    error
        .downcast_ref::<CodexAppServerRpcError>()
        .is_some_and(|rpc| rpc.code.0 == -32001.0)
        || OVERLOADED.find(&error.to_string()).is_some()
}

pub fn is_capacity_error(error: Option<&Value>) -> bool {
    static AT_CAPACITY: LazyLock<Regex> = LazyLock::new(|| {
        // INFALLIBLE: The fixed ECMAScript expression is valid.
        Regex::with_flags("selected model is at capacity", "i").expect("Codex capacity pattern")
    });
    error.is_some_and(|error| {
        error["codexErrorInfo"] == "serverOverloaded"
            || error["message"]
                .as_str()
                .is_some_and(|message| AT_CAPACITY.find(message).is_some())
    })
}

pub fn merge_finish_options(
    current: Option<FinishSessionOptions>,
    next: FinishSessionOptions,
) -> FinishSessionOptions {
    let current = current.unwrap_or_default();
    FinishSessionOptions {
        failed_message: next.failed_message.or(current.failed_message),
        aborted: next.aborted || current.aborted,
        emit_finished_on_abort: next.emit_finished_on_abort || current.emit_finished_on_abort,
    }
}

pub fn has_terminal_pending_finish(options: Option<&FinishSessionOptions>) -> bool {
    options.is_some_and(|options| {
        options.aborted
            || options
                .failed_message
                .as_ref()
                .is_some_and(|message| !message.is_empty())
    })
}

pub fn is_terminal_session_status(status: RunningStatus) -> bool {
    matches!(
        status,
        RunningStatus::Completed | RunningStatus::Failed | RunningStatus::Aborted
    )
}

pub fn is_active_session_status(status: RunningStatus) -> bool {
    matches!(
        status,
        RunningStatus::Running | RunningStatus::Interrupting | RunningStatus::Completing
    )
}
