//! Ports `server-agents/common/src/search/rows.ts`.

use garcon_contract::chat_search::ChatSearchSnippetRole;
use serde::{Deserialize, Serialize};

pub const SEARCH_TIMESTAMP_MAX_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchMessageRowInput {
    pub role: ChatSearchSnippetRole,
    pub timestamp: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoricalSearchMessageRow {
    pub ordinal: u64,
    #[serde(flatten)]
    pub row: SearchMessageRowInput,
}
