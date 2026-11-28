use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Map;

pub type CodexConfigObject = Map<String, serde_json::Value>;

#[derive(Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderConfig {
    pub config: CodexConfigObject,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<IndexMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_catalog_path: Option<String>,
}
use std::fmt;

impl fmt::Debug for CodexProviderConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CodexProviderConfig")
            .field("model_catalog_path", &self.model_catalog_path)
            .finish_non_exhaustive()
    }
}
