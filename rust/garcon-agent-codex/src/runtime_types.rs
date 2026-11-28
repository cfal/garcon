use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Map;

pub type CodexConfigObject = Map<String, serde_json::Value>;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProviderConfig {
    pub config: CodexConfigObject,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<IndexMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_catalog_path: Option<String>,
}
