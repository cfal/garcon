//! Ports `auth.test.js`.

use crate::support::message_value;
use garcon_agent_opencode::agents::opencode::opencode_auth::{
    OpenCodeAuthRuntime, get_open_code_auth_status,
};
use garcon_contract::agent_execution::{AgentAuthSource, AgentAuthStatus};

// The runtime facts the original's test objects name. A fact the object
// leaves out is a missing method, as in the original.
struct Runtime<'a> {
    is_available: Option<&'a dyn Fn() -> bool>,
    is_temporarily_unavailable: Option<&'a dyn Fn() -> bool>,
    retry_after_ms: Option<&'a dyn Fn() -> f64>,
    reason: Option<&'a dyn Fn() -> String>,
}

impl OpenCodeAuthRuntime for Runtime<'_> {
    fn is_available(&self) -> Option<bool> {
        self.is_available.map(|fact| fact())
    }

    fn is_temporarily_unavailable(&self) -> Option<bool> {
        self.is_temporarily_unavailable.map(|fact| fact())
    }

    fn get_unavailable_retry_after_ms(&self) -> Option<f64> {
        self.retry_after_ms.map(|fact| fact())
    }

    fn get_unavailable_reason(&self) -> Option<String> {
        self.reason.map(|fact| fact())
    }
}

fn status(runtime: Option<&dyn OpenCodeAuthRuntime>) -> serde_json::Value {
    message_value(&get_open_code_auth_status(runtime))
}

#[test]
fn treats_binary_availability_as_readiness_without_starting_opencode() {
    // The original's runtime object also carries a `getClient` that throws:
    // the status is read from the binary's presence alone.
    let available = true;
    let runtime = Runtime {
        is_available: Some(&|| available),
        is_temporarily_unavailable: None,
        retry_after_ms: None,
        reason: None,
    };
    assert_eq!(
        status(Some(&runtime)),
        serde_json::json!({
            "authenticated": true,
            "canReauth": false,
            "label": "Installed",
            "source": "cli",
            "detail": "OpenCode manages provider authentication and models internally.",
        })
    );
}

#[test]
fn reports_unavailable_when_the_binary_is_missing() {
    let missing = false;
    let runtime = Runtime {
        is_available: Some(&|| missing),
        is_temporarily_unavailable: None,
        retry_after_ms: None,
        reason: None,
    };
    assert_eq!(
        status(Some(&runtime)),
        serde_json::json!({
            "authenticated": false,
            "canReauth": false,
            "label": "",
            "source": "none",
        })
    );
    // A runtime that does not even name the fact, or none at all, reads the same.
    let bare = Runtime {
        is_available: None,
        is_temporarily_unavailable: None,
        retry_after_ms: None,
        reason: None,
    };
    let expected = message_value(&AgentAuthStatus {
        authenticated: false,
        can_reauth: false,
        label: String::new(),
        source: AgentAuthSource::None,
        detail: None,
    });
    assert_eq!(status(Some(&bare)), expected);
    assert_eq!(status(None), expected);
}

#[test]
fn reports_temporary_unavailability_during_the_opencode_cooldown_window() {
    let runtime = Runtime {
        is_available: Some(&|| true),
        is_temporarily_unavailable: Some(&|| true),
        retry_after_ms: Some(&|| 42_000.0),
        reason: Some(&|| "OpenCode startup timed out after 5000ms".to_owned()),
    };
    assert_eq!(
        status(Some(&runtime)),
        serde_json::json!({
            "authenticated": false,
            "canReauth": false,
            "label": "Unavailable",
            "source": "cli",
            "detail": "OpenCode startup timed out after 5000ms Retrying in 42s.",
        })
    );
}
