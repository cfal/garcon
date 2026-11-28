//! Ports `server/remote/transport/git-protocol.ts`.

use garcon_contract::git_request_validation::{is_gh_method, is_git_method};
use garcon_js::{Number, json::Opaque};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCall {
    pub input: Opaque,
    pub budget_ms: Number,
}

pub fn is_git_rpc_method(method: &str) -> bool {
    method
        .strip_prefix("git.")
        .is_some_and(|method| is_git_method(&Value::String(method.to_owned())).is_some())
        || method
            .strip_prefix("gh.")
            .is_some_and(|method| is_gh_method(&Value::String(method.to_owned())).is_some())
}
