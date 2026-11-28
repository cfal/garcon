//! Ports `server-agents/opencode/src/agents/opencode/opencode-auth.ts`.

use garcon_contract::agent_execution::{AgentAuthSource, AgentAuthStatus};
use garcon_js::number_to_string;

// The runtime facts the status reads. Each method of the original's
// `OpenCodeAuthRuntime` is optional there, so an absent one is `None` here.
pub trait OpenCodeAuthRuntime {
    fn is_available(&self) -> Option<bool>;
    fn is_temporarily_unavailable(&self) -> Option<bool>;
    fn get_unavailable_retry_after_ms(&self) -> Option<f64>;
    fn get_unavailable_reason(&self) -> Option<String>;
}

pub fn get_open_code_auth_status(runtime: Option<&dyn OpenCodeAuthRuntime>) -> AgentAuthStatus {
    // A missing runtime or method is not available, as `!opencode?.isAvailable?.()` reads it.
    let Some(runtime) = runtime.filter(|runtime| runtime.is_available() == Some(true)) else {
        return AgentAuthStatus {
            authenticated: false,
            can_reauth: false,
            label: String::new(),
            source: AgentAuthSource::None,
            detail: None,
        };
    };
    if runtime.is_temporarily_unavailable() != Some(true) {
        return AgentAuthStatus {
            authenticated: true,
            can_reauth: false,
            label: "Installed".to_owned(),
            source: AgentAuthSource::Cli,
            detail: Some(
                "OpenCode manages provider authentication and models internally.".to_owned(),
            ),
        };
    }
    let retry_seconds = (runtime.get_unavailable_retry_after_ms().unwrap_or(0.0) / 1000.0).ceil();
    let reason = runtime
        .get_unavailable_reason()
        .filter(|reason| !reason.is_empty())
        .unwrap_or_else(|| "OpenCode did not respond in time.".to_owned());
    let detail = if retry_seconds > 0.0 {
        format!("{reason} Retrying in {}s.", number_to_string(retry_seconds))
    } else {
        reason
    };
    AgentAuthStatus {
        authenticated: false,
        can_reauth: false,
        label: "Unavailable".to_owned(),
        source: AgentAuthSource::Cli,
        detail: Some(detail),
    }
}
