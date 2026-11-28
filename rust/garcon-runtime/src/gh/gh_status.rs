//! Ports `server/runtime/gh/gh-status.ts`.

use garcon_base::errors::ErrorInput;
use garcon_contract::gh::{GhAvailabilityReason as Reason, GhStatusResponse};
use serde_json::Value;

use super::gh_error_classifier::classify_gh_error;

fn unavailable(reason: Reason) -> GhStatusResponse {
    GhStatusResponse {
        available: false,
        authenticated: false,
        reason,
        host: None,
        login: None,
    }
}

pub fn derive_gh_status(raw: &Value, error: Option<ErrorInput<'_>>) -> GhStatusResponse {
    if let Some(error) = error {
        return unavailable(match classify_gh_error(error).code {
            "GH_MISSING" => Reason::GhMissing,
            "AUTH_FAILED" => Reason::Unauthenticated,
            _ => Reason::Unknown,
        });
    }
    let Some(hosts) = raw["hosts"].as_object() else {
        return unavailable(Reason::Unauthenticated);
    };
    let mut auth_error = false;
    let mut names: Vec<_> = hosts.keys().cloned().collect();
    garcon_js::sort_object_keys(&mut names);
    for host in names {
        if let Some(accounts) = hosts[&host].as_array() {
            for account in accounts {
                if account["active"] == true && account["state"] == "success" {
                    return GhStatusResponse {
                        available: true,
                        authenticated: true,
                        reason: Reason::Authenticated,
                        host: Some(host),
                        login: account["login"]
                            .as_str()
                            .filter(|login| !login.is_empty())
                            .map(str::to_owned),
                    };
                }
                auth_error |= account["state"] == "error";
            }
        }
    }
    unavailable(if auth_error {
        Reason::AuthError
    } else {
        Reason::Unauthenticated
    })
}
