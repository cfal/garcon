//! Ports `common/git-name.ts`.

use garcon_js::utf16;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const GIT_NAME_DESCRIPTION_LIMIT: usize = 2_000;
pub const GIT_NAME_LIMIT: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateGitNameRequest {
    pub description: String,
    pub previous_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerateGitNameResponse {
    pub name: String,
}

pub fn is_generate_git_name_request(value: &Value) -> bool {
    value.as_object().is_some_and(|raw| {
        raw.keys()
            .all(|key| matches!(key.as_str(), "description" | "previousName"))
    }) && value["description"]
        .as_str()
        .is_some_and(|text| utf16::len(text) <= GIT_NAME_DESCRIPTION_LIMIT)
        && value["previousName"]
            .as_str()
            .is_some_and(|text| utf16::len(text) <= GIT_NAME_LIMIT)
}
